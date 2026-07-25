using System.Text.Json.Nodes;
using AIGateway.Models;
using AIGateway.Services;

namespace AIGateway.Tools.Workspace;

/// <summary>
/// 删除工作区文件（/local/delete_file）。
/// </summary>
[ToolCatalogMetadata(
    Category = "local",
    Path = "/local/delete_file",
    ToolName = "delete_file",
    Tier = ToolTier.Primitive,
    LoadStrategy = ToolLoadStrategy.AlwaysLoad,
    RiskLevel = "dangerous",
    IsReadOnly = false,
    IsConcurrencySafe = false,
    IsDestructive = true,
    OperationType = ToolOperationType.Write,
    ApprovalMode = ApprovalMode.Explicit,
    RequiresApproval = true,
    ImpactStatement = "将删除工作区文件 {path}，此操作不可恢复。",
    Idempotent = true,
    DefaultTimeoutMs = 10000,
    Description = "删除 /workspace/ 下的文件。文件不存在时返回成功。"
)]
public class DeleteFileTool : ITool
{
    private readonly IWorkspaceFileService _workspaceFileService;
    private readonly ILogger<DeleteFileTool> _logger;

    public string Name => "delete_file";

    public string Description =>
        "删除工作区文件。path 必须以 /workspace/ 开头。此操作不可恢复，请谨慎使用。文件不存在时也返回成功。";

    public string DescriptionEn =>
        "Delete a workspace file. path must start with /workspace/. This action is irreversible. Returns success if the file does not exist.";

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
                        ["description"] = "要删除的文件路径，例如 /workspace/scripts/old.py"
                    }
                }
            }
        }
    };

    public DeleteFileTool(IWorkspaceFileService workspaceFileService, ILogger<DeleteFileTool> logger)
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

        var writeCtx = new WorkspaceWriteContext(
            ToolName: Name,
            Source: "tool",
            ConversationId: ctx.ConversationId?.ToString(),
            UserId: ctx.UserId.ToString(),
            UserName: ctx.UserName);

        try
        {
            if (!await _workspaceFileService.AuthorizeAsync(path, WriteIntent.Delete, writeCtx, ctx.CancellationToken))
            {
                return ToolResult.Fail("文件删除操作未通过授权校验。");
            }

            await _workspaceFileService.DeleteAsync(path, writeCtx, ctx.CancellationToken);

            var structured = new JsonObject
            {
                ["path"] = path,
                ["deleted"] = true
            };

            return ToolResult.Ok($"文件已删除：{path}", structured);
        }
        catch (FileNotFoundException)
        {
            var structured = new JsonObject
            {
                ["path"] = path,
                ["deleted"] = false,
                ["reason"] = "文件不存在"
            };
            return ToolResult.Ok($"文件不存在，无需删除：{path}", structured);
        }
        catch (Exception ex)
        {
            _logger.LogWarning(ex, "delete_file 失败: {Path}", path);
            return ToolResult.Fail($"删除文件失败: {ex.Message}");
        }
    }
}
