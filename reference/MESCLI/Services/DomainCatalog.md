using System.Reflection;
using AIGateway.Tools;

namespace AIGateway.Services;

/// <summary>
/// 业务域目录规则（统一来源）：
/// 1. systemCode 域过滤——ToolRegistry（执行闸门）与 CapabilityService（目录服务）共用，避免两处规则漂移。
/// 2. 命名空间 → 能力树路径映射——把后端工具的文件组织（如 Tools/Iris/_05Curing）传递为模型可导航的目录结构。
/// 3. 目录段语义标签——一份与具体业务域无关的通用词汇表（工序/业务对象 → 中文语义），各域共用。
/// 所有统计均由调用方基于实时注册表计算，此处只提供规则，不缓存数量。
/// </summary>
public static class DomainCatalog
{
    /// <summary>所有系统共享的通用工具白名单（Schema 发现、导出、图表、工作流、联网搜索、Python 沙箱、文件原语等） </summary>
    /// <remarks>
    /// 2026-07-22 决策：所有业务域统一开放完整通用能力（原 xyqz/sls 受限集已废止）。
    /// 理由：Python 沙箱是数据分析与桥接外部系统的关键能力；文件原语配合工作区是
    /// 上下文管理手段（长工具结果落盘后用脚本/命令高效提取），与具体业务域无关。
    /// </remarks>
    public static readonly HashSet<string> UniversalTools = new(StringComparer.OrdinalIgnoreCase)
    {
        "search_schema",
        "list_schema_tables",
        "get_table_schema",
        "execute_sql_query",
        "execute_python_script",
        "export_to_excel",
        "export_to_word",
        "export_to_image",
        "render_chart",
        "start_workflow",
        "trace_barcode",
        "create_word_document",
        "create_excel_document",
        "create_pptx_document",
        "web_search",
        "read_file",
        "write_file",
        "str_replace",
        "list_files",
        "delete_file",
        "present_artifact",
    };

    /// <summary>
    /// 按 systemCode 过滤可见工具。ykhm 为默认域；未知域不过滤（保持旧行为）。
    /// </summary>
    public static IEnumerable<ITool> FilterBySystem(IEnumerable<ITool> tools, string? systemCode)
    {
        var code = NormalizeDomainCode(systemCode);

        if (code == null || code == "ykhm")
        {
            // ykhm 默认域：排除其他业务域前缀的工具，保留 ykhm 自身与通用工具
            return tools.Where(t => !t.Name.StartsWith("iris_", StringComparison.OrdinalIgnoreCase)
                                 && !t.Name.StartsWith("xyqz_", StringComparison.OrdinalIgnoreCase)
                                 && !t.Name.StartsWith("sls_", StringComparison.OrdinalIgnoreCase));
        }

        if (code == "iris")
        {
            return tools.Where(t => t.Name.StartsWith("iris_", StringComparison.OrdinalIgnoreCase)
                                 || UniversalTools.Contains(t.Name));
        }

        if (code == "xyqz")
        {
            return tools.Where(t => t.Name.StartsWith("xyqz_", StringComparison.OrdinalIgnoreCase)
                                 || UniversalTools.Contains(t.Name));
        }

        if (code == "sls")
        {
            return tools.Where(t => t.Name.StartsWith("sls_", StringComparison.OrdinalIgnoreCase)
                                 || UniversalTools.Contains(t.Name));
        }

        return tools;
    }

    /// <summary>
    /// 执行期域隔离判定：单个工具对指定 systemCode 是否可见。
    /// 与 FilterBySystem 同一套规则，供执行路径（ToolExecutionService / ToolRegistry.InvokeAsync）
    /// fail-close 使用——目录隐藏只是体验，执行拒绝才是边界。
    /// </summary>
    public static bool IsToolVisibleToSystem(ITool tool, string? systemCode)
    {
        if (systemCode?.Equals("local", StringComparison.OrdinalIgnoreCase) == true)
        {
            return IsLocalToolType(tool.GetType()) || UniversalTools.Contains(tool.Name);
        }
        return FilterBySystem(new[] { tool }, systemCode).Any();
    }

    /// <summary>
    /// 规范化域代码：小写化，并把历史别名 "mes" 归并到 ykhm 域。
    /// 防止输入 "MES" 落到"未知域不过滤"分支导致全域可见（隔离漏洞）。
    /// </summary>
    public static string? NormalizeDomainCode(string? systemCode)
    {
        if (string.IsNullOrWhiteSpace(systemCode)) return null;
        var code = systemCode.Trim().ToLowerInvariant();
        return code == "mes" ? "ykhm" : code;
    }

    /// <summary>
    /// 判断身份是否为已认证的业务域身份（非 local 匿名回退）。
    /// 用于决定 systemCode 以服务端身份还是客户端参数为准：
    /// 域身份必须 fail-close 防跨域；local 回退（MESCLI Local / 开发调试）允许客户端指定。
    /// </summary>
    public static bool IsDomainIdentity(string? systemCode) =>
        !string.IsNullOrWhiteSpace(systemCode) && !systemCode.Equals("local", StringComparison.OrdinalIgnoreCase);

    /// <summary>
    /// 计算请求的有效 systemCode：域身份时以身份为准（忽略客户端参数），否则取客户端参数或身份。
    /// </summary>
    public static string? ResolveEffectiveSystemCode(string? identitySystemCode, string? requestSystemCode) =>
        IsDomainIdentity(identitySystemCode)
            ? identitySystemCode
            : (string.IsNullOrWhiteSpace(requestSystemCode) ? identitySystemCode : requestSystemCode);

    /// <summary>
    /// 域 → execute_sql_query 可访问数据库白名单。返回 null 表示不限制
    /// （local 模式本就忽略 db_name；未知域保持旧兼容行为）。
    /// AIGateway（Schema 目录库）对所有业务域开放，供 schema 发现使用。
    /// </summary>
    public static IReadOnlyList<string>? GetAllowedSqlDatabases(string? systemCode)
    {
        return NormalizeDomainCode(systemCode) switch
        {
            "ykhm" => new[] { "MES", "MENS", "AIGateway" },
            "iris" => new[] { "IRIS", "IRISMIX", "AIGateway" },
            "xyqz" => new[] { "XYQZ", "AIGateway" },
            "sls" => new[] { "SLS", "AIGateway" },
            _ => null,
        };
    }

    /// <summary>域的默认 SQL 数据库（execute_sql_query 未指定 db_name 时使用）。</summary>
    public static string GetDefaultSqlDatabase(string? systemCode)
    {
        return NormalizeDomainCode(systemCode) switch
        {
            "iris" => "IRIS",
            "xyqz" => "XYQZ",
            "sls" => "SLS",
            _ => "MES",
        };
    }

    /// <summary>
    /// Local 模式工具类型判断：显式 Category = demo / local / code，或路径属于 /demo、/code 域。
    /// ToolRegistry 与 CapabilityService 共用，防止 MES 工具泄露到 Local。
    /// </summary>
    public static bool IsLocalToolType(Type toolType)
    {
        var attr = toolType.GetCustomAttribute<ToolCatalogMetadataAttribute>();
        var category = attr?.Category;
        var path = attr?.Path;

        if (!string.IsNullOrEmpty(path))
        {
            if (path.Equals("/demo", StringComparison.OrdinalIgnoreCase)
                || path.StartsWith("/demo/", StringComparison.OrdinalIgnoreCase)
                || path.Equals("/local", StringComparison.OrdinalIgnoreCase)
                || path.StartsWith("/local/", StringComparison.OrdinalIgnoreCase)
                || path.Equals("/code", StringComparison.OrdinalIgnoreCase)
                || path.StartsWith("/code/", StringComparison.OrdinalIgnoreCase))
            {
                return true;
            }
        }

        return category?.Equals("demo", StringComparison.OrdinalIgnoreCase) == true
            || category?.Equals("local", StringComparison.OrdinalIgnoreCase) == true
            || category?.Equals("code", StringComparison.OrdinalIgnoreCase) == true;
    }

    /// <summary>
    /// 命名空间 → 能力树路径。工具的命名空间即其文件目录组织（如 AIGateway.Tools.Iris._05Curing），
    /// 映射为 /mes/iris/_05Curing/{toolName}，使模型能按工序/业务对象逐级导航。
    /// 无法映射（根级工具）时返回 null，由调用方回退到分类推断。
    /// </summary>
    public static string? InferPathFromNamespace(Type toolType, string toolName)
    {
        var ns = toolType.Namespace ?? string.Empty;
        const string prefix = "AIGateway.Tools.";
        if (!ns.StartsWith(prefix, StringComparison.Ordinal))
            return null;

        var segments = ns[prefix.Length..].Split('.', StringSplitOptions.RemoveEmptyEntries);
        if (segments.Length == 0)
            return null;

        var top = segments[0].ToLowerInvariant() switch
        {
            "iris" => "/mes/iris",
            "xyqz" => "/mes/xyqz",
            "ykhm" => "/mes/ykhm",
            "sls" => "/mes/sls",
            "demo" => "/demo",
            "workspace" => "/local",
            "schemadiscovery" => "/code/sql",
            "code" => "/code",
            _ => null
        };
        if (top == null)
            return null;

        var sub = string.Join('/', segments.Skip(1));
        return string.IsNullOrEmpty(sub) ? $"{top}/{toolName}" : $"{top}/{sub}/{toolName}";
    }

    /// <summary>
    /// 目录段语义标签：通用工序/业务对象词汇表（与各业务域无关，所有域共用）。
    /// 支持 "_05Curing" 这类带序号的段名（先剥序号再查表）；未命中时回退段名本身。
    /// </summary>
    public static string GetSegmentLabel(string segment)
    {
        var key = StripOrdinalPrefix(segment).ToLowerInvariant();
        return SegmentLabels.TryGetValue(key, out var label) ? label : segment;
    }

    /// <summary>剥掉 "_05"、"01" 这类排序前缀，返回语义部分（如 _05Curing → Curing）。</summary>
    public static string StripOrdinalPrefix(string segment)
    {
        var s = segment.TrimStart('_');
        var i = 0;
        while (i < s.Length && char.IsDigit(s[i])) i++;
        return i > 0 && i < s.Length ? s[i..] : segment;
    }

    private static readonly Dictionary<string, string> SegmentLabels = new(StringComparer.OrdinalIgnoreCase)
    {
        // 顶层域
        ["demo"] = "演示业务工具",
        ["local"] = "本地通用原语",
        ["mes"] = "MES 业务域能力",
        ["iris"] = "IRIS MES 专用能力",
        ["xyqz"] = "XYQZ MES 专用能力",
        ["ykhm"] = "YKHM MES 专用能力",
        ["sls"] = "SLS MENS 专用能力",
        ["code"] = "代码执行环境",
        ["python"] = "Python 脚本执行",
        ["sql"] = "SQL 查询与分析",
        ["web"] = "Web 搜索与桥接",
        ["workflow"] = "工作流编排",
        ["system"] = "系统级能力",
        // 通用工序段（轮胎制造流程，各业务域同构）
        ["raw"] = "原材料",
        ["mix"] = "密炼",
        ["semi"] = "半制品",
        ["molding"] = "成型",
        ["curing"] = "硫化",
        ["quality"] = "质检",
        ["storage"] = "仓储",
        ["equip"] = "设备",
        ["equipmanage"] = "设备管理",
        ["techrecipe"] = "技术配方",
        ["mould"] = "模具",
        ["aps"] = "高级排产",
        // 通用业务对象段（工序内二级组织）
        ["plan"] = "计划",
        ["production"] = "生产实绩",
        ["stock"] = "库存",
        ["instock"] = "入库",
        ["outstock"] = "出库",
        ["report"] = "报表",
        ["base"] = "基础数据",
        // 演示/旧版
        ["demodata"] = "演示数据",
        ["oldtools"] = "旧版演示工具",
    };

    /// <summary>systemCode → 业务域中文名（仅用于洞察文案，未知域回退 systemCode 本身）。</summary>
    public static string GetDomainLabel(string systemCode)
    {
        return systemCode.ToLowerInvariant() switch
        {
            "iris" => "IRIS 轮胎制造",
            "xyqz" => "XYQZ（雄鹰）轮胎",
            "ykhm" => "YKHM MES",
            "sls" => "SLS（三力士）MENS",
            _ => systemCode
        };
    }
}
