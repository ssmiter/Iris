using System.Text.Json.Nodes;
using AIGateway.Models;
using AIGateway.Services;

namespace AIGateway.Tools.Workspace;

/// <summary>
/// 列出工作区目录内容（/local/list_files）。
/// </summary>
[ToolCatalogMetadata(
    Category = "local",
    Path = "/local/list_files",
    ToolName = "list_files",
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
    Description = "列出 /workspace/ 下的目录与文件，支持递归。"
)]
public class ListFilesTool : ITool
{
    private readonly IWorkspaceFileService _workspaceFileService;
    private readonly ILogger<ListFilesTool> _logger;

    public string Name => "list_files";

    public string Description =>
        "列出工作区目录下的文件和子目录。path 默认为 /workspace。可设置 recursive=true 递归列出所有文件。";

    public string DescriptionEn =>
        "List files and directories under a workspace path. Defaults to /workspace. Set recursive=true to list recursively.";

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
                ["properties"] = new JsonObject
                {
                    ["path"] = new JsonObject
                    {
                        ["type"] = "string",
                        ["description"] = "目录路径，例如 /workspace/scripts",
                        ["default"] = "/workspace"
                    },
                    ["recursive"] = new JsonObject
                    {
                        ["type"] = "boolean",
                        ["description"] = "是否递归列出子目录文件",
                        ["default"] = false
                    }
                }
            }
        }
    };

    public ListFilesTool(IWorkspaceFileService workspaceFileService, ILogger<ListFilesTool> logger)
    {
        _workspaceFileService = workspaceFileService;
        _logger = logger;
    }

    public async Task<ToolResult> InvokeAsync(JsonObject args, ToolContext ctx)
    {
        var path = args["path"]?.GetValue<string>() ?? "/workspace";
        var recursive = args["recursive"]?.GetValue<bool?>() ?? false;

        try
        {
            var files = new List<string>();
            var directories = new List<string>();

            await ListRecursiveAsync(path, recursive, files, directories, ctx.CancellationToken);

            var structured = new JsonObject
            {
                ["path"] = path,
                ["files"] = new JsonArray(files.Select(f => (JsonNode)f).ToArray()),
                ["directories"] = new JsonArray(directories.Select(d => (JsonNode)d).ToArray()),
                ["total"] = files.Count + directories.Count
            };

            var summary = $"目录 {path}：\n" +
                          $"  文件 ({files.Count}):\n" +
                          string.Join("\n", files.Select(f => $"    {f}")) +
                          (directories.Count > 0
                              ? "\n  目录 (" + directories.Count + "):\n" +
                                string.Join("\n", directories.Select(d => $"    {d}/"))
                              : string.Empty);

            return ToolResult.Ok(summary, structured);
        }
        catch (Exception ex)
        {
            _logger.LogWarning(ex, "list_files 失败: {Path}", path);
            return ToolResult.Fail($"列出目录失败: {ex.Message}");
        }
    }

    private async Task ListRecursiveAsync(
        string virtualPath,
        bool recursive,
        List<string> files,
        List<string> directories,
        CancellationToken ct)
    {
        var response = await _workspaceFileService.ListAsync(virtualPath, ct);

        foreach (var node in response.Nodes)
        {
            ct.ThrowIfCancellationRequested();

            if (node.Kind == WorkspaceNodeKind.Folder)
            {
                directories.Add(node.Path);
                if (recursive)
                {
                    await ListRecursiveAsync(node.Path, true, files, directories, ct);
                }
            }
            else
            {
                files.Add(node.Path);
            }
        }
    }
}
