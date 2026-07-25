using System.Reflection;
using System.Text.Json.Nodes;
using AIGateway.Services;

namespace AIGateway.Tools;

public class ToolRegistry
{
    private readonly Dictionary<string, ToolEntry> _tools = new(StringComparer.OrdinalIgnoreCase);
    private readonly IServiceProvider _serviceProvider;
    private readonly ILogger<ToolRegistry> _logger;

    // 按 ITool.Name 的索引：首次按名未命中时一次性建立，之后 O(1)。
    // 背景：大多数工具未在 attribute 声明 ToolName，注册键是类名，而 LLM 用 snake_case 的 ITool.Name 调用。
    private readonly object _nameIndexLock = new();
    private Dictionary<string, ToolEntry>? _nameIndex;

    public ToolRegistry(IServiceProvider serviceProvider, ILogger<ToolRegistry> logger)
    {
        _serviceProvider = serviceProvider;
        _logger = logger;
        RegisterToolsFromAssembly(serviceProvider, Assembly.GetExecutingAssembly());
    }

    public void Register(ITool tool)
    {
        _tools[tool.Name] = new ToolEntry(tool.GetType(), tool);
        _logger.LogInformation("Registered tool: {ToolName}", tool.Name);
    }

    public ITool? GetTool(string name)
    {
        if (_tools.TryGetValue(name, out var entry))
        {
            try
            {
                return entry.GetInstance(_serviceProvider);
            }
            catch (Exception ex)
            {
                _logger.LogWarning(ex, "Failed to instantiate tool: {ToolType}", entry.Type.Name);
                return null;
            }
        }

        // 回退：按 ITool.Name 懒匹配。首次未命中时一次性建立 _nameIndex，之后同名调用 O(1)。
        var index = GetOrBuildNameIndex();
        if (index.TryGetValue(name, out var namedEntry))
        {
            try
            {
                return namedEntry.GetInstance(_serviceProvider);
            }
            catch (Exception ex)
            {
                _logger.LogWarning(ex, "Failed to instantiate tool: {ToolType}", namedEntry.Type.Name);
                return null;
            }
        }

        return null;
    }

    private Dictionary<string, ToolEntry> GetOrBuildNameIndex()
    {
        if (_nameIndex != null)
            return _nameIndex;

        lock (_nameIndexLock)
        {
            if (_nameIndex != null)
                return _nameIndex;

            var index = new Dictionary<string, ToolEntry>(StringComparer.OrdinalIgnoreCase);
            foreach (var candidate in _tools.Values)
            {
                try
                {
                    var tool = candidate.GetInstance(_serviceProvider);
                    if (!index.ContainsKey(tool.Name))
                    {
                        index[tool.Name] = candidate;
                    }
                    else
                    {
                        _logger.LogWarning("Duplicate tool name detected, first wins: {ToolName} ({ExistingType} vs {NewType})",
                            tool.Name, index[tool.Name].Type.Name, candidate.Type.Name);
                    }
                }
                catch (Exception ex)
                {
                    _logger.LogWarning(ex, "Failed to instantiate tool: {ToolType}", candidate.Type.Name);
                }
            }

            _nameIndex = index;
            return index;
        }
    }

    public IReadOnlyCollection<ITool> GetAllTools()
    {
        return _tools.Values
            .Select(e =>
            {
                try
                {
                    return e.GetInstance(_serviceProvider);
                }
                catch (Exception ex)
                {
                    _logger.LogWarning(ex, "Failed to instantiate tool: {ToolType}", e.Type.Name);
                    return null;
                }
            })
            .Where(t => t != null)
            .Cast<ITool>()
            .ToList();
    }

    public IReadOnlyCollection<Type> GetAllToolTypes()
    {
        return _tools.Values.Select(e => e.Type).ToList();
    }

    public List<ToolDefinition> GetToolDefinitions(string language = "zh", string? systemCode = null)
    {
        var isEn = language.Equals("en", StringComparison.OrdinalIgnoreCase);
        var tools = GetAllTools();
        var filteredTools = FilterBySystem(tools, systemCode);
        return filteredTools.Select(t => new ToolDefinition
        {
            Type = "function",
            Function = new FunctionDefinition
            {
                Name = t.Name,
                Description = isEn ? t.DescriptionEn : t.Description,
                Parameters = t.Parameters.Function.Parameters
            }
        }).ToList();
    }

    private static IEnumerable<ITool> FilterBySystem(IEnumerable<ITool> tools, string? systemCode)
    {
        // 域过滤规则统一收敛到 DomainCatalog（与 CapabilityService 共用，避免两处漂移）。
        if (systemCode?.Equals("local", StringComparison.OrdinalIgnoreCase) == true)
        {
            // 修复：此前 local 在 ToolRegistry 未过滤，会把全部 MES 工具定义暴露给本地模式
            return tools.Where(t => DomainCatalog.IsLocalToolType(t.GetType())
                                 || DomainCatalog.UniversalTools.Contains(t.Name));
        }

        return DomainCatalog.FilterBySystem(tools, systemCode);
    }

    public async Task<ToolResult> InvokeAsync(string toolName, JsonObject args, ToolContext ctx)
    {
        var tool = GetTool(toolName);
        if (tool == null)
        {
            return ToolResult.Fail($"Tool '{toolName}' not found.");
        }

        // 执行期域隔离（fail-close）：与 ToolExecutionService 同一套判定，
        // 防止后端对话路径按名直接调用跨域工具。
        if (!DomainCatalog.IsToolVisibleToSystem(tool, ctx.SystemCode))
        {
            return ToolResult.Fail(
                $"工具 '{toolName}' 不属于当前登录域（{ctx.SystemCode}），已按域隔离策略拒绝执行。" +
                "请通过 list_capabilities 查看当前域可用工具。");
        }

        try
        {
            return await tool.InvokeAsync(args, ctx);
        }
        catch (Exception ex)
        {
            _logger.LogError(ex, "Tool invocation failed: {ToolName}", toolName);
            return ToolResult.Fail($"Tool execution error: {ex.Message}");
        }
    }

    private void RegisterToolsFromAssembly(IServiceProvider serviceProvider, Assembly assembly)
    {
        Type[] types;
        try
        {
            types = assembly.GetTypes();
        }
        catch (ReflectionTypeLoadException ex)
        {
            types = ex.Types.Where(t => t != null).ToArray();
            _logger.LogWarning(ex, "Assembly.GetTypes() failed with {Count} loader exceptions", ex.LoaderExceptions?.Length ?? 0);
        }

        var toolTypes = types
            .Where(t => t != null && t.IsClass && !t.IsAbstract && typeof(ITool).IsAssignableFrom(t!));

        _logger.LogInformation("Scanning assembly for tools: found {TotalTypes} types, {ToolTypes} ITool implementations", types.Length, toolTypes.Count());

        foreach (var type in toolTypes)
        {
            // 延迟实例化：先只记录类型，首次使用时再通过 DI 创建实例。
            // 这样避免了启动/能力发现阶段因某个工具依赖不可用（如 DB/网络）而阻塞。
            // 若 attribute 显式声明了 ToolName，则直接用它作为索引键。
            var attr = type.GetCustomAttribute<ToolCatalogMetadataAttribute>();
            var key = attr?.ToolName ?? type.Name;
            _tools[key] = new ToolEntry(type, instance: null);
        }
    }

    /// <summary>
    /// 工具条目：保存工具类型，并按需创建实例。避免在注册阶段一次性实例化全部工具。
    /// </summary>
    private class ToolEntry
    {
        private readonly object _lock = new();
        private ITool? _instance;

        public Type Type { get; }

        public ToolEntry(Type type, ITool? instance)
        {
            Type = type;
            _instance = instance;
        }

        public ITool GetInstance(IServiceProvider serviceProvider)
        {
            if (_instance != null)
                return _instance;

            lock (_lock)
            {
                if (_instance != null)
                    return _instance;

                var tool = (ITool?)ActivatorUtilities.CreateInstance(serviceProvider, Type)
                    ?? throw new InvalidOperationException($"ActivatorUtilities.CreateInstance returned null for tool type {Type.FullName}");

                _instance = tool;
                return _instance;
            }
        }
    }
}
