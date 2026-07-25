using System.IO;
using System.Text;
using System.Text.Json.Nodes;
using AIGateway.Models;
using AIGateway.Services;

namespace AIGateway.Tools.Code;

/// <summary>
/// 在隔离沙盒中执行 Python 脚本（/code/python）。
/// TODO(M1-demo): 当前版本要求脚本通过 os.environ['OUTPUT_PATH'] 保存输出文件；
/// 后续应支持纯 stdout 脚本并自动落盘，同时保持错误原样返回让模型自纠。
/// </summary>
[ToolCatalogMetadata(
    Category = "code",
    Path = "/code/python",
    ToolName = "execute_python_script",
    Tier = ToolTier.Primitive,
    LoadStrategy = ToolLoadStrategy.Deferred,
    RiskLevel = "normal",
    IsReadOnly = false,
    IsConcurrencySafe = false,
    IsDestructive = false,
    OperationType = ToolOperationType.Mixed,
    ApprovalMode = ApprovalMode.Auto,
    RequiresApproval = false,
    Idempotent = false,
    DefaultTimeoutMs = 30000,
    Scopes = new[] { "code", "python" },
    Tags = new[] { "code", "python", "sandbox" },
    Description = "在隔离沙盒中执行 Python 脚本。脚本可通过 os.environ['OUTPUT_PATH'] 保存结果文件，stdout 会随结果一起返回。"
)]
public class ExecutePythonScriptTool : ITool
{
    private readonly PythonSandboxService _sandbox;
    private readonly IWorkspaceFileService _workspaceFileService;
    private readonly ILogger<ExecutePythonScriptTool> _logger;

    public string Name => "execute_python_script";

    public string Description =>
        "在隔离沙盒中执行 Python 脚本。脚本可通过 os.environ['OUTPUT_PATH'] 保存主结果文件，stdout 会随结果一起返回。" +
        "如果需要处理已有工作区文件，请在 input_files 中声明（支持 /workspace/ 和 /project/ 虚拟路径），脚本从 os.environ['WONWORK_INPUT_DIR'] 读取；" +
        "辅助产物可写到 os.environ['WONWORK_OUTPUT_DIR']，系统会自动扫描并持久化到工作区。" +
        "重要：/workspace 是 WonWork 的虚拟路径前缀，不是沙箱内的 OS 路径；脚本中写 '/workspace/sync/x' 会落到磁盘根目录（如 D:\\workspace），前端工具读不到。" +
        "沙箱内读写工作区一律用 os.environ['WONWORK_WORKSPACE_ROOT'] 拼接，例如 os.path.join(os.environ['WONWORK_WORKSPACE_ROOT'], 'sync', 'x') 对应虚拟路径 /workspace/sync/x（可读写）。" +
        "若用户已选择项目，os.environ['WONWORK_PROJECT_DIR'] 是项目目录的真实路径（对应虚拟路径 /project/，可读写；未选择项目时该变量不存在，用 os.environ.get('WONWORK_PROJECT_DIR') 判空）。" +
        "如果需要额外 Python 包，请在 pip_packages 中列出，沙箱会在执行前自动安装。";

    public string DescriptionEn =>
        "Execute a Python script in an isolated sandbox. The script can save the primary result via os.environ['OUTPUT_PATH']; stdout is returned along with the result. " +
        "To process existing workspace files, declare them in input_files (both /workspace/ and /project/ virtual paths are supported) and read them from os.environ['WONWORK_INPUT_DIR']. " +
        "Auxiliary outputs can be written to os.environ['WONWORK_OUTPUT_DIR'] and will be automatically scanned and persisted to the workspace. " +
        "IMPORTANT: /workspace is WonWork's virtual path prefix, NOT an OS path inside the sandbox; writing '/workspace/sync/x' lands on the drive root (e.g. D:\\workspace) where frontend tools cannot see it. " +
        "Always join paths with os.environ['WONWORK_WORKSPACE_ROOT'], e.g. os.path.join(os.environ['WONWORK_WORKSPACE_ROOT'], 'sync', 'x') for virtual path /workspace/sync/x (read-write). " +
        "When the user has selected a project, os.environ['WONWORK_PROJECT_DIR'] holds its real path (virtual path /project/, read-write; the variable is absent when no project is selected — check with os.environ.get('WONWORK_PROJECT_DIR')). " +
        "If additional Python packages are needed, list them in pip_packages and the sandbox will install them before execution.";

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
                ["required"] = new JsonArray { "python_code" },
                ["properties"] = new JsonObject
                {
                    ["python_code"] = new JsonObject
                    {
                        ["type"] = "string",
                        ["description"] = "要执行的 Python 脚本。需要保存主文件时，请使用 os.environ['OUTPUT_PATH'] 作为输出路径；需要读取已有工作区文件时，可通过 input_files 声明并在 os.environ['WONWORK_INPUT_DIR'] 下读取；辅助产物可写到 os.environ['WONWORK_OUTPUT_DIR']。例如：\nimport os\nwith open(os.environ['OUTPUT_PATH'], 'w') as f:\n    f.write('hello')"
                    },
                    ["output_extension"] = new JsonObject
                    {
                        ["type"] = "string",
                        ["description"] = "输出文件扩展名，默认 txt。脚本保存主文件时应与扩展名一致。",
                        ["default"] = "txt"
                    },
                    ["input_files"] = new JsonObject
                    {
                        ["type"] = "array",
                        ["description"] = "执行前需要映射进沙箱的文件虚拟路径列表（支持 /workspace/ 与 /project/），例如 [\"/workspace/uploads/20260709/data.xlsx\", \"/project/data/spec.md\"]。脚本中可通过 os.environ['WONWORK_INPUT_DIR'] 读取这些文件。",
                        ["items"] = new JsonObject
                        {
                            ["type"] = "string"
                        }
                    },
                    ["pip_packages"] = new JsonObject
                    {
                        ["type"] = "array",
                        ["description"] = "执行前需要额外安装的 Python 包列表，例如 ['pandas', 'markdown']。常用轻量包（pandas/openpyxl/python-docx/python-pptx/Pillow/requests/beautifulsoup4/markdown/matplotlib）通常已预装。",
                        ["items"] = new JsonObject
                        {
                            ["type"] = "string"
                        }
                    },
                    ["save_as_script"] = new JsonObject
                    {
                        ["type"] = "boolean",
                        ["description"] = "是否将本次执行的 Python 脚本源码保存为 /workspace/scripts/ 下的可复用资产，默认 false",
                        ["default"] = false
                    },
                    ["script_name"] = new JsonObject
                    {
                        ["type"] = "string",
                        ["description"] = "保存脚本时使用的基础文件名，默认 'script'。最终文件名为 {script_name}_{timestamp}.py",
                        ["default"] = "script"
                    }
                }
            }
        }
    };

    public ExecutePythonScriptTool(PythonSandboxService sandbox, IWorkspaceFileService workspaceFileService, ILogger<ExecutePythonScriptTool> logger)
    {
        _sandbox = sandbox;
        _workspaceFileService = workspaceFileService;
        _logger = logger;
    }

    public async Task<ToolResult> InvokeAsync(JsonObject args, ToolContext ctx)
    {
        var code = args["python_code"]?.GetValue<string>();
        if (string.IsNullOrWhiteSpace(code))
        {
            return ToolResult.Fail("python_code 不能为空。");
        }

        var outputExtension = args["output_extension"]?.GetValue<string>() ?? "txt";
        if (outputExtension.StartsWith('.'))
            outputExtension = outputExtension[1..];

        var pipPackages = args["pip_packages"] is JsonArray pipArr
            ? pipArr.Select(x => x?.GetValue<string>() ?? string.Empty)
                   .Where(s => !string.IsNullOrWhiteSpace(s))
                   .ToArray()
            : null;

        var inputFiles = args["input_files"] is JsonArray inputArr
            ? inputArr.Select(x => x?.GetValue<string>() ?? string.Empty)
                      .Where(s => !string.IsNullOrWhiteSpace(s))
                      .ToList()
            : new List<string>();

        var saveAsScript = args["save_as_script"]?.GetValue<bool?>() ?? false;
        var scriptName = args["script_name"]?.GetValue<string>() ?? "script";

        var physicalInputFiles = new List<string>();
        foreach (var virtualPath in inputFiles)
        {
            try
            {
                physicalInputFiles.Add(ResolveAndValidateInputPath(virtualPath));
            }
            catch (Exception ex)
            {
                return ToolResult.Fail($"input_files 中的路径无效：{virtualPath}，{ex.Message}");
            }
        }

        // TODO(M1-demo): 当脚本未引用 OUTPUT_PATH 时，自动追加 stdout 落盘逻辑，方便纯计算类脚本。
        var wrappedCode = WrapCodeIfNeeded(code);

        try
        {
            var result = await _sandbox.ExecuteAsync(
                wrappedCode, outputExtension, pipPackages, physicalInputFiles.ToArray(), onOutputLine: null, ctx.CancellationToken);

            if (!result.Success)
            {
                var errorStructured = new JsonObject
                {
                    ["success"] = false,
                    ["stdout"] = result.Stdout,
                    ["stderr"] = result.Stderr,
                    ["exit_code"] = result.ExitCode,
                    ["error_message"] = result.ErrorMessage
                };
                var fail = ToolResult.Fail(result.ErrorMessage ?? "Python 脚本执行失败，未返回错误信息。");
                fail.StructuredData = errorStructured;
                return fail;
            }

            string? workspacePath = null;
            var workspaceFiles = new JsonArray();
            var primaryFileName = $"output.{outputExtension}";
            SandboxResult.OutputFile? primaryOutput = null;

            foreach (var outputFile in result.OutputFiles)
            {
                try
                {
                    var baseName = SanitizeFileName(Path.GetFileNameWithoutExtension(outputFile.FileName));
                    var (virtualPath, _) = _workspaceFileService.ResolveGeneratedPath(outputFile.Extension, baseName);
                    var writeCtx = new WorkspaceWriteContext(Source: "execute_python_script", ToolName: "execute_python_script");
                    await _workspaceFileService.WriteBytesAsync(virtualPath, outputFile.Bytes, writeCtx, append: false, ctx.CancellationToken);

                    workspaceFiles.Add(new JsonObject
                    {
                        ["path"] = virtualPath,
                        ["sizeBytes"] = outputFile.Bytes.Length,
                        ["mimeType"] = GetMimeType(outputFile.Extension),
                        ["sourceTool"] = "execute_python_script"
                    });

                    if (outputFile.FileName.Equals(primaryFileName, StringComparison.OrdinalIgnoreCase))
                    {
                        workspacePath = virtualPath;
                        primaryOutput = outputFile;
                    }
                }
                catch (Exception ex)
                {
                    _logger.LogWarning(ex, "Python 产物文件 {FileName} 持久化到工作区失败", outputFile.FileName);
                }
            }

            string? scriptPath = null;
            if (saveAsScript)
            {
                try
                {
                    var (scriptVirtualPath, _) = _workspaceFileService.ResolveScriptPath(scriptName);
                    var scriptWriteCtx = new WorkspaceWriteContext(Source: "execute_python_script", ToolName: "execute_python_script");
                    await _workspaceFileService.WriteAsync(scriptVirtualPath, code, scriptWriteCtx, append: false, ctx.CancellationToken);
                    scriptPath = scriptVirtualPath;

                    workspaceFiles.Add(new JsonObject
                    {
                        ["path"] = scriptVirtualPath,
                        ["sizeBytes"] = Encoding.UTF8.GetByteCount(code),
                        ["mimeType"] = "text/x-python",
                        ["sourceTool"] = "execute_python_script"
                    });
                }
                catch (Exception ex)
                {
                    _logger.LogWarning(ex, "Python 脚本源码持久化到 /workspace/scripts/ 失败");
                }
            }

            var primaryBytes = primaryOutput?.Bytes ?? result.FileBytes ?? Array.Empty<byte>();
            var fileSize = primaryBytes.Length;
            var isTextOutput = IsTextExtension(outputExtension);
            var text = fileSize > 0
                ? (isTextOutput ? Encoding.UTF8.GetString(primaryBytes) : $"二进制 {outputExtension} 文件，大小 {fileSize} bytes。")
                : "";

            var structured = new JsonObject
            {
                ["success"] = true,
                ["stdout"] = result.Stdout,
                ["stderr"] = result.Stderr,
                ["output_extension"] = outputExtension,
                ["file_size_bytes"] = fileSize,
                ["output_text"] = text,
                ["workspace_path"] = workspacePath,
                ["script_path"] = scriptPath,
                ["workspaceFiles"] = workspaceFiles
            };

            var summary = $"Python 脚本执行成功。\n\n[stdout]\n{result.Stdout}\n\n[输出文件]\n";
            summary += fileSize > 0
                ? $"主文件已保存到 {workspacePath ?? "沙箱临时目录"}，大小：{fileSize} bytes。"
                : "未生成输出文件。";
            if (workspaceFiles.Count > 1)
            {
                summary += $"\n另有 {workspaceFiles.Count - 1} 个辅助产物已同步到工作区。";
            }
            if (!string.IsNullOrEmpty(scriptPath))
            {
                summary += $"\n脚本已保存到 {scriptPath}，可后续读取、修改并复用。";
            }

            return ToolResult.Ok(summary, structured);
        }
        catch (Exception ex)
        {
            _logger.LogError(ex, "ExecutePythonScript failed");
            return ToolResult.Fail($"Python 脚本执行异常: {ex.Message}");
        }
    }

    private string ResolveAndValidateInputPath(string virtualPath)
    {
        if (string.IsNullOrWhiteSpace(virtualPath))
            throw new ArgumentException("路径不能为空");

        // 统一走 WorkspaceFileService 的双根路由与越界校验（打磨任务2 S4，
        // 消除复制的单根逻辑，同时放行 /project/ 前缀——项目文件可作沙箱输入）
        var physicalPath = _workspaceFileService.ResolvePhysicalPath(virtualPath);

        if (!File.Exists(physicalPath))
            throw new FileNotFoundException($"文件不存在: {virtualPath}");

        return physicalPath;
    }

    private static string SanitizeFileName(string fileName)
    {
        var name = System.Text.RegularExpressions.Regex.Replace(fileName, "[<>:\"\\\\|?*\x00-\x1f]", "_");
        name = System.Text.RegularExpressions.Regex.Replace(name, "\\.{2,}", "_");
        if (string.IsNullOrWhiteSpace(name))
            name = "output";
        return name;
    }

    private static string WrapCodeIfNeeded(string code)
    {
        if (code.Contains("OUTPUT_PATH", StringComparison.OrdinalIgnoreCase))
            return code;

        // 脚本未显式使用 OUTPUT_PATH 时，自动将 stdout 重定向到输出文件，降低使用门槛。
        return $@"import os
import sys
from io import StringIO
_stdout_buffer = StringIO()
_original_stdout = sys.stdout
sys.stdout = _stdout_buffer
{code}
sys.stdout = _original_stdout
with open(os.environ['OUTPUT_PATH'], 'w', encoding='utf-8') as _f:
    _f.write(_stdout_buffer.getvalue())
";
    }

    private static bool IsTextExtension(string extension)
    {
        var ext = extension.StartsWith('.') ? extension : '.' + extension;
        return ext.Equals(".txt", StringComparison.OrdinalIgnoreCase)
            || ext.Equals(".md", StringComparison.OrdinalIgnoreCase)
            || ext.Equals(".json", StringComparison.OrdinalIgnoreCase)
            || ext.Equals(".csv", StringComparison.OrdinalIgnoreCase)
            || ext.Equals(".py", StringComparison.OrdinalIgnoreCase)
            || ext.Equals(".html", StringComparison.OrdinalIgnoreCase)
            || ext.Equals(".xml", StringComparison.OrdinalIgnoreCase)
            || ext.Equals(".yaml", StringComparison.OrdinalIgnoreCase)
            || ext.Equals(".yml", StringComparison.OrdinalIgnoreCase)
            || ext.Equals(".log", StringComparison.OrdinalIgnoreCase);
    }

    private static string GetMimeType(string extension)
    {
        var ext = extension.StartsWith('.') ? extension : '.' + extension;
        return ext.ToLowerInvariant() switch
        {
            ".docx" => "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
            ".xlsx" => "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
            ".pptx" => "application/vnd.openxmlformats-officedocument.presentationml.presentation",
            ".pdf" => "application/pdf",
            ".png" => "image/png",
            ".jpg" or ".jpeg" => "image/jpeg",
            ".gif" => "image/gif",
            ".webp" => "image/webp",
            ".txt" => "text/plain",
            ".md" => "text/markdown",
            ".json" => "application/json",
            ".csv" => "text/csv",
            ".html" => "text/html",
            ".py" => "text/x-python",
            _ => "application/octet-stream"
        };
    }
}
