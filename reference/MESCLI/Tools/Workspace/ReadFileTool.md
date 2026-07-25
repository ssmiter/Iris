using System.Text.Json.Nodes;
using AIGateway.Models;
using AIGateway.Services;

namespace AIGateway.Tools.Workspace;

/// <summary>
/// 读取工作区文本文件内容（/local/read_file）。
/// </summary>
[ToolCatalogMetadata(
    Category = "local",
    Path = "/local/read_file",
    ToolName = "read_file",
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
    Description = "读取 /workspace/ 下的文本文件内容，可指定起始行和最大行数。"
)]
public class ReadFileTool : ITool
{
    private readonly IWorkspaceFileService _workspaceFileService;
    private readonly ILogger<ReadFileTool> _logger;

    public string Name => "read_file";

    public string Description =>
        "读取工作区文件内容。path 必须以 /workspace/ 开头。可指定 offset（从第几行开始，1-based）和 limit（最多读取多少行）以控制返回长度。";

    public string DescriptionEn =>
        "Read the content of a workspace file. path must start with /workspace/. Optionally specify offset (1-based) and limit to control the returned range.";

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
                        ["description"] = "文件路径，例如 /workspace/scripts/etl.py"
                    },
                    ["offset"] = new JsonObject
                    {
                        ["type"] = "integer",
                        ["description"] = "起始行号（1-based），可选"
                    },
                    ["limit"] = new JsonObject
                    {
                        ["type"] = "integer",
                        ["description"] = "最多读取行数，可选"
                    }
                }
            }
        }
    };

    public ReadFileTool(IWorkspaceFileService workspaceFileService, ILogger<ReadFileTool> logger)
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

        try
        {
            var readResponse = await _workspaceFileService.ReadAsync(path, ctx.CancellationToken);

            if (!readResponse.IsText)
            {
                return ToolResult.Fail($"文件 {path} 不是文本文件，无法直接读取。");
            }

            var content = readResponse.Content ?? string.Empty;
            var lines = content.Split('\n');
            var totalLines = lines.Length;

            var offset = args["offset"]?.GetValue<int?>() ?? 1;
            var limit = args["limit"]?.GetValue<int?>() ?? null;

            if (offset < 1) offset = 1;

            var slicedLines = lines
                .Skip(offset - 1)
                .Take(limit ?? int.MaxValue)
                .ToArray();

            var resultContent = string.Join("\n", slicedLines);
            var rangeInfo = (offset > 1 || limit.HasValue)
                ? $"（显示第 {offset} 行起共 {slicedLines.Length} 行 / 总计 {totalLines} 行）"
                : string.Empty;

            var structured = new JsonObject
            {
                ["path"] = readResponse.Path,
                ["content"] = resultContent,
                ["totalLines"] = totalLines,
                ["sizeBytes"] = readResponse.SizeBytes,
                ["mimeType"] = readResponse.MimeType
            };

            return ToolResult.Ok(
                $"[文件: {readResponse.Path}]{rangeInfo}\n{resultContent}",
                structured);
        }
        catch (FileNotFoundException)
        {
            return ToolResult.Fail($"文件不存在: {path}");
        }
        catch (Exception ex)
        {
            _logger.LogWarning(ex, "read_file 读取失败: {Path}", path);
            return ToolResult.Fail($"读取文件失败: {ex.Message}");
        }
    }
}
