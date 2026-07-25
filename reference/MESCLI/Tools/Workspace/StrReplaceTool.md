using System.Text.Json.Nodes;
using AIGateway.Models;
using AIGateway.Services;

namespace AIGateway.Tools.Workspace;

/// <summary>
/// 精确替换已有文件中的子串（/local/str_replace）。
/// </summary>
[ToolCatalogMetadata(
    Category = "local",
    Path = "/local/str_replace",
    ToolName = "str_replace",
    Tier = ToolTier.Primitive,
    LoadStrategy = ToolLoadStrategy.AlwaysLoad,
    RiskLevel = "normal",
    IsReadOnly = false,
    IsConcurrencySafe = false,
    IsDestructive = false,
    OperationType = ToolOperationType.Write,
    ApprovalMode = ApprovalMode.Explicit,
    RequiresApproval = true,
    ImpactStatement = "将修改文件 {path} 中的指定内容。",
    Idempotent = false,
    DefaultTimeoutMs = 10000,
    Description = "精确替换 /workspace/ 下已有文件中的 old_string 为 new_string。"
)]
public class StrReplaceTool : ITool
{
    private readonly IWorkspaceFileService _workspaceFileService;
    private readonly ILogger<StrReplaceTool> _logger;

    public string Name => "str_replace";

    public string Description =>
        "精确替换已有文件中的 old_string 为 new_string。old_string 必须在文件中唯一存在（除非 replace_all=true）。编辑前建议先用 read_file 查看内容。path 必须以 /workspace/ 开头。";

    public string DescriptionEn =>
        "Replace old_string with new_string in an existing file. old_string must occur exactly once unless replace_all=true. Read the file first to confirm the exact text.";

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
                ["required"] = new JsonArray { "path", "old_string", "new_string" },
                ["properties"] = new JsonObject
                {
                    ["path"] = new JsonObject
                    {
                        ["type"] = "string",
                        ["description"] = "文件路径，例如 /workspace/scripts/etl.py"
                    },
                    ["old_string"] = new JsonObject
                    {
                        ["type"] = "string",
                        ["description"] = "要被替换的精确子字符串"
                    },
                    ["new_string"] = new JsonObject
                    {
                        ["type"] = "string",
                        ["description"] = "用于替换的新子字符串"
                    },
                    ["replace_all"] = new JsonObject
                    {
                        ["type"] = "boolean",
                        ["description"] = "是否替换所有匹配项，默认 false",
                        ["default"] = false
                    }
                }
            }
        }
    };

    public StrReplaceTool(IWorkspaceFileService workspaceFileService, ILogger<StrReplaceTool> logger)
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

        var oldString = args["old_string"]?.GetValue<string>();
        if (oldString == null)
        {
            return ToolResult.Fail("缺少 old_string 参数。");
        }

        var newString = args["new_string"]?.GetValue<string>();
        if (newString == null)
        {
            return ToolResult.Fail("缺少 new_string 参数。");
        }

        var replaceAll = args["replace_all"]?.GetValue<bool?>() ?? false;

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

            var readResponse = await _workspaceFileService.ReadAsync(path, ctx.CancellationToken);
            if (!readResponse.IsText)
            {
                return ToolResult.Fail($"文件 {path} 不是文本文件，无法使用 str_replace。");
            }

            var content = readResponse.Content ?? string.Empty;
            var occurrences = CountOccurrences(content, oldString);

            if (occurrences == 0)
            {
                var fail = ToolResult.Fail($"无法替换：old_string 在 {path} 中未找到。请先用 read_file 确认当前内容。");
                fail.StructuredData = new JsonObject
                {
                    ["error_type"] = "old_string_not_found",
                    ["path"] = path,
                    ["old_string"] = oldString
                };
                return fail;
            }

            if (occurrences > 1 && !replaceAll)
            {
                var fail = ToolResult.Fail(
                    $"old_string 在 {path} 中出现 {occurrences} 次，存在歧义。请在 old_string 中包含更多上下文以精确定位，或设置 replace_all=true 替换全部。");
                fail.StructuredData = new JsonObject
                {
                    ["error_type"] = "ambiguous_match",
                    ["path"] = path,
                    ["occurrences"] = occurrences
                };
                return fail;
            }

            var newContent = replaceAll
                ? content.Replace(oldString, newString, StringComparison.Ordinal)
                : ReplaceFirst(content, oldString, newString);

            var node = await _workspaceFileService.WriteAsync(path, newContent, writeCtx, append: false, ctx.CancellationToken);

            var previewLength = Math.Min(200, newContent.Length);
            var preview = newContent[..previewLength].Replace("\n", " ", StringComparison.Ordinal);

            var replacements = replaceAll ? occurrences : 1;
            var structured = new JsonObject
            {
                ["path"] = node.Path,
                ["replacements"] = replacements,
                ["sizeBytes"] = node.SizeBytes,
                ["preview"] = preview
            };

            return ToolResult.Ok(
                $"已在 {path} 中替换 {replacements} 处。新内容预览：\n{preview}...",
                structured);
        }
        catch (FileNotFoundException)
        {
            return ToolResult.Fail($"文件不存在: {path}");
        }
        catch (Exception ex)
        {
            _logger.LogWarning(ex, "str_replace 失败: {Path}", path);
            return ToolResult.Fail($"替换失败: {ex.Message}");
        }
    }

    private static int CountOccurrences(string content, string target)
    {
        var count = 0;
        var index = 0;
        while ((index = content.IndexOf(target, index, StringComparison.Ordinal)) != -1)
        {
            count++;
            index += target.Length;
        }
        return count;
    }

    private static string ReplaceFirst(string content, string oldValue, string newValue)
    {
        var index = content.IndexOf(oldValue, StringComparison.Ordinal);
        if (index == -1) return content;
        return content[..index] + newValue + content[(index + oldValue.Length)..];
    }
}
