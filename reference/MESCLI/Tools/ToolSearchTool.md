using System.Text.Json.Nodes;
using AIGateway.Models;
using AIGateway.Services;

namespace AIGateway.Tools;

/// <summary>
/// 工具发现原语：模型可按关键词搜索后端可用工具。
/// 该工具本身必须始终注入默认工具集。
/// </summary>
[ToolCatalogMetadata(
    RiskLevel = "safe",
    IsReadOnly = true,
    Idempotent = true,
    Tier = ToolTier.Primitive,
    AlwaysLoad = true,
    LoadStrategy = ToolLoadStrategy.AlwaysLoad)]
public class ToolSearchTool : ITool
{
    private readonly CapabilityService _capabilityService;
    private readonly ILogger<ToolSearchTool> _logger;

    public string Name => "tool_search";

    public string Description =>
        "工具发现原语。当用户请求的操作不在当前可用工具列表中时，使用此工具按关键词搜索后端可用的工具。" +
        "只返回工具名称和描述，不返回完整参数 schema。";

    public ToolDefinition Parameters => new()
    {
        Type = "function",
        Function = new FunctionDefinition
        {
            Name = Name,
            Description = Description,
            Parameters = new JsonObject
            {
                ["type"] = "object",
                ["required"] = new JsonArray { "query" },
                ["properties"] = new JsonObject
                {
                    ["query"] = new JsonObject
                    {
                        ["type"] = "string",
                        ["description"] = "搜索关键词，可以是用户意图的简要描述，例如：'设备故障报表'、'查询成型计划'"
                    },
                    ["system_code"] = new JsonObject
                    {
                        ["type"] = "string",
                        ["description"] = "系统码，如 ykhm / iris / xyqz"
                    },
                    ["include_tiers"] = new JsonObject
                    {
                        ["type"] = "array",
                        ["description"] = "允许返回的工具层级，默认包含 domain_operation 和 primitive",
                        ["items"] = new JsonObject
                        {
                            ["type"] = "string",
                            ["enum"] = new JsonArray { "domain_operation", "primitive", "admin", "workflow" }
                        }
                    },
                    ["category"] = new JsonObject
                    {
                        ["type"] = "string",
                        ["description"] = "按分类过滤，如 mes / sql / web / report"
                    }
                }
            }
        }
    };

    public ToolSearchTool(CapabilityService capabilityService, ILogger<ToolSearchTool> logger)
    {
        _capabilityService = capabilityService;
        _logger = logger;
    }

    public Task<ToolResult> InvokeAsync(JsonObject args, ToolContext ctx)
    {
        var query = args["query"]?.GetValue<string>() ?? string.Empty;
        var systemCode = args["system_code"]?.GetValue<string>() ?? ctx.SystemCode;
        var category = args["category"]?.GetValue<string>();

        var includeTiers = new List<ToolTier> { ToolTier.DomainOperation, ToolTier.Primitive };
        if (args["include_tiers"] is JsonArray tiersArray)
        {
            includeTiers = tiersArray
                .Select(t => t?.GetValue<string>())
                .WhereNotNull()
                .Select(ParseTier)
                .Where(t => t.HasValue)
                .Select(t => t!.Value)
                .ToList();
        }

        _logger.LogInformation("ToolSearch: query='{Query}', systemCode='{SystemCode}', tiers=[{Tiers}]",
            query, systemCode, string.Join(", ", includeTiers));

        var response = _capabilityService.SearchTools(new ToolSearchRequest
        {
            Query = query,
            SystemCode = systemCode,
            IncludeTiers = includeTiers,
            Category = category
        });

        var structured = new JsonObject
        {
            ["query"] = query,
            ["count"] = response.Tools.Count,
            ["total"] = response.Total,
            ["tools"] = new JsonArray(response.Tools.Select(t => new JsonObject
            {
                ["name"] = t.Name,
                ["description"] = t.Description,
                ["tier"] = t.Tier?.ToString().ToLowerInvariant(),
                ["category"] = t.Category,
                ["load_strategy"] = t.LoadStrategy?.ToString().ToLowerInvariant(),
                ["path"] = t.Path
            }).ToArray<JsonNode>())
        };

        var summary = response.Tools.Count == 0
            ? $"未找到与 \"{query}\" 相关的工具。"
            : $"找到 {response.Total} 个相关工具（返回前 {response.Tools.Count} 个）：\n" +
              string.Join("\n", response.Tools.Select(t => $"- {t.Name}: {t.Description}（路径 {t.Path}）"));

        return Task.FromResult(ToolResult.Ok(summary, structured));
    }

    private static ToolTier? ParseTier(string? value)
    {
        if (Enum.TryParse<ToolTier>(value, true, out var tier))
            return tier;
        return null;
    }
}

internal static class ToolSearchToolExtensions
{
    public static IEnumerable<T> WhereNotNull<T>(this IEnumerable<T?> source) where T : class
    {
        return source.Where(x => x != null)!;
    }
}
