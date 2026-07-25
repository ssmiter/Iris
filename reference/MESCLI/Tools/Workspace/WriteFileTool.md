using System.Text.Json.Nodes;
using AIGateway.Models;
using AIGateway.Services;

namespace AIGateway.Tools.Workspace;

/// <summary>
/// 写入或创建工作区文件（/local/write_file）。
/// </summary>
[ToolCatalogMetadata(
    Category = "local",
    Path = "/local/write_file",
    ToolName = "write_file",
    Tier = ToolTier.Primitive,
    LoadStrategy = ToolLoadStrategy.AlwaysLoad,
    RiskLevel = "normal",
    IsReadOnly = false,
    IsConcurrencySafe = false,
    IsDestructive = false,
    OperationType = ToolOperationType.Write,
    ApprovalMode = ApprovalMode.Explicit,
    RequiresApproval = true,
    ImpactStatement = "将向 {path} 写入/覆盖文件内容。",
    Idempotent = false,
    DefaultTimeoutMs = 10000,
    Description = "创建或覆盖 /workspace/ 下的文本文件，支持追加。"
)]
public class WriteFileTool : ITool
{
    private readonly IWorkspaceFileService _workspaceFileService;
    private readonly ILogger<WriteFileTool> _logger;

    public string Name => "write_file";

    public string Description =>
        "写入或创建工作区文件。path 必须以 /workspace/ 开头。创建新文件时可省略 expected_content；" +
        "覆盖已有文件时，建议先使用 read_file 读取当前内容，并在 expected_content 字段回传，防止意外覆盖。" +
        "支持 append 追加模式。内容较长（>4000 字符）时，建议通过本工具保存为文件后，让 execute_python_script 用短代码读取执行，避免 JSON 截断。";

    public string DescriptionEn =>
        "Write or create a workspace file. path must start with /workspace/. When creating a new file, expected_content can be omitted; " +
        "when overwriting an existing file, read it first and pass the content back as expected_content to avoid accidental overwrites. " +
        "Supports append mode. For long content (>4000 chars), save it via this tool first and let execute_python_script read it with a short script to avoid JSON truncation.";

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
                ["required"] = new JsonArray { "path", "content" },
                ["properties"] = new JsonObject
                {
                    ["path"] = new JsonObject
                    {
                        ["type"] = "string",
                        ["description"] = "文件路径，例如 /workspace/output/result.md"
                    },
                    ["content"] = new JsonObject
                    {
                        ["type"] = "string",
                        ["description"] = "要写入的文件内容"
                    },
                    ["append"] = new JsonObject
                    {
                        ["type"] = "boolean",
                        ["description"] = "是否追加到文件末尾，默认为 false",
                        ["default"] = false
                    },
                    ["expected_content"] = new JsonObject
                    {
                        ["type"] = "string",
                        ["description"] = "覆盖前 read_file 读取到的完整内容，用于防止并发覆盖。创建新文件或追加写入时可省略。"
                    }
                }
            }
        }
    };

    public WriteFileTool(IWorkspaceFileService workspaceFileService, ILogger<WriteFileTool> logger)
    {
        _workspaceFileService = workspaceFileService;
        _logger = logger;
    }

    public async Task<ToolResult> InvokeAsync(JsonObject args, ToolContext ctx)
    {
        var path = args["path"]?.GetValue<string>();
        if (string.IsNullOrWhiteSpace(path))
        {
            return ToolResult.Fail("缺少 path 参数，必须提供以 /workspace/ 开头的文件路径。");
        }

        var content = args["content"]?.GetValue<string>();
        if (content == null)
        {
            return ToolResult.Fail("缺少 content 参数。");
        }

        var append = args["append"]?.GetValue<bool?>() ?? false;
        var expectedContent = args["expected_content"]?.GetValue<string>();

        var writeCtx = new WorkspaceWriteContext(
            ToolName: Name,
            Source: "tool",
            ConversationId: ctx.ConversationId?.ToString(),
            UserId: ctx.UserId.ToString(),
            UserName: ctx.UserName);

        try
        {
            if (!await _workspaceFileService.AuthorizeAsync(path, WriteIntent.Overwrite, writeCtx, ctx.CancellationToken))
            {
                return ToolResult.Fail("文件写操作未通过授权校验。");
            }

            // 可选的 expected_content 并发检查
            if (!append && !string.IsNullOrEmpty(expectedContent))
            {
                try
                {
                    var current = await _workspaceFileService.ReadAsync(path, ctx.CancellationToken);
                    if (current.Content != expectedContent)
                    {
                        var preview = (current.Content ?? string.Empty)[..Math.Min(200, (current.Content ?? string.Empty).Length)]
                            .Replace("\n", " ", StringComparison.Ordinal);
                        return ToolResult.Fail(
                            $"文件 {path} 自上次读取后已发生变化。当前内容开头: \"{preview}...\"，请重新 read_file 并更新 expected_content。");
                    }
                }
                catch (FileNotFoundException)
                {
                    // 文件还不存在，expected_content 无意义，继续创建
                }
            }

            var node = await _workspaceFileService.WriteAsync(path, content, writeCtx, append, ctx.CancellationToken);

            var action = append ? "appended" : "written";
            var structured = new JsonObject
            {
                ["path"] = node.Path,
                ["sizeBytes"] = node.SizeBytes,
                ["mimeType"] = node.MimeType,
                ["action"] = action
            };

            return ToolResult.Ok(
                $"文件已成功 {action}：{node.Path}，大小 {node.SizeBytes} bytes。",
                structured);
        }
        catch (Exception ex)
        {
            _logger.LogWarning(ex, "write_file 失败: {Path}", path);
            return ToolResult.Fail($"写入文件失败: {ex.Message}");
        }
    }
}
