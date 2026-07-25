using System.Diagnostics;
using System.Text;

namespace AIGateway.Services;

/// <summary>
/// 基于 Docker 容器的 Python 沙盒执行器。
/// 通过挂载宿主机工作目录到容器 /sandbox 目录，实现文件系统隔离。
/// </summary>
public sealed class DockerSandboxExecutor : ISandboxExecutor
{
    private readonly string _imageName;
    private readonly string _dockerPath;
    private readonly ILogger<DockerSandboxExecutor> _logger;

    public string Name => "docker";

    public string? PythonExecutablePath => null;

    public DockerSandboxExecutor(string imageName, string dockerPath, ILogger<DockerSandboxExecutor> logger)
    {
        _imageName = imageName;
        _dockerPath = dockerPath;
        _logger = logger;
    }

    public async Task<SandboxResult> ExecuteAsync(SandboxExecutionContext context)
    {
        var workDir = Path.GetFullPath(context.WorkDir).TrimEnd(Path.DirectorySeparatorChar, Path.AltDirectorySeparatorChar);
        var workspaceRoot = Path.GetFullPath(context.WorkspaceRoot).TrimEnd(Path.DirectorySeparatorChar, Path.AltDirectorySeparatorChar);
        var scriptPathInContainer = "/sandbox/script.py";
        var outputPathInContainer = $"/sandbox/output.{context.OutputExtension}";
        var inputDirInContainer = "/sandbox/inputs";
        var outputDirInContainer = "/sandbox/outputs";

        var arguments = new StringBuilder();
        arguments.Append("run --rm ");
        arguments.Append("--network none "); // 禁止网络访问
        arguments.Append("--read-only ");    // 根文件系统只读
        arguments.Append("--tmpfs /tmp:noexec,nosuid,size=100m ");
        arguments.Append($"--label \"sandbox-workdir={Path.GetFileName(workDir)}\" ");
        arguments.Append("--cpus=2 ");
        arguments.Append("--memory=1g ");
        // 工具描述已承诺 WONWORK_WORKSPACE_ROOT 可读写，产物回收走 outputs 扫描、不依赖 ro 保护（S4 顺手修正 ro→rw）
        arguments.Append($"-v \"{workspaceRoot}:/workspace:rw\" ");
        arguments.Append($"-v \"{workDir}:/sandbox:rw\" ");

        // S4 项目模式：用户轨项目目录按 rw 挂载到容器内固定路径 /project
        var projectDirInContainer = "/project";
        if (!string.IsNullOrEmpty(context.ProjectDir))
        {
            var projectDir = Path.GetFullPath(context.ProjectDir).TrimEnd(Path.DirectorySeparatorChar, Path.AltDirectorySeparatorChar);
            arguments.Append($"-v \"{projectDir}:{projectDirInContainer}:rw\" ");
        }

        arguments.Append($"-e \"OUTPUT_PATH={outputPathInContainer}\" ");
        arguments.Append($"-e \"PYTHONIOENCODING=utf-8\" ");
        arguments.Append($"-e \"WONWORK_INPUT_DIR={inputDirInContainer}\" ");
        arguments.Append($"-e \"WONWORK_OUTPUT_DIR={outputDirInContainer}\" ");
        arguments.Append($"-e \"WONWORK_WORKSPACE_ROOT=/workspace\" ");
        if (!string.IsNullOrEmpty(context.ProjectDir))
        {
            arguments.Append($"-e \"WONWORK_PROJECT_DIR={projectDirInContainer}\" ");
        }

        if (context.AdditionalEnvironmentVariables != null)
        {
            foreach (var (key, value) in context.AdditionalEnvironmentVariables)
            {
                arguments.Append($"-e \"{key}={value}\" ");
            }
        }

        arguments.Append($"\"{_imageName}\" ");
        arguments.Append($"python -u \"{scriptPathInContainer}\"");

        var psi = new ProcessStartInfo
        {
            FileName = _dockerPath,
            Arguments = arguments.ToString(),
            RedirectStandardOutput = true,
            RedirectStandardError = true,
            UseShellExecute = false,
            CreateNoWindow = true,
        };

        _logger.LogInformation("[sandbox-docker] 启动容器：docker {Arguments}", arguments.ToString());

        using var process = new Process { StartInfo = psi };
        if (!process.Start())
        {
            return SandboxResult.Fail("无法启动 Docker 进程，请检查 Docker 是否已安装并正在运行");
        }

        var stdoutLines = new List<string>();
        var stderrLines = new List<string>();

        Task? stdoutReaderTask = null;
        Task? stderrReaderTask = null;

        if (context.OnOutputLine != null)
        {
            stdoutReaderTask = ReadStreamAsync(process.StandardOutput, false, context, stdoutLines);
            stderrReaderTask = ReadStreamAsync(process.StandardError, true, context, stderrLines);
        }

        using var timeoutCts = new CancellationTokenSource(context.TimeoutMs);
        try
        {
            await process.WaitForExitAsync(timeoutCts.Token);
        }
        catch (OperationCanceledException)
        {
            try
            {
                process.Kill(true);
                // 尝试清理可能残留的容器
                await CleanupContainerAsync(context.WorkDir);
            }
            catch { /* ignore */ }
            _logger.LogWarning("[sandbox-docker] 代码执行超时（>{Timeout}ms），已强制终止", context.TimeoutMs);
            return SandboxResult.Fail($"代码执行超时（超过 {context.TimeoutMs / 1000} 秒）。请检查代码是否存在无限循环或过大计算量。");
        }

        if (stdoutReaderTask != null)
        {
            try { await stdoutReaderTask.WaitAsync(TimeSpan.FromSeconds(5), context.CancellationToken); } catch { /* ignore */ }
        }
        if (stderrReaderTask != null)
        {
            try { await stderrReaderTask.WaitAsync(TimeSpan.FromSeconds(5), context.CancellationToken); } catch { /* ignore */ }
        }

        var stdout = string.Join("\n", stdoutLines);
        var stderr = string.Join("\n", stderrLines);

        if (process.ExitCode != 0)
        {
            _logger.LogWarning("[sandbox-docker] ExitCode={ExitCode}, stderr={Stderr}", process.ExitCode, stderr);
            return SandboxResult.Fail($"Docker 沙箱执行失败（Exit code {process.ExitCode}）：{stderr}", stdout, stderr, process.ExitCode);
        }

        _logger.LogInformation("[sandbox-docker] 容器执行成功");
        return SandboxResult.Ok(Array.Empty<byte>(), stdout, null, stderr);
    }

    private async Task CleanupContainerAsync(string workDir)
    {
        try
        {
            var label = $"sandbox-workdir={Path.GetFileName(workDir)}";
            var psi = new ProcessStartInfo
            {
                FileName = _dockerPath,
                Arguments = $"ps -q -f \"label={label}\"",
                RedirectStandardOutput = true,
                UseShellExecute = false,
                CreateNoWindow = true,
            };
            using var process = Process.Start(psi);
            if (process == null) return;
            var containerId = await process.StandardOutput.ReadToEndAsync();
            await process.WaitForExitAsync();
            if (!string.IsNullOrWhiteSpace(containerId))
            {
                _logger.LogWarning("[sandbox-docker] 强制停止残留容器 {ContainerId}", containerId.Trim());
                Process.Start(new ProcessStartInfo
                {
                    FileName = _dockerPath,
                    Arguments = $"stop -t 2 {containerId.Trim()}",
                    UseShellExecute = false,
                    CreateNoWindow = true,
                })?.WaitForExit(5000);
            }
        }
        catch (Exception ex)
        {
            _logger.LogWarning(ex, "[sandbox-docker] 清理残留容器失败");
        }
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
                _logger.LogWarning(ex, "[sandbox-docker] 流读取异常");
            }
        }, context.CancellationToken);
    }
}
