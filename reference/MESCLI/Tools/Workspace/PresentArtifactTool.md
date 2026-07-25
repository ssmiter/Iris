using System.Text.Json.Nodes;
using AIGateway.Models;
using AIGateway.Services;

namespace AIGateway.Tools.Workspace;

/// <summary>
/// 把 workspace 中的产出文件以 Artifact 卡片形式呈现给用户。
/// 只读、无审批、无副作用；路径必须为 /workspace/ 下的文件。
/// </summary>
[ToolCatalogMetadata(
    Category = "local",
    Path = "/local/present_artifact",
    ToolName = "present_artifact",
    Tier = ToolTier.Primitive,
    LoadStrategy = ToolLoadStrategy.AlwaysLoad,
    RiskLevel = "safe",
    IsReadOnly = true,
    IsConcurrencySafe = true,
    IsDestructive = false,
    OperationType = ToolOperationType.Read,
    ApprovalMode = ApprovalMode.Auto,
    RequiresApproval = false,
    Idempotent = true,
    DefaultTimeoutMs = 10000,
    Description = "把 workspace 中的产出文件（图表、表格、文档）以卡片形式呈现给用户。")]
public class PresentArtifactTool : ITool
{
    private readonly IArtifactPreviewService _previewService;
    private readonly IWorkspaceItemService _workspaceItemService;
    private readonly ILogger<PresentArtifactTool> _logger;

    public string Name => "present_artifact";

    public string Description =>
        "把 workspace 中的产出文件以卡片形式呈现给用户。path 必须以 /workspace/ 开头；caption 必须是一句包含具体结论的说明，而不是\"这是一张图\"之类的占位描述。";

    public string DescriptionEn =>
        "Present a workspace artifact file to the user as a card. path must start with /workspace/; caption must be a one-sentence conclusion with concrete insight, not a placeholder like \"this is a chart\".";

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
                ["required"] = new JsonArray { "path" },
                ["properties"] = new JsonObject
                {
                    ["path"] = new JsonObject
                    {
                        ["type"] = "string",
                        ["description"] = "产物在工作区中的路径，必须以 /workspace/ 开头，推荐放在 /workspace/outputs/ 下，例如 /workspace/outputs/20260709/revenue_trend_12345678.png"
                    },
                    ["caption"] = new JsonObject
                    {
                        ["type"] = "string",
                        ["description"] = "一句具体的结论性说明，必须包含数据洞察，例如“近12个月营收趋势，Q3出现明显下滑，环比下降18%”。禁止写“这是一张图表”等占位描述。"
                    },
                    ["type"] = new JsonObject
                    {
                        ["type"] = "string",
                        ["enum"] = new JsonArray { "chart", "table", "document" },
                        ["description"] = "(可选) 产物类型提示，chart/table/document；后端会根据文件 mimeType 自动判断，可省略。"
                    },
                    ["groupId"] = new JsonObject
                    {
                        ["type"] = "string",
                        ["description"] = "(可选) 多产出物分组标识，当前版本透传但不影响渲染。"
                    }
                }
            }
        }
    };

    public PresentArtifactTool(IArtifactPreviewService previewService, IWorkspaceItemService workspaceItemService, ILogger<PresentArtifactTool> logger)
    {
        _previewService = previewService;
        _workspaceItemService = workspaceItemService;
        _logger = logger;
    }

    public async Task<ToolResult> InvokeAsync(JsonObject args, ToolContext ctx)
    {
        var path = args["path"]?.GetValue<string>();
        var caption = args["caption"]?.GetValue<string>();
        var typeHint = args["type"]?.GetValue<string>();

        if (string.IsNullOrWhiteSpace(path))
        {
            return ToolResult.Fail("缺少 path 参数，必须提供以 /workspace/ 开头的文件路径。");
        }

        if (!path.StartsWith("/workspace/", StringComparison.OrdinalIgnoreCase) || path.Contains(".."))
        {
            return ToolResult.Fail($"路径 {path} 不在 /workspace/ 下或包含非法 traversal，只允许呈现工作区内的文件。");
        }

        var effectiveCaption = string.IsNullOrWhiteSpace(caption) ? null : caption.Trim();
        var effectiveType = string.IsNullOrWhiteSpace(typeHint) ? null : typeHint.Trim();

        try
        {
            var preview = await _previewService.PreviewAsync(path, effectiveCaption, effectiveType, ctx.CancellationToken);

            // H3：会话-文件索引（presented）——呈现过的产物归集到当前会话，供预览坞水合还原
            if (ctx.ConversationId is > 0)
            {
                var mimeType = preview["mimeType"]?.GetValue<string>();
                long? sizeBytes = null;
                if (preview["sizeBytes"] is JsonValue sizeVal && sizeVal.TryGetValue<long>(out var sb))
                {
                    sizeBytes = sb;
                }
                await _workspaceItemService.RecordAsync(
                    ctx.ConversationId.Value,
                    ctx.UserId.ToString(),
                    path,
                    IWorkspaceItemService.Kinds.Presented,
                    caption: effectiveCaption,
                    mimeType: mimeType,
                    sizeBytes: sizeBytes,
                    source: Name,
                    ct: ctx.CancellationToken);
            }

            var summary = string.IsNullOrWhiteSpace(effectiveCaption) ? $"已呈现：{Path.GetFileName(path)}" : $"已呈现：{effectiveCaption}";
            return ToolResult.Ok(summary, preview);
        }
        catch (FileNotFoundException)
        {
            return ToolResult.Fail($"文件不存在：{path}");
        }
        catch (Exception ex)
        {
            _logger.LogWarning(ex, "present_artifact 预览失败: {Path}", path);
            return ToolResult.Fail($"无法预览文件 {path}：{ex.Message}");
        }
    }
}
