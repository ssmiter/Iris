using Microsoft.Extensions.DependencyInjection;
using System.Reflection;
using System.Text.Json.Nodes;
using AIGateway.Models;
using AIGateway.Providers;
using AIGateway.Tools;

namespace AIGateway.Services;

/// <summary>
/// 能力发现服务：将后端注册的工具原语暴露为前端可消费的 ToolCatalogItem 目录。
/// 优先读取 <see cref="ToolCatalogMetadataAttribute"/u003e，不存在时回退到命名约定推断。
/// </summary>
public class CapabilityService
{
    private readonly ToolRegistry _toolRegistry;
    private readonly ProviderFactory _providerFactory;
    private readonly IConfiguration _configuration;
    private readonly IServiceProvider _serviceProvider;
    private readonly ILogger<CapabilityService> _logger;

    private const int DefaultMaxResultSizeChars = 15000;

    public CapabilityService(
        ToolRegistry toolRegistry,
        ProviderFactory providerFactory,
        IConfiguration configuration,
        IServiceProvider serviceProvider,
        ILogger<CapabilityService> logger)
    {
        _toolRegistry = toolRegistry;
        _providerFactory = providerFactory;
        _configuration = configuration;
        _serviceProvider = serviceProvider;
        _logger = logger;
    }

    /// <summary>
    /// 获取当前用户可见的能力目录。
    /// </summary>
    public CapabilitiesResponse GetCapabilities(string language = "zh", string? systemCode = null)
    {
        systemCode ??= "ykhm";

        // Local 模式仅实例化属于 demo / local / code 域的工具，避免把 100+ MES 工具全部实例化导致超时。
        List<ITool> tools;
        if (systemCode.Equals("local", StringComparison.OrdinalIgnoreCase))
        {
            tools = GetLocalDemoTools();
        }
        else
        {
            tools = FilterBySystem(_toolRegistry.GetAllTools(), systemCode).ToList();
        }

        // Online 默认启用 Deferred 加载（与前端 Agent Loop 配套）：DomainOperation/Workflow/Admin 走按需发现，
        // 由 list_capabilities/read_capability/tool_search 原语按需注入上下文，避免首轮把 100+ MES 工具全量塞进模型。
        // Primitive 仍 AlwaysLoad（见 InferLoadStrategy）。显式回退：AIGateway:Features:OnlineDeferredLoading = false。
        var onlineDeferredEnabled = _configuration.GetValue<bool?>("AIGateway:Features:OnlineDeferredLoading") != false
            && !systemCode.Equals("local", StringComparison.OrdinalIgnoreCase);

        var catalogItems = tools.Select(t => BuildCatalogItem(t, language, onlineDeferredEnabled)).ToList();
        EnsureUniquePaths(catalogItems);

        return new CapabilitiesResponse
        {
            Tools = catalogItems,
            DomainTools = catalogItems.Where(t => t.Tier == ToolTier.DomainOperation).ToList(),
            PrimitiveTools = catalogItems.Where(t => t.Tier == ToolTier.Primitive).ToList(),
            AdminTools = catalogItems.Where(t => t.Tier == ToolTier.Admin).ToList(),
            WorkflowTools = catalogItems.Where(t => t.Tier == ToolTier.Workflow).ToList(),
            Features = BuildFeatures(),
            Version = GetVersion(),
            SystemCode = systemCode,
            TotalToolCount = catalogItems.Count,
            DomainInsight = BuildDomainInsight(systemCode, catalogItems)
        };
    }

    private List<ITool> GetLocalDemoTools()
    {
        var demoTypes = _toolRegistry.GetAllToolTypes()
            .Where(DomainCatalog.IsLocalToolType)
            .ToList();

        var tools = new List<ITool>();
        foreach (var type in demoTypes)
        {
            try
            {
                var tool = (ITool?)ActivatorUtilities.CreateInstance(_serviceProvider, type);
                if (tool != null)
                    tools.Add(tool);
            }
            catch (Exception ex)
            {
                _logger.LogWarning(ex, "Failed to instantiate local demo tool: {ToolType}", type.Name);
            }
        }

        return tools;
    }

    /// <summary>
    /// 解析单个工具的元数据（attribute 优先，约定推断回退）。
    /// </summary>
    public ToolCatalogItem GetToolMetadata(ITool tool, string language = "zh")
    {
        return BuildCatalogItem(tool, language);
    }

    /// <summary>
    /// 按关键词搜索工具，返回轻量结果（不含完整 schema），供 tool_search 原语使用。
    /// </summary>
    public ToolSearchResponse SearchTools(ToolSearchRequest request, string language = "zh")
    {
        var query = request.Query?.Trim() ?? string.Empty;
        var terms = query.Split(new[] { ' ', '　', '_', '-' }, StringSplitOptions.RemoveEmptyEntries)
                         .Select(t => t.Trim().ToLowerInvariant())
                         .Where(t => t.Length > 0)
                         .ToList();

        List<ITool> sourceTools;
        if (request.SystemCode?.Equals("local", StringComparison.OrdinalIgnoreCase) == true)
        {
            sourceTools = GetLocalDemoTools();
        }
        else
        {
            sourceTools = FilterBySystem(_toolRegistry.GetAllTools(), request.SystemCode ?? "ykhm").ToList();
        }

        var all = sourceTools
            .Select(t => BuildCatalogItem(t, language))
            .Where(t => string.IsNullOrEmpty(request.Category)
                         || string.Equals(t.Category, request.Category, StringComparison.OrdinalIgnoreCase))
            .Where(t => request.IncludeTiers == null
                         || request.IncludeTiers.Count == 0
                         || (t.Tier != null && request.IncludeTiers.Contains(t.Tier.Value)))
            .ToList();
        EnsureUniquePaths(all);

        var results = string.IsNullOrWhiteSpace(query)
            ? all
            : all.Where(t => MatchesTerms(t, terms)).ToList();

        var limit = request.Limit is > 0 ? request.Limit.Value : 20;

        return new ToolSearchResponse
        {
            Total = results.Count,
            Query = query,
            Tools = results
                .OrderByDescending(t => t.Tier == ToolTier.DomainOperation)
                .ThenBy(t => t.Name)
                .Take(limit)
                .Select(t => new ToolSearchResultItem
                {
                    Name = t.Name,
                    Description = t.Description,
                    Tier = t.Tier,
                    Category = t.Category,
                    LoadStrategy = t.LoadStrategy,
                    Path = t.Path
                })
                .ToList()
        };
    }

    private static bool MatchesTerms(ToolCatalogItem item, List<string> terms)
    {
        var haystack = BuildSearchHaystack(item);
        return terms.All(term => haystack.Contains(term));
    }

    /// <summary>
    /// 搜索语料：名称 + 中英文描述 + 分类 + 标签 + 能力树路径（含工序/业务对象段）+ 参数 schema 中的属性名与描述。
    /// 路径入语料后，"curing plan"、"硫化 计划" 这类意图词能命中 /mes/iris/_05Curing/ 下的工具；
    /// schema 入语料后，"db_name" 这类参数级关键词也能命中 execute_sql_query。
    /// </summary>
    private static string BuildSearchHaystack(ToolCatalogItem item)
    {
        var sb = new System.Text.StringBuilder(512);
        sb.Append(item.Name).Append(' ')
          .Append(item.Description).Append(' ')
          .Append(item.Category).Append(' ')
          .Append(item.Path).Append(' ')
          .Append(string.Join(' ', item.Tags ?? new List<string>()));

        if (item.Parameters != null)
        {
            AppendSchemaText(item.Parameters, sb, depth: 0);
        }

        return sb.ToString().ToLowerInvariant();
    }

    /// <summary>从 JSON Schema 中递归提取属性名与 description 文本（限深限量，避免超大 schema 拖慢搜索）。</summary>
    private static void AppendSchemaText(JsonNode node, System.Text.StringBuilder sb, int depth)
    {
        if (depth > 6 || sb.Length > 8000) return;

        if (node is JsonObject obj)
        {
            foreach (var (key, value) in obj)
            {
                if (sb.Length > 8000) return;
                if (key.Equals("description", StringComparison.OrdinalIgnoreCase) && value is JsonValue v)
                {
                    sb.Append(' ').Append(v.ToString());
                }
                else if (value is JsonObject childObj && key.Equals("properties", StringComparison.OrdinalIgnoreCase))
                {
                    foreach (var (propName, propSchema) in childObj)
                    {
                        sb.Append(' ').Append(propName);
                        if (propSchema != null) AppendSchemaText(propSchema, sb, depth + 1);
                    }
                }
                else if (value != null && !key.Equals("description", StringComparison.OrdinalIgnoreCase))
                {
                    AppendSchemaText(value, sb, depth + 1);
                }
            }
        }
    }

    private ToolCatalogItem BuildCatalogItem(ITool tool, string language, bool onlineDeferredEnabled = false)
    {
        var attr = tool.GetType().GetCustomAttribute<ToolCatalogMetadataAttribute>();
        var inferred = InferMetadata(tool, attr, onlineDeferredEnabled);
        var isEn = language.Equals("en", StringComparison.OrdinalIgnoreCase);

        return new ToolCatalogItem
        {
            Name = tool.Name,
            Description = attr?.Description ?? (isEn ? tool.DescriptionEn : tool.Description),
            Parameters = tool.Parameters.Function.Parameters,
            RiskLevel = NormalizeRiskLevel(attr?.RiskLevel ?? inferred.RiskLevel),
            IsReadOnly = attr?.IsReadOnly ?? inferred.IsReadOnly,
            IsConcurrencySafe = attr?.IsConcurrencySafe ?? inferred.IsConcurrencySafe,
            IsDestructive = attr?.IsDestructive ?? inferred.IsDestructive,
            RequiredPermissions = (attr?.RequiredPermissions ?? inferred.RequiredPermissions).ToList(),
            MaxResultSizeChars = attr?.MaxResultSizeChars ?? inferred.MaxResultSizeChars,
            Category = attr?.Category ?? inferred.Category,
            Deferred = inferred.Deferred,
            AlwaysLoad = inferred.AlwaysLoad,
            Strict = attr?.Strict ?? tool.Parameters.Function.Strict,
            Tier = inferred.Tier,
            LoadStrategy = inferred.LoadStrategy,
            DenyPatterns = (attr?.DenyPatterns ?? Array.Empty<string>()).ToList(),
            Idempotent = attr?.Idempotent,
            OperationType = attr?.OperationType ?? inferred.OperationType,
            ApprovalMode = attr?.ApprovalMode ?? inferred.ApprovalMode,
            RequiredDataScopes = (attr?.RequiredDataScopes ?? Array.Empty<string>()).ToList(),
            DefaultTruncation = attr?.DefaultTruncation ?? inferred.DefaultTruncation,
            DefaultTimeoutMs = attr?.DefaultTimeoutMs ?? inferred.DefaultTimeoutMs,
            RequiresApproval = attr?.RequiresApproval ?? inferred.RequiresApproval,
            ImpactStatement = attr?.ImpactStatement,
            AffectedEntityTypes = (attr?.AffectedEntityTypes ?? inferred.AffectedEntityTypes).ToList(),
            Scopes = (attr?.Scopes ?? Array.Empty<string>()).ToList(),
            Tags = (attr?.Tags ?? Array.Empty<string>()).ToList(),
            Path = InferToolPath(tool, attr)
        };
    }

    private static InferredMetadata InferMetadata(ITool tool, ToolCatalogMetadataAttribute? attr, bool onlineDeferredEnabled = false)
    {
        var name = tool.Name;
        var category = InferCategory(name);
        var tier = InferTier(tool, attr);

        bool destructive = attr?.IsDestructive
                           ?? (name.StartsWith("delete_", StringComparison.OrdinalIgnoreCase)
                               || name.StartsWith("modify_", StringComparison.OrdinalIgnoreCase)
                               || name.StartsWith("send_", StringComparison.OrdinalIgnoreCase)
                               || name.StartsWith("start_", StringComparison.OrdinalIgnoreCase));

        bool readOnly = attr?.IsReadOnly
                        ?? (!destructive && IsReadOnlyPrefix(name));

        bool concurrencySafe = attr?.IsConcurrencySafe ?? readOnly;

        string riskLevel = attr?.RiskLevel
            ?? (destructive ? "dangerous" : readOnly ? "safe" : "normal");

        var loadStrategy = InferLoadStrategy(tier, attr, name, onlineDeferredEnabled);
        bool deferred = loadStrategy == ToolLoadStrategy.Deferred;
        bool alwaysLoad = loadStrategy == ToolLoadStrategy.AlwaysLoad;

        // 显式 Deferred 始终尊重（工具主动选择延迟）；显式 AlwaysLoad 仅在未开启延迟或核心工具时尊重，
        // 避免已标注的业务工具通过 AlwaysLoad 重新挤回首轮上下文。
        if (attr != null)
        {
            if (attr.Deferred)
            {
                deferred = true;
                alwaysLoad = false;
                loadStrategy = ToolLoadStrategy.Deferred;
            }
            if (attr.AlwaysLoad && (!onlineDeferredEnabled || IsCoreOnlineTool(name, attr.Path, tier)))
            {
                deferred = false;
                alwaysLoad = true;
                loadStrategy = ToolLoadStrategy.AlwaysLoad;
            }
        }

        var operationType = InferOperationType(readOnly, destructive, attr);
        var requiresApproval = attr?.RequiresApproval ?? (operationType == ToolOperationType.Write);

        return new InferredMetadata
        {
            RiskLevel = riskLevel,
            IsReadOnly = readOnly,
            IsConcurrencySafe = concurrencySafe,
            IsDestructive = destructive,
            Category = category,
            Deferred = deferred,
            AlwaysLoad = alwaysLoad,
            MaxResultSizeChars = DefaultMaxResultSizeChars,
            RequiredPermissions = InferRequiredPermissions(tier, attr),
            Tier = tier,
            LoadStrategy = InferLoadStrategy(tier, attr, name, onlineDeferredEnabled),
            OperationType = operationType,
            ApprovalMode = InferApprovalMode(operationType, requiresApproval, attr),
            AffectedEntityTypes = InferAffectedEntityTypes(name, attr),
            RequiresApproval = requiresApproval
        };
    }

    // Online 延迟加载下，始终立即可用的核心客观能力（发现原语、工作区/文档原语、SQL 查询、web 搜索、工作流入口）。
    // 不在此集合中的工具（/system 业务查询与报表、/code/python、/code/sql/* schema 助手、/code/export/*、Admin 等）
    // 在 OnlineDeferredLoading 开启时一律按需发现，避免首轮把 100+ 业务工具塞进模型上下文。
    private static readonly HashSet<string> CoreOnlineToolNames = new(StringComparer.OrdinalIgnoreCase)
    {
        "tool_search", "list_capabilities", "read_capability",
        "read_file", "write_file", "str_replace", "list_files", "delete_file", "present_artifact",
        "create_word_document", "create_excel_document", "create_pptx_document",
        "execute_sql_query",
        "web_search",
        "start_workflow",
        "iris_aps_understand_demand",
        "iris_aps_confirm_and_schedule",
        "iris_aps_get_status",
        "iris_aps_review_result",
        "iris_aps_adjust_result",
        "iris_aps_publish"
    };

    private static bool IsCoreOnlineTool(string name, string? path, ToolTier tier) =>
        CoreOnlineToolNames.Contains(name) ||
        (path?.StartsWith("/local/", StringComparison.OrdinalIgnoreCase) ?? false) ||
        tier == ToolTier.Workflow;

    private static ToolLoadStrategy InferLoadStrategy(ToolTier tier, ToolCatalogMetadataAttribute? attr, string name, bool onlineDeferredEnabled = false)
    {
        // 未开启 Online 延迟：保持旧行为（已标注工具采信其 LoadStrategy；未标注工具全部直接加载）。
        if (!onlineDeferredEnabled)
        {
            return attr != null ? attr.LoadStrategy : ToolLoadStrategy.AlwaysLoad;
        }

        // Online 延迟开启：核心强制 AlwaysLoad；其余一律 Deferred，忽略工具在 [ToolCatalogMetadata] 中写的 LoadStrategy，
        // 即便后端按文档给业务工具补了 AlwaysLoad 标注，也不会重新挤回首轮上下文。
        return IsCoreOnlineTool(name, attr?.Path, tier) ? ToolLoadStrategy.AlwaysLoad : ToolLoadStrategy.Deferred;
    }

    private static ToolOperationType InferOperationType(bool readOnly, bool destructive, ToolCatalogMetadataAttribute? attr)
    {
        if (attr != null)
            return attr.OperationType;

        if (destructive)
            return ToolOperationType.Write;
        if (readOnly)
            return ToolOperationType.Read;
        return ToolOperationType.Mixed;
    }

    private static ApprovalMode InferApprovalMode(ToolOperationType operationType, bool requiresApproval, ToolCatalogMetadataAttribute? attr)
    {
        if (attr != null)
            return attr.ApprovalMode;

        if (operationType == ToolOperationType.Write && requiresApproval)
            return ApprovalMode.Explicit;
        return ApprovalMode.Auto;
    }

    private static string[] InferRequiredPermissions(ToolTier tier, ToolCatalogMetadataAttribute? attr)
    {
        var existing = attr?.RequiredPermissions;
        if (existing != null && existing.Length > 0)
            return existing;

        return tier switch
        {
            ToolTier.Admin => new[] { "ai:admin" },
            ToolTier.Primitive => new[] { "ai:advanced" },
            _ => Array.Empty<string>()
        };
    }

    private static string[] InferAffectedEntityTypes(string name, ToolCatalogMetadataAttribute? attr)
    {
        if (attr?.AffectedEntityTypes is { Length: > 0 })
            return attr.AffectedEntityTypes;

        // 简单启发式：从 "verb_system_entity_action" 中提取 entity 部分
        var parts = name.Split('_', StringSplitOptions.RemoveEmptyEntries);
        if (parts.Length >= 3)
        {
            // 例如 query_iris_curing_plan → curing_plan
            var entityParts = parts.Skip(2).Take(parts.Length - 2).ToArray();
            if (entityParts.Length > 0)
                return new[] { string.Join("_", entityParts) };
        }

        return Array.Empty<string>();
    }

    private static string NormalizeRiskLevel(string? riskLevel)
    {
        if (string.IsNullOrWhiteSpace(riskLevel))
            return "standard";

        return riskLevel.ToLowerInvariant() switch
        {
            "safe" => "read_only",
            "normal" => "standard",
            "elevated" => "elevated",
            "dangerous" => "destructive",
            "admin" => "destructive",
            "read_only" => "read_only",
            "standard" => "standard",
            "destructive" => "destructive",
            _ => "standard"
        };
    }

    private static ToolTier InferTier(ITool tool, ToolCatalogMetadataAttribute? attr)
    {
        // Attribute 显式指定时优先使用
        if (attr != null)
            return attr.Tier;

        var name = tool.Name;

        if (name.Equals("start_workflow", StringComparison.OrdinalIgnoreCase))
            return ToolTier.Workflow;

        if (name.Equals("execute_sql_query", StringComparison.OrdinalIgnoreCase))
            return ToolTier.Admin;

        var primitivePrefixes = new[]
        {
            "search_schema", "list_schema_tables", "get_table_schema",
            "export_to_excel", "export_to_word", "export_to_image",
            "create_word_document", "create_excel_document", "create_pptx_document",
            "render_chart", "web_search"
        };

        if (primitivePrefixes.Any(p => name.Equals(p, StringComparison.OrdinalIgnoreCase)))
            return ToolTier.Primitive;

        // 业务查询/报表/修改/IRIS/XYqz 均视为领域操作
        return ToolTier.DomainOperation;
    }

    private static string InferCategory(string name)
    {
        if (name.StartsWith("iris_", StringComparison.OrdinalIgnoreCase)) return "iris";
        if (name.StartsWith("ykhm_", StringComparison.OrdinalIgnoreCase)) return "ykhm";
        if (name.StartsWith("xyqz_", StringComparison.OrdinalIgnoreCase)) return "xyqz";
        if (name.StartsWith("sls_", StringComparison.OrdinalIgnoreCase)) return "sls";
        if (name.StartsWith("web_", StringComparison.OrdinalIgnoreCase)) return "web";
        if (name.StartsWith("export_", StringComparison.OrdinalIgnoreCase)) return "export";
        if (name.StartsWith("create_", StringComparison.OrdinalIgnoreCase) && name.EndsWith("_document", StringComparison.OrdinalIgnoreCase)) return "document";
        if (name.StartsWith("trace_", StringComparison.OrdinalIgnoreCase)) return "trace";
        if (name.StartsWith("start_", StringComparison.OrdinalIgnoreCase)) return "workflow";
        if (name.StartsWith("search_", StringComparison.OrdinalIgnoreCase)
            || name.StartsWith("list_", StringComparison.OrdinalIgnoreCase)
            || name.StartsWith("get_", StringComparison.OrdinalIgnoreCase)
            || name.StartsWith("execute_", StringComparison.OrdinalIgnoreCase)) return "schema";
        return "general";
    }

    private static bool IsReadOnlyPrefix(string name)
    {
        return name.StartsWith("query_", StringComparison.OrdinalIgnoreCase)
            || name.StartsWith("get_", StringComparison.OrdinalIgnoreCase)
            || name.StartsWith("list_", StringComparison.OrdinalIgnoreCase)
            || name.StartsWith("search_", StringComparison.OrdinalIgnoreCase)
            || name.StartsWith("report_", StringComparison.OrdinalIgnoreCase)
            || name.StartsWith("trace_", StringComparison.OrdinalIgnoreCase)
            || name.StartsWith("export_", StringComparison.OrdinalIgnoreCase)
            || name.StartsWith("render_", StringComparison.OrdinalIgnoreCase);
    }

    private static IEnumerable<ITool> FilterBySystem(IEnumerable<ITool> tools, string systemCode)
    {
        // Local 模式（MESCLI-Local）仅暴露 demo / local / code 域工具，防止 MES 工具泄露。
        // 其余域过滤规则统一收敛到 DomainCatalog（与 ToolRegistry 执行闸门共用同一份规则）。
        if (systemCode.Equals("local", StringComparison.OrdinalIgnoreCase))
        {
            return tools.Where(t => DomainCatalog.IsLocalToolType(t.GetType()));
        }

        return DomainCatalog.FilterBySystem(tools, systemCode);
    }

    /// <summary>
    /// 路径去重：多个工具共享同一目录路径时（如 APS 工具统一标注 Path="/mes/iris/aps"），
    /// 为每个工具追加工具名形成叶子路径，保证 read_capability 能按路径唯一定位。
    /// </summary>
    private static void EnsureUniquePaths(List<ToolCatalogItem> items)
    {
        CanonicalizePathSegments(items);
        foreach (var group in items.Where(i => i.Path != null).GroupBy(i => i.Path!, StringComparer.OrdinalIgnoreCase))
        {
            if (group.Count() <= 1) continue;
            foreach (var item in group)
            {
                if (!item.Path!.EndsWith("/" + item.Name, StringComparison.OrdinalIgnoreCase))
                    item.Path = $"{item.Path}/{item.Name}";
            }
        }
    }

    /// <summary>
    /// 路径段规范化：同一目录下"带序号前缀"与"不带前缀"的同名段（如 _01Base 与 Base）
    /// 合并为同一节点，规范名优先取带序号前缀的变体（序号承载工序顺序信息）。
    /// 键为"祖先路径的规范化形式"，只有全部祖先段也一致的段才会合并，避免跨目录误并。
    /// </summary>
    private static void CanonicalizePathSegments(List<ToolCatalogItem> items)
    {
        // 第一遍：为每个规范化前缀选出规范段名（序号变体优先，其次字典序最小保证确定性）
        var canonical = new Dictionary<string, string>(StringComparer.Ordinal);
        foreach (var item in items.Where(i => i.Path != null))
        {
            var segs = item.Path!.Split('/', StringSplitOptions.RemoveEmptyEntries);
            for (var d = 1; d <= segs.Length; d++)
            {
                var normPrefix = string.Join('/', segs.Take(d).Select(NormalizeSegmentKey));
                var raw = segs[d - 1];
                if (!canonical.TryGetValue(normPrefix, out var chosen)
                    || (IsOrdinalSegment(raw) && !IsOrdinalSegment(chosen))
                    || (IsOrdinalSegment(raw) == IsOrdinalSegment(chosen) && string.CompareOrdinal(raw, chosen) < 0))
                {
                    canonical[normPrefix] = raw;
                }
            }
        }
        // 第二遍：按规范段名重写路径
        foreach (var item in items.Where(i => i.Path != null))
        {
            var segs = item.Path!.Split('/', StringSplitOptions.RemoveEmptyEntries);
            for (var d = 1; d <= segs.Length; d++)
            {
                var normPrefix = string.Join('/', segs.Take(d).Select(NormalizeSegmentKey));
                if (canonical.TryGetValue(normPrefix, out var chosen))
                    segs[d - 1] = chosen;
            }
            item.Path = "/" + string.Join('/', segs);
        }
    }

    private static string NormalizeSegmentKey(string segment) =>
        DomainCatalog.StripOrdinalPrefix(segment).ToLowerInvariant();

    private static bool IsOrdinalSegment(string segment) =>
        segment.Length > 2 && segment[0] == '_' && char.IsDigit(segment[1]);

    /// <summary>
    /// 领域洞察：基于当前可见工具实时生成的宏观理解文本，随 /api/capabilities 返回，
    /// 由前端拼接到系统提示。只包含"提前看过目录组织"才能得到的信息：
    /// 业务域按什么流程组织、每段有多少工具、读写语义分布。
    /// 所有数字均来自实时注册表统计，工具增删后自动准确，无需维护。
    /// </summary>
    private static string? BuildDomainInsight(string systemCode, List<ToolCatalogItem> items)
    {
        if (systemCode.Equals("local", StringComparison.OrdinalIgnoreCase) || items.Count == 0)
            return null;

        var domainRoot = $"/mes/{systemCode.ToLowerInvariant()}";
        var businessTools = items.Where(i => i.Path?.StartsWith(domainRoot + "/", StringComparison.OrdinalIgnoreCase) == true).ToList();
        var universalTools = items.Except(businessTools).ToList();

        var sb = new System.Text.StringBuilder();
        sb.Append(DomainCatalog.GetDomainLabel(systemCode))
          .Append("域当前可见 ")
          .Append(items.Count)
          .Append(" 个工具");

        if (businessTools.Count > 0)
        {
            // 业务工具按目录第一段（通常是工序段）聚合；直挂在域根目录下的工具（如旧版演示工具）单独归类，
            // 避免每个直挂工具在洞察里各占一行。
            var directTools = businessTools
                .Where(i => !i.Path![(domainRoot.Length + 1)..].Contains('/'))
                .ToList();
            var folderTools = businessTools.Except(directTools).ToList();

            // 带序号前缀的工序段（_01Raw…_13Mould）按序号排在前面，其余段（Aps、DemoData 等）排后。
            var segments = folderTools
                .GroupBy(i => i.Path![(domainRoot.Length + 1)..].Split('/')[0])
                .OrderBy(g => g.Key.StartsWith('_') ? 0 : 1)
                .ThenBy(g => g.Key, StringComparer.OrdinalIgnoreCase)
                .ToList();

            sb.Append("，其中业务工具 ").Append(businessTools.Count).Append(" 个，按目录组织：");
            var parts = new List<string>();
            foreach (var seg in segments)
            {
                var label = DomainCatalog.GetSegmentLabel(seg.Key);
                var secondLevel = seg
                    .Select(i => i.Path![(domainRoot.Length + 1)..].Split('/'))
                    .Where(p => p.Length > 2)
                    .GroupBy(p => p[1])
                    .OrderBy(g => g.Key, StringComparer.OrdinalIgnoreCase)
                    .ToList();

                var part = secondLevel.Count > 0
                    ? $"{label} {seg.Key}（{seg.Count()}：{string.Join(" / ", secondLevel.Select(g => $"{DomainCatalog.GetSegmentLabel(g.Key)} {g.Count()}"))}）"
                    : $"{label} {seg.Key}（{seg.Count()}）";
                parts.Add(part);
            }
            if (directTools.Count > 0)
            {
                parts.Add($"域根目录直挂工具（{directTools.Count} 个，未按子目录分层）");
            }
            sb.Append(string.Join("；", parts)).Append('。');

            var writeCount = businessTools.Count(i => i.OperationType == ToolOperationType.Write);
            sb.Append(writeCount == 0
                ? "业务工具绝大多数为只读查询/报表。"
                : $"业务工具以只读查询/报表为主；约 {writeCount} 个涉及写/副作用操作，调用前会触发用户审批。");
        }

        if (universalTools.Count > 0)
        {
            sb.Append($"另有通用能力 {universalTools.Count} 个（文件工作区、SQL、Python、图表、Office 文档、联网搜索、工作流等），在 /local、/code 等目录下。");
        }

        return sb.ToString();
    }

    private List<string> BuildFeatures()
    {
        var features = new List<string>
        {
            "streaming",
            "toolExecution",
            "chatProxy",
            "multiProvider"
        };

        // Online 默认走前端 Agent Loop，与 MESCLI-Local 对齐：
        // 对话上下文、System Prompt 装配、工具编排、结果渲染与持久化都由前端 Agent 内核统一负责；
        // 后端仅作为 LLM 代理（/api/chat/proxy）与工具/工作区平台（/api/tools/execute）。
        // 这样 Online 与 Local 共用同一套上下文与工具循环，避免后端 ChatService 传统循环
        // 重复加载历史导致的"上下文翻倍"、工具执行与对话 UI 不同步、持久化双写等问题。
        // 如需回退到后端传统循环，显式设置 AIGateway:Features:FrontendLoopOnline = false。
        if (_configuration.GetValue<bool?>("AIGateway:Features:FrontendLoopOnline") != false)
        {
            features.Add("frontend_loop_online");
        }

        features.AddRange(_providerFactory.GetSupportedProviderNames().Select(p => $"provider:{p}"));
        return features;
    }

    private static string GetVersion()
    {
        var assembly = Assembly.GetExecutingAssembly().GetName().Version;
        return assembly != null ? $"{assembly.Major}.{assembly.Minor}.{assembly.Build}" : "0.1.0";
    }

    #region Filesystem-like Capability Discovery

    /// <summary>
    /// 以文件系统方式列出指定路径下的目录和工具入口。
    /// 目录名对所有请求可见，但工具节点仅在当前 systemCode 下有权限暴露。
    /// </summary>
    public CapabilityTreeResponse GetTree(string? path, string language = "zh", string? systemCode = null)
    {
        systemCode ??= "ykhm";
        var normalizedPath = NormalizePath(path);

        var tools = ResolveVisibleTools(systemCode);
        var items = tools.Select(t => BuildCatalogItem(t, language)).ToList();
        EnsureUniquePaths(items);
        var nodes = BuildTreeNodes(items, normalizedPath);

        return new CapabilityTreeResponse
        {
            Path = normalizedPath,
            Nodes = nodes,
            Note = InferTreeNote(systemCode, normalizedPath),
            TotalTools = items.Count(i => i.Path != null && IsUnderPath(i.Path, normalizedPath))
        };
    }

    /// <summary>
    /// 读取指定路径工具的完整 schema。
    /// 若路径不存在或当前 systemCode 不可见，返回 null。
    /// </summary>
    public CapabilitySchemaResponse? GetSchema(string path, string language = "zh", string? systemCode = null)
    {
        systemCode ??= "ykhm";
        var normalizedPath = NormalizePath(path);

        var tools = ResolveVisibleTools(systemCode);
        var item = tools
            .Select(t => BuildCatalogItem(t, language))
            .ToList();
        EnsureUniquePaths(item);
        var matched = item
            .FirstOrDefault(i => i.Path != null && i.Path.Equals(normalizedPath, StringComparison.OrdinalIgnoreCase));

        if (matched == null)
            return null;

        return new CapabilitySchemaResponse
        {
            Path = matched.Path!,
            Name = matched.Name,
            Description = matched.Description,
            Parameters = matched.Parameters,
            RiskLevel = matched.RiskLevel,
            OperationType = matched.OperationType,
            RequiresApproval = matched.RequiresApproval,
            ApprovalMode = matched.ApprovalMode,
            RequiredPermissions = matched.RequiredPermissions,
            RequiredDataScopes = matched.RequiredDataScopes,
            DenyPatterns = matched.DenyPatterns,
            Idempotent = matched.Idempotent,
            DefaultTimeoutMs = matched.DefaultTimeoutMs,
            MaxResultSizeChars = matched.MaxResultSizeChars,
            Tier = matched.Tier,
            Category = matched.Category
        };
    }

    private List<ITool> ResolveVisibleTools(string systemCode)
    {
        if (systemCode.Equals("local", StringComparison.OrdinalIgnoreCase))
        {
            return GetLocalDemoTools();
        }

        return FilterBySystem(_toolRegistry.GetAllTools(), systemCode).ToList();
    }

    private static string NormalizePath(string? path)
    {
        if (string.IsNullOrWhiteSpace(path))
            return "/";

        var normalized = path.Trim().Replace('\\', '/');
        if (!normalized.StartsWith('/'))
            normalized = "/" + normalized;

        while (normalized.Contains("//"))
            normalized = normalized.Replace("//", "/");

        if (normalized.Length > 1 && normalized.EndsWith('/'))
            normalized = normalized[..^1];

        return normalized;
    }

    private static string InferToolPath(ITool tool, ToolCatalogMetadataAttribute? attr)
    {
        // 优先按命名空间推断：工具的文件目录组织（Tools/Iris/_05Curing/...）即能力树的层级结构，
        // 让模型能按工序/业务对象逐级导航，而不是面对平铺的几百个工具名。
        // 命名空间是全部工具的系统性组织方式，优先于个别工具的 Path 特性（后者多为早期扁平路径，
        // 如 /sls/xxx；命名空间推断能给出 /mes/sls/_02Mix/... 的完整工序层级）。
        var nsPath = DomainCatalog.InferPathFromNamespace(tool.GetType(), tool.Name);
        if (!string.IsNullOrEmpty(nsPath))
            return NormalizePath(nsPath);

        if (!string.IsNullOrWhiteSpace(attr?.Path))
            return NormalizePath(attr!.Path);

        var category = attr?.Category ?? InferCategory(tool.Name);
        var name = tool.Name;

        return category.ToLowerInvariant() switch
        {
            "demo" => $"/demo/{name}",
            "local" => $"/local/{name}",
            "iris" => $"/mes/iris/{name}",
            "xyqz" => $"/mes/xyqz/{name}",
            "ykhm" => $"/mes/ykhm/{name}",
            "sls" => $"/mes/sls/{name}",
            "code" => $"/code/{name}",
            "sql" => $"/code/sql/{name}",
            "python" => $"/code/python/{name}",
            "schema" => $"/code/sql/{name}",
            "web" => $"/web/{name}",
            "workflow" => $"/workflow/{name}",
            "export" => $"/code/export/{name}",
            "document" => $"/code/document/{name}",
            _ => $"/system/{name}"
        };
    }

    private static List<CapabilityNode> BuildTreeNodes(List<ToolCatalogItem> items, string normalizedPath)
    {
        var groups = items
            .Where(i => i.Path != null && IsUnderPath(i.Path, normalizedPath))
            .GroupBy(i => GetFirstSegmentAfter(i.Path!, normalizedPath), StringComparer.OrdinalIgnoreCase)
            .Where(g => !string.IsNullOrEmpty(g.Key))
            .OrderBy(g => g.Key, StringComparer.OrdinalIgnoreCase);

        var nodes = new List<CapabilityNode>();
        foreach (var group in groups)
        {
            var segment = group.Key;
            var childPath = normalizedPath == "/" ? $"/{segment}" : $"{normalizedPath}/{segment}";
            var groupList = group.ToList();
            var isTool = groupList.Count == 1
                      && groupList[0].Path!.Equals(childPath, StringComparison.OrdinalIgnoreCase);

            if (isTool)
            {
                var tool = groupList[0];
                nodes.Add(new CapabilityNode
                {
                    Name = segment,
                    Path = tool.Path!,
                    Kind = InferNodeKind(tool.Category),
                    Description = tool.Description,
                    Tier = tool.Tier,
                    Category = tool.Category
                });
            }
            else
            {
                var children = groupList
                    .Select(i => GetFirstSegmentAfter(i.Path!, childPath))
                    .Where(s => !string.IsNullOrEmpty(s))
                    .Distinct(StringComparer.OrdinalIgnoreCase)
                    .OrderBy(s => s, StringComparer.OrdinalIgnoreCase)
                    .ToList();

                nodes.Add(new CapabilityNode
                {
                    Name = segment,
                    Path = childPath,
                    Kind = "folder",
                    Description = InferDirectoryDescription(segment),
                    Children = children,
                    // 目录级统计：该目录（含所有子层）下的可见工具总数，供模型判断"这段流程有多少工具"，
                    // 数字本身就是导航信号——工具多的目录值得先发散浏览，工具少的可直接读完。
                    ToolCount = groupList.Count
                });
            }
        }

        return nodes;
    }

    private static bool IsUnderPath(string toolPath, string parentPath)
    {
        if (parentPath == "/")
            return toolPath.StartsWith("/", StringComparison.Ordinal);

        return toolPath.StartsWith(parentPath + "/", StringComparison.OrdinalIgnoreCase)
            || toolPath.Equals(parentPath, StringComparison.OrdinalIgnoreCase);
    }

    private static string GetFirstSegmentAfter(string toolPath, string parentPath)
    {
        if (parentPath == "/")
        {
            var parts = toolPath.Split('/', StringSplitOptions.RemoveEmptyEntries);
            return parts.Length > 0 ? parts[0] : string.Empty;
        }

        if (!toolPath.StartsWith(parentPath + "/", StringComparison.OrdinalIgnoreCase))
            return string.Empty;

        var remaining = toolPath.Substring(parentPath.Length + 1);
        var slashIndex = remaining.IndexOf('/');
        return slashIndex < 0 ? remaining : remaining[..slashIndex];
    }

    private static string InferNodeKind(string? category)
    {
        return category?.ToLowerInvariant() switch
        {
            "code" or "python" or "sql" => "code_runtime",
            _ => "tool"
        };
    }

    private static string InferDirectoryDescription(string segment)
    {
        return DomainCatalog.GetSegmentLabel(segment);
    }

    private static string? InferTreeNote(string systemCode, string normalizedPath)
    {
        if (systemCode.Equals("local", StringComparison.OrdinalIgnoreCase))
        {
            if (normalizedPath == "/")
                return "Local 模式仅展示 demo / local / code 域能力。";
            if (normalizedPath.StartsWith("/mes", StringComparison.OrdinalIgnoreCase))
                return "Local 模式下 MES 域能力不可用。";
        }

        return null;
    }

    #endregion

    private sealed class InferredMetadata
    {
        public string RiskLevel { get; set; } = "normal";
        public bool IsReadOnly { get; set; }
        public bool IsConcurrencySafe { get; set; }
        public bool IsDestructive { get; set; }
        public string Category { get; set; } = "general";
        public bool Deferred { get; set; }
        public bool AlwaysLoad { get; set; } = true;
        public int MaxResultSizeChars { get; set; } = DefaultMaxResultSizeChars;
        public string[] RequiredPermissions { get; set; } = Array.Empty<string>();
        public ResultTruncationStrategy DefaultTruncation { get; set; } = ResultTruncationStrategy.HeadWithCount;
        public int DefaultTimeoutMs { get; set; } = 30000;
        public bool RequiresApproval { get; set; }
        public ToolTier Tier { get; set; } = ToolTier.DomainOperation;
        public ToolLoadStrategy LoadStrategy { get; set; } = ToolLoadStrategy.AlwaysLoad;
        public ToolOperationType OperationType { get; set; } = ToolOperationType.Read;
        public ApprovalMode ApprovalMode { get; set; } = ApprovalMode.Auto;
        public string[] AffectedEntityTypes { get; set; } = Array.Empty<string>();
    }
}
