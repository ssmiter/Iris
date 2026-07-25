using AIGateway.Utils;
using System.Diagnostics;
using System.Text.RegularExpressions;

namespace AIGateway.Services;

public class SandboxResult
{
    public bool Success { get; init; }
    public byte[]? FileBytes { get; init; }
    public string? Stdout { get; init; }
    public string? Stderr { get; init; }
    public int? ExitCode { get; init; }
    public string? ErrorMessage { get; init; }
    public IReadOnlyList<OutputFile> OutputFiles { get; init; } = Array.Empty<OutputFile>();

    public record OutputFile(string FileName, string Extension, byte[] Bytes);

    public static SandboxResult Ok(byte[] fileBytes, string stdout, IReadOnlyList<OutputFile>? outputFiles = null, string? stderr = null) =>
        new() { Success = true, FileBytes = fileBytes, Stdout = stdout, Stderr = stderr, OutputFiles = outputFiles ?? Array.Empty<OutputFile>() };

    public static SandboxResult Fail(string errorMessage, string? stdout = null, string? stderr = null, int? exitCode = null, IReadOnlyList<OutputFile>? outputFiles = null) =>
        new() { Success = false, ErrorMessage = errorMessage, Stdout = stdout, Stderr = stderr, ExitCode = exitCode, OutputFiles = outputFiles ?? Array.Empty<OutputFile>() };
}

public class PythonSandboxService
{
    private readonly ILogger<PythonSandboxService> _logger;
    private readonly string _workspaceRoot;
    private readonly string _sandboxBaseDir;
    private readonly int _timeoutMs;
    private readonly ISandboxExecutor _executor;
    private readonly IWorkspaceFileService _workspaceFileService;

    // 沙盒工作目录名必须是 32 位十六进制 GUID（N 格式）
    private static readonly Regex WorkDirNameRegex = new("^[0-9a-fA-F]{32}$", RegexOptions.Compiled);

    // 禁止作为工作区根目录或沙盒根目录的系统/根路径（不区分大小写）
    // 禁止作为工作区根目录或沙盒根目录的系统/根路径（不区分大小写）。
    // 注意：只比较精确相等，不拒绝这些目录的合法子目录（如 C:\Program Files\WonWork\workspace）。
    private static readonly HashSet<string> ForbiddenBaseDirs = new(StringComparer.OrdinalIgnoreCase)
    {
        // POSIX 根目录
        "/",
        // Windows 系统目录
        Environment.GetFolderPath(Environment.SpecialFolder.Windows),
        Environment.GetFolderPath(Environment.SpecialFolder.System),
        Environment.GetFolderPath(Environment.SpecialFolder.ProgramFiles),
        Environment.GetFolderPath(Environment.SpecialFolder.ProgramFilesX86),
        Environment.GetFolderPath(Environment.SpecialFolder.UserProfile),
        Environment.GetFolderPath(Environment.SpecialFolder.Desktop),
        Environment.GetFolderPath(Environment.SpecialFolder.MyDocuments),
        Environment.GetFolderPath(Environment.SpecialFolder.Personal),
    };

    // pip 安装黑名单：朝向白名单的第一步，避免明显危险的服务器/注入类包
    private static readonly HashSet<string> PipBlacklist = new(StringComparer.OrdinalIgnoreCase)
    {
        "flask", "django", "fastapi", "uvicorn", "gunicorn", "tornado", "twisted",
        "celery", "redis", "pymongo", "streamlit", "gradio", "pyspark", "frida"
    };

    private static readonly char[] PipPackageNameSeparators = new[] { '=', '<', '>', '[', ' ', ';', '"', ',' };

    public PythonSandboxService(IConfiguration configuration, ILogger<PythonSandboxService> logger, ILoggerFactory loggerFactory, IWorkspaceFileService workspaceFileService)
    {
        _logger = logger;
        _workspaceFileService = workspaceFileService;

        // 1. 解析并校验工作区根目录
        var configuredWorkspaceRoot = configuration["PythonSandbox:WorkspaceRoot"];
        var rawWorkspaceRoot = string.IsNullOrWhiteSpace(configuredWorkspaceRoot)
            ? Path.Combine(Path.GetTempPath(), "aigateway-workspace")
            : configuredWorkspaceRoot;
        _workspaceRoot = NormalizePath(InstallDirResolver.Resolve(rawWorkspaceRoot));

        ValidateWorkspaceRoot();

        // 2. 解析沙盒根目录：默认位于工作区下的 .aigateway-sandbox
        var configuredBaseDir = configuration["PythonSandbox:SandboxBaseDir"];
        var rawBaseDir = string.IsNullOrWhiteSpace(configuredBaseDir)
            ? Path.Combine(_workspaceRoot, ".aigateway-sandbox")
            : configuredBaseDir;
        _sandboxBaseDir = NormalizePath(InstallDirResolver.Resolve(rawBaseDir));

        ValidateSandboxBaseDir();

        // 3. 确保目录存在
        Directory.CreateDirectory(_workspaceRoot);
        Directory.CreateDirectory(_sandboxBaseDir);

        _timeoutMs = configuration.GetValue<int?>("PythonSandbox:TimeoutMs") ?? 30000;
        _executor = CreateExecutor(configuration, loggerFactory);

        _logger.LogInformation(
            "[sandbox] 初始化完成 | 执行器：{ExecutorName} | 工作区：{WorkspaceRoot} | 沙盒根目录：{BaseDir}",
            _executor.Name, _workspaceRoot, _sandboxBaseDir);
    }

    private static string NormalizePath(string path)
    {
        return Path.GetFullPath(path).TrimEnd(Path.DirectorySeparatorChar, Path.AltDirectorySeparatorChar);
    }

    private static bool IsPathWithin(string child, string parent)
    {
        var normalizedChild = NormalizePath(child);
        var normalizedParent = NormalizePath(parent);

        if (normalizedChild.Equals(normalizedParent, StringComparison.OrdinalIgnoreCase))
        {
            return true;
        }

        return normalizedChild.StartsWith(normalizedParent + Path.DirectorySeparatorChar, StringComparison.OrdinalIgnoreCase) ||
               normalizedChild.StartsWith(normalizedParent + Path.AltDirectorySeparatorChar, StringComparison.OrdinalIgnoreCase);
    }

    private void ValidateWorkspaceRoot()
    {
        if (string.IsNullOrWhiteSpace(_workspaceRoot))
        {
            throw new InvalidOperationException("PythonSandbox:WorkspaceRoot 不能为空。");
        }

        if (!Path.IsPathRooted(_workspaceRoot))
        {
            throw new InvalidOperationException($"PythonSandbox:WorkspaceRoot 必须是绝对路径，当前值：'{_workspaceRoot}'");
        }

        var driveRoot = Path.GetPathRoot(_workspaceRoot);
        if (string.IsNullOrWhiteSpace(driveRoot))
        {
            throw new InvalidOperationException($"无法解析 PythonSandbox:WorkspaceRoot 的驱动器根目录：'{_workspaceRoot}'");
        }

        if (_workspaceRoot.Equals(NormalizePath(driveRoot), StringComparison.OrdinalIgnoreCase))
        {
            throw new InvalidOperationException($"PythonSandbox:WorkspaceRoot 不能是磁盘根目录：'{_workspaceRoot}'");
        }

        foreach (var forbidden in ForbiddenBaseDirs)
        {
            if (string.IsNullOrWhiteSpace(forbidden)) continue;
            var normalizedForbidden = NormalizePath(forbidden);
            if (_workspaceRoot.Equals(normalizedForbidden, StringComparison.OrdinalIgnoreCase))
            {
                throw new InvalidOperationException($"PythonSandbox:WorkspaceRoot 不能是系统或受保护目录，当前值：'{_workspaceRoot}'");
            }
        }
    }

    private void ValidateSandboxBaseDir()
    {
        if (string.IsNullOrWhiteSpace(_sandboxBaseDir))
        {
            throw new InvalidOperationException("PythonSandbox:SandboxBaseDir 不能为空。");
        }

        if (!Path.IsPathRooted(_sandboxBaseDir))
        {
            throw new InvalidOperationException($"PythonSandbox:SandboxBaseDir 必须是绝对路径，当前值：'{_sandboxBaseDir}'");
        }

        if (!IsPathWithin(_sandboxBaseDir, _workspaceRoot))
        {
            throw new InvalidOperationException(
                $"PythonSandbox:SandboxBaseDir 必须位于 PythonSandbox:WorkspaceRoot 内。\n" +
                $"WorkspaceRoot: '{_workspaceRoot}'\n" +
                $"SandboxBaseDir: '{_sandboxBaseDir}'");
        }

        var driveRoot = Path.GetPathRoot(_sandboxBaseDir);
        if (_sandboxBaseDir.Equals(NormalizePath(driveRoot ?? _sandboxBaseDir), StringComparison.OrdinalIgnoreCase))
        {
            throw new InvalidOperationException($"PythonSandbox:SandboxBaseDir 不能是磁盘根目录：'{_sandboxBaseDir}'");
        }
    }

    private static ISandboxExecutor CreateExecutor(IConfiguration configuration, ILoggerFactory loggerFactory)
    {
        var executorType = configuration["PythonSandbox:Executor"]?.ToLowerInvariant() ?? "process";

        if (executorType == "docker")
        {
            var imageName = configuration["PythonSandbox:Docker:ImageName"] ?? "aigateway-python-sandbox";
            var dockerPath = configuration["PythonSandbox:Docker:DockerPath"] ?? "docker";
            return new DockerSandboxExecutor(imageName, dockerPath, loggerFactory.CreateLogger<DockerSandboxExecutor>());
        }

        var pythonPath = InstallDirResolver.Resolve(configuration["PythonSandbox:PythonPath"] ?? "python");
        return new ProcessSandboxExecutor(pythonPath, loggerFactory.CreateLogger<ProcessSandboxExecutor>());
    }

    /// <summary>
    /// 在隔离环境中执行 Python 代码，返回生成的文件字节数组。
    /// </summary>
    public async Task<SandboxResult> ExecuteAsync(string code, string outputExtension, CancellationToken ct = default)
        => await ExecuteAsync(code, outputExtension, null, null, null, ct);

    /// <summary>
    /// 在隔离环境中执行 Python 代码，支持逐行 stdout/stderr 流式回调。
    /// </summary>
    public async Task<SandboxResult> ExecuteAsync(
        string code,
        string outputExtension,
        Func<string, Task>? onOutputLine,
        CancellationToken ct = default)
        => await ExecuteAsync(code, outputExtension, null, null, onOutputLine, ct);

    /// <summary>
    /// 在隔离环境中执行 Python 代码，支持按需安装 pip 包、注入工作区环境变量。
    /// </summary>
    public async Task<SandboxResult> ExecuteAsync(
        string code,
        string outputExtension,
        string[]? pipPackages,
        Func<string, Task>? onOutputLine,
        CancellationToken ct = default)
        => await ExecuteAsync(code, outputExtension, pipPackages, null, onOutputLine, ct);

    /// <summary>
    /// 在隔离环境中执行 Python 代码，支持按需安装 pip 包、声明输入文件。
    /// </summary>
    public async Task<SandboxResult> ExecuteAsync(
        string code,
        string outputExtension,
        string[]? pipPackages,
        string[]? inputFilePaths,
        Func<string, Task>? onOutputLine,
        CancellationToken ct = default)
    {
        var workDir = Path.Combine(_sandboxBaseDir, Guid.NewGuid().ToString("N"));

        // 在执行任何文件操作前，先校验工作目录确实位于沙盒根目录内
        if (!IsPathWithin(workDir, _sandboxBaseDir))
        {
            _logger.LogError("[sandbox] 工作目录 '{WorkDir}' 不在沙盒根目录内，拒绝执行", workDir);
            return SandboxResult.Fail("沙盒工作目录校验失败，拒绝执行");
        }

        Directory.CreateDirectory(workDir);
        var inputsDir = Path.Combine(workDir, "inputs");
        var outputsDir = Path.Combine(workDir, "outputs");
        Directory.CreateDirectory(inputsDir);
        Directory.CreateDirectory(outputsDir);

        // 按需安装 pip 依赖（不改变后续执行逻辑，仅前置准备）
        if (pipPackages != null && pipPackages.Length > 0)
        {
            var installResult = await InstallPackagesAsync(pipPackages, onOutputLine, ct);
            if (installResult != null)
            {
                SafelyDeleteWorkDir(workDir);
                return installResult;
            }
        }

        var scriptPath = Path.Combine(workDir, "script.py");
        var outputPath = Path.Combine(workDir, $"output.{outputExtension}");

        // 再次校验脚本路径和输出路径都在工作区内
        if (!IsPathWithin(scriptPath, workDir) || !IsPathWithin(outputPath, workDir))
        {
            _logger.LogError("[sandbox] 脚本或输出路径越界，拒绝执行");
            SafelyDeleteWorkDir(workDir);
            return SandboxResult.Fail("沙盒文件路径校验失败，拒绝执行");
        }

        try
        {
            // 映射输入文件到沙箱 inputs 目录
            if (inputFilePaths != null && inputFilePaths.Length > 0)
            {
                foreach (var physicalPath in inputFilePaths)
                {
                    if (!File.Exists(physicalPath))
                    {
                        _logger.LogWarning("[sandbox] 输入文件不存在，跳过：{Path}", physicalPath);
                        continue;
                    }
                    var destName = Path.GetFileName(physicalPath);
                    var destPath = Path.Combine(inputsDir, destName);
                    if (!IsPathWithin(destPath, inputsDir))
                    {
                        _logger.LogWarning("[sandbox] 输入文件目标路径越界，跳过：{Path}", physicalPath);
                        continue;
                    }
                    File.Copy(physicalPath, destPath, overwrite: true);
                }
            }

            await File.WriteAllTextAsync(scriptPath, code, ct);
            _logger.LogDebug("[sandbox] workDir={WorkDir}, output={Output}, executor={Executor}", workDir, outputPath, _executor.Name);

            var context = new SandboxExecutionContext(
                code,
                workDir,
                _workspaceRoot,
                scriptPath,
                outputPath,
                outputExtension,
                _timeoutMs,
                onOutputLine,
                ct,
                inputsDir,
                outputsDir,
                AdditionalEnvironmentVariables: null,
                // S4 项目模式：执行时读取活跃项目根（服务内部取，调用方零改动）
                ProjectDir: _workspaceFileService.ActiveProjectRoot);

            var result = await _executor.ExecuteAsync(context);
            if (!result.Success)
            {
                return SandboxResult.Fail(
                    result.ErrorMessage ?? "Python 代码执行失败",
                    result.Stdout,
                    result.Stderr,
                    result.ExitCode);
            }

            // 扫描沙箱工作目录内的产物（除脚本和输入文件外）
            var outputFiles = CollectOutputFiles(workDir, inputsDir, scriptPath);

            if (!File.Exists(outputPath))
            {
                var fallback = FindOutputFileFallback(workDir, outputExtension, inputsDir);
                if (fallback != null && IsPathWithin(fallback, workDir))
                {
                    _logger.LogWarning("[sandbox] OUTPUT_PATH 不存在，但发现备选文件 {Fallback}，自动使用", fallback);
                    File.Copy(fallback, outputPath, overwrite: true);
                    outputFiles = CollectOutputFiles(workDir, inputsDir, scriptPath);
                }
                else
                {
                    return SandboxResult.Fail(
                        "代码未生成输出文件。请确保代码最后使用以下方式保存文件：\n" +
                        "import os\n" +
                        "output_path = os.environ['OUTPUT_PATH']\n" +
                        "# ... 生成文档后 ...\n" +
                        "doc.save(output_path)  # 或 wb.save(output_path) / prs.save(output_path)",
                        result.Stdout,
                        result.Stderr,
                        result.ExitCode,
                        outputFiles);
                }
            }

            var bytes = await File.ReadAllBytesAsync(outputPath, ct);
            _logger.LogInformation("[sandbox] 执行成功，输出文件 {Size} bytes，扫描到 {Count} 个产物", bytes.Length, outputFiles.Count);

            return SandboxResult.Ok(bytes, result.Stdout ?? "", outputFiles, result.Stderr);
        }
        catch (Exception ex)
        {
            _logger.LogError(ex, "[sandbox] 执行异常");
            return SandboxResult.Fail($"沙箱执行异常：{ex.Message}");
        }
        finally
        {
            SafelyDeleteWorkDir(workDir);
        }
    }

    private async Task<SandboxResult?> InstallPackagesAsync(
        string[] packages,
        Func<string, Task>? onOutputLine,
        CancellationToken ct)
    {
        var pythonPath = _executor.PythonExecutablePath;
        if (string.IsNullOrWhiteSpace(pythonPath))
        {
            return SandboxResult.Fail("当前沙箱执行器不支持 pip 安装依赖。");
        }

        foreach (var package in packages.Distinct(StringComparer.OrdinalIgnoreCase))
        {
            var pkg = package?.Trim();
            if (string.IsNullOrWhiteSpace(pkg))
                continue;

            if (!IsSafePackageName(pkg))
            {
                _logger.LogWarning("[sandbox] 拒绝安装非法包名: {Package}", pkg);
                return SandboxResult.Fail($"非法的 pip 包名：{pkg}");
            }

            var bareName = pkg.Split(PipPackageNameSeparators, StringSplitOptions.RemoveEmptyEntries).FirstOrDefault()?.Trim();
            if (!string.IsNullOrWhiteSpace(bareName) && PipBlacklist.Contains(bareName))
            {
                _logger.LogWarning("[sandbox] 拒绝安装黑名单包: {Package} (bare={BareName})", pkg, bareName);
                return SandboxResult.Fail($"pip 包 {pkg} 不在允许安装的范围内。");
            }

            _logger.LogInformation("[sandbox] 正在安装 pip 依赖: {Package}", pkg);

            var psi = new ProcessStartInfo
            {
                FileName = pythonPath,
                Arguments = $"-m pip install --no-warn-script-location \"{pkg}\"",
                RedirectStandardOutput = true,
                RedirectStandardError = true,
                UseShellExecute = false,
                CreateNoWindow = true,
                StandardOutputEncoding = System.Text.Encoding.UTF8,
                StandardErrorEncoding = System.Text.Encoding.UTF8,
            };
            psi.EnvironmentVariables["PYTHONIOENCODING"] = "utf-8";

            using var process = new Process { StartInfo = psi };
            if (!process.Start())
            {
                return SandboxResult.Fail("无法启动 pip 安装进程。");
            }

            var stdout = await process.StandardOutput.ReadToEndAsync(ct);
            var stderr = await process.StandardError.ReadToEndAsync(ct);
            try
            {
                await process.WaitForExitAsync(ct);
            }
            catch (OperationCanceledException)
            {
                try { process.Kill(true); } catch { /* ignore */ }
                return SandboxResult.Fail($"安装依赖 {pkg} 超时。");
            }

            if (process.ExitCode != 0)
            {
                _logger.LogWarning("[sandbox] pip install {Package} 失败（ExitCode={ExitCode}）: {Stderr}", pkg, process.ExitCode, stderr);
                return SandboxResult.Fail($"安装依赖 {pkg} 失败：{stderr}", stdout);
            }

            if (onOutputLine != null)
            {
                foreach (var line in stdout.Split('\n'))
                {
                    if (!string.IsNullOrWhiteSpace(line))
                    {
                        await onOutputLine($"[pip] {line.Trim()}");
                    }
                }
            }
        }

        return null;
    }

    private static bool IsSafePackageName(string package)
    {
        // 只拒绝明显会导致 shell 注入或破坏 Argument 结构的字符；具体版本约束交给 pip 自己校验。
        var forbidden = new[] { '"', ';', '&', '|', '$', '`', '\n', '\r' };
        return !forbidden.Any(package.Contains);
    }

    private bool IsValidWorkDir(string workDir)
    {
        try
        {
            if (string.IsNullOrWhiteSpace(workDir) || !Directory.Exists(workDir))
            {
                return false;
            }

            var fullWorkDir = NormalizePath(workDir);
            var fullBaseDir = NormalizePath(_sandboxBaseDir);

            if (!IsPathWithin(fullWorkDir, fullBaseDir))
            {
                _logger.LogWarning("[sandbox] 工作目录 '{WorkDir}' 不在沙盒根目录 '{BaseDir}' 内，拒绝清理", fullWorkDir, fullBaseDir);
                return false;
            }

            var dirName = Path.GetFileName(fullWorkDir);
            if (!WorkDirNameRegex.IsMatch(dirName))
            {
                _logger.LogWarning("[sandbox] 工作目录名 '{DirName}' 不是有效的 GUID，拒绝清理", dirName);
                return false;
            }

            return true;
        }
        catch (Exception ex)
        {
            _logger.LogWarning(ex, "[sandbox] 校验工作目录时异常：'{WorkDir}'", workDir);
            return false;
        }
    }

    private void SafelyDeleteWorkDir(string workDir)
    {
        if (!IsValidWorkDir(workDir))
        {
            return;
        }

        try
        {
            Directory.Delete(workDir, true);
            _logger.LogDebug("[sandbox] 已清理工作目录 {WorkDir}", workDir);
        }
        catch (Exception ex)
        {
            _logger.LogWarning(ex, "[sandbox] 清理工作目录失败：{WorkDir}", workDir);
        }
    }

    private string? FindOutputFileFallback(string workDir, string extension, string inputsDir)
    {
        try
        {
            var files = Directory.GetFiles(workDir, $"*.{extension}", SearchOption.AllDirectories)
                .Where(f => IsPathWithin(f, workDir) && !IsPathWithin(f, inputsDir) && !f.Equals(inputsDir, StringComparison.OrdinalIgnoreCase))
                .ToArray();
            return files.FirstOrDefault();
        }
        catch
        {
            return null;
        }
    }

    private static List<SandboxResult.OutputFile> CollectOutputFiles(string workDir, string inputsDir, string scriptPath)
    {
        var result = new List<SandboxResult.OutputFile>();
        try
        {
            var files = Directory.GetFiles(workDir, "*.*", SearchOption.AllDirectories);
            foreach (var file in files)
            {
                if (file.Equals(scriptPath, StringComparison.OrdinalIgnoreCase))
                    continue;
                if (IsPathWithin(file, inputsDir) || file.Equals(inputsDir, StringComparison.OrdinalIgnoreCase))
                    continue;
                var bytes = File.ReadAllBytes(file);
                var ext = Path.GetExtension(file).TrimStart('.');
                var fileName = Path.GetFileName(file);
                result.Add(new SandboxResult.OutputFile(fileName, ext, bytes));
            }
        }
        catch
        {
            // 扫描失败不影响主输出返回
        }
        return result;
    }
}
