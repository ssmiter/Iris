using System.Diagnostics;

namespace AIGateway.Services;

/// <summary>
/// Python 沙盒执行上下文。
/// </summary>
public sealed record SandboxExecutionContext(
    string Code,
    string WorkDir,
    string WorkspaceRoot,
    string ScriptPath,
    string OutputPath,
    string OutputExtension,
    int TimeoutMs,
    Func<string, Task>? OnOutputLine,
    CancellationToken CancellationToken,
    string InputDir,
    string OutputDir,
    IReadOnlyDictionary<string, string>? AdditionalEnvironmentVariables = null,
    /// <summary>S4 项目模式：当前活跃项目根（宿主机路径）；null 表示未选择项目。</summary>
    string? ProjectDir = null);

/// <summary>
/// Python 沙盒执行器抽象。支持进程模式与 Docker 模式。
/// </summary>
public interface ISandboxExecutor
{
    string Name { get; }
    string? PythonExecutablePath { get; }
    Task<SandboxResult> ExecuteAsync(SandboxExecutionContext context);
}

/// <summary>
/// 基于本地 Python 进程的执行器。依赖宿主机安装的 Python 解释器。
/// </summary>
public sealed class ProcessSandboxExecutor : ISandboxExecutor
{
    private readonly string _pythonPath;
    private readonly ILogger<ProcessSandboxExecutor> _logger;

    public string Name => "process";

    public string? PythonExecutablePath => _pythonPath;

    public ProcessSandboxExecutor(string pythonPath, ILogger<ProcessSandboxExecutor> logger)
    {
        _pythonPath = pythonPath;
        _logger = logger;
    }

    public async Task<SandboxResult> ExecuteAsync(SandboxExecutionContext context)
    {
        var psi = new ProcessStartInfo
        {
            FileName = _pythonPath,
            Arguments = $"-u \"{context.ScriptPath}\"",
            WorkingDirectory = context.WorkDir,
            RedirectStandardOutput = true,
            RedirectStandardError = true,
            UseShellExecute = false,
            CreateNoWindow = true,
            StandardOutputEncoding = System.Text.Encoding.UTF8,
            StandardErrorEncoding = System.Text.Encoding.UTF8,
        };
        psi.EnvironmentVariables["OUTPUT_PATH"] = context.OutputPath;
        psi.EnvironmentVariables["PYTHONIOENCODING"] = "utf-8";
        psi.EnvironmentVariables["WONWORK_INPUT_DIR"] = context.InputDir;
        psi.EnvironmentVariables["WONWORK_OUTPUT_DIR"] = context.OutputDir;
        psi.EnvironmentVariables["WONWORK_WORKSPACE_ROOT"] = context.WorkspaceRoot;

        // S4 项目模式：用户轨项目目录（process 模式无隔离，env var 即约定）
        if (!string.IsNullOrEmpty(context.ProjectDir))
        {
            psi.EnvironmentVariables["WONWORK_PROJECT_DIR"] = context.ProjectDir;
        }

        if (context.AdditionalEnvironmentVariables != null)
        {
            foreach (var (key, value) in context.AdditionalEnvironmentVariables)
            {
                psi.EnvironmentVariables[key] = value;
            }
        }

        using var process = new Process { StartInfo = psi };
        if (!process.Start())
        {
            return SandboxResult.Fail("无法启动 Python 进程，请检查 PythonSandbox:PythonPath 配置");
        }

        var stdoutLines = new List<string>();
        var stderrLines = new List<string>();

        var stdoutReaderTask = ReadStreamAsync(process.StandardOutput, false, context, stdoutLines);
        var stderrReaderTask = ReadStreamAsync(process.StandardError, true, context, stderrLines);

        using var timeoutCts = new CancellationTokenSource(context.TimeoutMs);
        try
        {
            await process.WaitForExitAsync(timeoutCts.Token);
        }
        catch (OperationCanceledException)
        {
            try { process.Kill(true); } catch { /* ignore */ }
            _logger.LogWarning("[sandbox-process] 代码执行超时（>{Timeout}ms），已强制终止", context.TimeoutMs);
            return SandboxResult.Fail($"代码执行超时（超过 {context.TimeoutMs / 1000} 秒）。请检查代码是否存在无限循环或过大计算量。");
        }

        try { await stdoutReaderTask.WaitAsync(TimeSpan.FromSeconds(5), context.CancellationToken); } catch { /* ignore */ }
        try { await stderrReaderTask.WaitAsync(TimeSpan.FromSeconds(5), context.CancellationToken); } catch { /* ignore */ }

        var stdout = string.Join("\n", stdoutLines);
        var stderr = string.Join("\n", stderrLines);

        if (process.ExitCode != 0)
        {
            _logger.LogWarning("[sandbox-process] ExitCode={ExitCode}, stderr={Stderr}", process.ExitCode, stderr);
            return SandboxResult.Fail($"Python 代码执行失败（Exit code {process.ExitCode}）：{stderr}", stdout, stderr, process.ExitCode);
        }

        _logger.LogInformation("[sandbox-process] 执行成功");
        return SandboxResult.Ok(Array.Empty<byte>(), stdout, null, stderr);
    }

    private Task ReadStreamAsync(
        StreamReader reader,
        bool isError,
        SandboxExecutionContext context,
        List<string> lines)
    {
        return Task.Run(async () =>
        {
            try
            {
                while (!reader.EndOfStream)
                {
                    var line = await reader.ReadLineAsync(context.CancellationToken);
                    if (line != null)
                    {
                        lines.Add(line);
                        if (context.OnOutputLine != null)
                        {
                            await context.OnOutputLine(isError ? $"[stderr] {line}" : line);
                        }
                    }
                }
            }
            catch (OperationCanceledException) { }
            catch (Exception ex)
            {
                _logger.LogWarning(ex, "[sandbox-process] 流读取异常");
            }
        }, context.CancellationToken);
    }
}
