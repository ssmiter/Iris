using System.Collections.Concurrent;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using System.Text.RegularExpressions;
using AIGateway.Models;
using AIGateway.Utils;

namespace AIGateway.Services;

public class WorkspaceFileService : IWorkspaceFileService
{
    private readonly ILogger<WorkspaceFileService> _logger;
    private readonly IWorkspaceItemService _items;
    private readonly string _rootPath;
    private readonly string _filesPath;
    private readonly string _outputsPath;
    private readonly string _scratchPath;
    private readonly string _uploadsPath;
    private readonly string _syncPath;
    private readonly string _notesPath;
    private readonly string _templatesPath;
    private readonly string _scriptsPath;

    // S4 项目模式（打磨任务2）：用户轨活跃项目根——机器级单例，运行时可变，
    // 持久化到 workspace/.wonwork/active-project.json，服务重启后恢复。
    private readonly object _projectRootLock = new();
    private string? _activeProjectRoot;
    private readonly string _projectRootPersistFile;

    public string RootPath => _rootPath;
    public string FilesPath => _filesPath;
    public string OutputsPath => _outputsPath;
    public string ScratchPath => _scratchPath;
    public string UploadsPath => _uploadsPath;
    public string SyncPath => _syncPath;
    public string TemplatesPath => _templatesPath;
    public string ScriptsPath => _scriptsPath;

    /// <summary>当前活跃项目根（/project 虚拟根对应的物理目录），未选择时为 null。</summary>
    public string? ActiveProjectRoot => _activeProjectRoot;

    private static readonly long DefaultMaxUploadBytes = 50 * 1024 * 1024;

    private static readonly HashSet<string> BlockedExecutableExtensions = new(StringComparer.OrdinalIgnoreCase)
    {
        ".exe", ".dll", ".bat", ".cmd", ".sh", ".msi", ".jar", ".ps1", ".com", ".scr", ".vbs", ".js"
    };

    private static readonly HashSet<string> TextExtensions = new(StringComparer.OrdinalIgnoreCase)
    {
        ".txt", ".md", ".markdown", ".json", ".js", ".ts", ".jsx", ".tsx", ".css", ".scss", ".html", ".xml", ".yaml", ".yml", ".csv", ".log", ".py", ".sh", ".cs", ".sql", ".ini", ".cfg", ".conf"
    };

    private static readonly Dictionary<string, string> MimeTypes = new(StringComparer.OrdinalIgnoreCase)
    {
        [".docx"] = "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
        [".xlsx"] = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        [".pptx"] = "application/vnd.openxmlformats-officedocument.presentationml.presentation",
        [".pdf"] = "application/pdf",
        [".png"] = "image/png",
        [".jpg"] = "image/jpeg",
        [".jpeg"] = "image/jpeg",
        [".gif"] = "image/gif",
        [".webp"] = "image/webp",
        [".svg"] = "image/svg+xml",
        [".txt"] = "text/plain",
        [".md"] = "text/markdown",
        [".json"] = "application/json",
        [".csv"] = "text/csv",
        [".html"] = "text/html",
        [".xml"] = "application/xml",
        [".py"] = "text/x-python"
    };

    private static readonly Dictionary<string, byte[]> MagicSignatures = new(StringComparer.OrdinalIgnoreCase)
    {
        [".png"] = new byte[] { 0x89, 0x50, 0x4E, 0x47 },
        [".jpg"] = new byte[] { 0xFF, 0xD8, 0xFF },
        [".jpeg"] = new byte[] { 0xFF, 0xD8, 0xFF },
        [".gif"] = new byte[] { 0x47, 0x49, 0x46, 0x38 },
        [".pdf"] = new byte[] { 0x25, 0x50, 0x44, 0x46 },
        [".zip"] = new byte[] { 0x50, 0x4B, 0x03, 0x04 },
    };

    private static readonly ConcurrentDictionary<string, SemaphoreSlim> FileLocks = new();

    public WorkspaceFileService(IConfiguration configuration, IWebHostEnvironment env, ILogger<WorkspaceFileService> logger, IWorkspaceItemService items)
    {
        _logger = logger;
        _items = items;
        _rootPath = ResolveRootPath(configuration, env);
        _filesPath = Path.Combine(_rootPath, "files");
        _outputsPath = Path.Combine(_rootPath, "outputs");
        _scratchPath = Path.Combine(_rootPath, "scratch");
        _uploadsPath = Path.Combine(_rootPath, "uploads");
        _syncPath = Path.Combine(_rootPath, "sync");
        _notesPath = Path.Combine(_rootPath, "notes");
        _templatesPath = Path.Combine(_rootPath, "templates");
        _scriptsPath = Path.Combine(_rootPath, "scripts");

        try
        {
            Directory.CreateDirectory(_filesPath);
            Directory.CreateDirectory(_outputsPath);
            Directory.CreateDirectory(_scratchPath);
            Directory.CreateDirectory(_uploadsPath);
            Directory.CreateDirectory(_syncPath);
            Directory.CreateDirectory(_notesPath);
            Directory.CreateDirectory(_templatesPath);
            Directory.CreateDirectory(_scriptsPath);
        }
        catch (Exception ex)
        {
            _logger.LogError(ex, "无法创建工作区目录 {RootPath}", _rootPath);
        }

        _projectRootPersistFile = Path.Combine(_rootPath, ".wonwork", "active-project.json");
        LoadPersistedProjectRoot();
    }

    /// <summary>
    /// 设置用户轨活跃项目根（打磨任务2 S4）。
    /// 校验：路径存在且是目录、非系统目录、不是工作区根或其子目录（双轨必须分离）。
    /// 成功后持久化到 workspace/.wonwork/active-project.json。
    /// </summary>
    public void SetProjectRoot(string path)
    {
        if (string.IsNullOrWhiteSpace(path))
        {
            throw new ArgumentException("项目路径不能为空");
        }

        string fullPath;
        try
        {
            fullPath = Path.GetFullPath(path.Trim());
        }
        catch (Exception ex)
        {
            throw new ArgumentException($"项目路径无效: {ex.Message}");
        }

        fullPath = fullPath.TrimEnd(Path.DirectorySeparatorChar, Path.AltDirectorySeparatorChar);

        if (!Directory.Exists(fullPath))
        {
            throw new ArgumentException($"项目路径不存在或不是目录: {path}");
        }

        if (IsSystemDirectory(fullPath))
        {
            throw new ArgumentException($"禁止将系统目录设为项目根: {fullPath}");
        }

        var workspaceRoot = Path.GetFullPath(_rootPath).TrimEnd(Path.DirectorySeparatorChar, Path.AltDirectorySeparatorChar);
        if (fullPath.Equals(workspaceRoot, StringComparison.OrdinalIgnoreCase) ||
            fullPath.StartsWith(workspaceRoot + Path.DirectorySeparatorChar, StringComparison.OrdinalIgnoreCase))
        {
            throw new ArgumentException("项目根不能是工作区根或其子目录（/project 与 /workspace 必须分离）");
        }

        lock (_projectRootLock)
        {
            _activeProjectRoot = fullPath;
            PersistProjectRoot(fullPath);
        }

        _logger.LogInformation("项目模式：活跃项目根已设置为 {ProjectRoot}", fullPath);
    }

    /// <summary>清除活跃项目根（/project 命名空间随之不可用，直到下次选择）。</summary>
    public void ClearProjectRoot()
    {
        lock (_projectRootLock)
        {
            _activeProjectRoot = null;
            try
            {
                if (File.Exists(_projectRootPersistFile))
                {
                    File.Delete(_projectRootPersistFile);
                }
            }
            catch (Exception ex)
            {
                _logger.LogWarning(ex, "删除持久化项目根文件失败");
            }
        }

        _logger.LogInformation("项目模式：活跃项目根已清除");
    }

    /// <summary>
    /// 公开的虚拟路径→物理路径解析（打磨任务2 S4）：双根路由 + 三层越界校验。
    /// 沙箱/预览等曾各自复制单根拼接逻辑的调用方，统一改用此方法。
    /// </summary>
    public string ResolvePhysicalPath(string virtualPath) => ResolveAndValidatePath(virtualPath, mustExist: false);

    private static bool IsSystemDirectory(string fullPath)
    {
        // 盘符根（trim 后形如 "C:"）
        if (Regex.IsMatch(fullPath, @"^[A-Za-z]:$"))
        {
            return true;
        }

        var blocked = new[]
        {
            Environment.GetFolderPath(Environment.SpecialFolder.Windows),
            Environment.GetFolderPath(Environment.SpecialFolder.ProgramFiles),
            Environment.GetFolderPath(Environment.SpecialFolder.ProgramFilesX86),
            Environment.GetFolderPath(Environment.SpecialFolder.CommonApplicationData),
        };

        foreach (var b in blocked)
        {
            if (string.IsNullOrEmpty(b)) continue;
            var bb = b.TrimEnd(Path.DirectorySeparatorChar, Path.AltDirectorySeparatorChar);
            if (fullPath.Equals(bb, StringComparison.OrdinalIgnoreCase) ||
                fullPath.StartsWith(bb + Path.DirectorySeparatorChar, StringComparison.OrdinalIgnoreCase))
            {
                return true;
            }
        }

        return false;
    }

    private void PersistProjectRoot(string projectRoot)
    {
        try
        {
            var dir = Path.GetDirectoryName(_projectRootPersistFile)!;
            Directory.CreateDirectory(dir);
            File.WriteAllText(_projectRootPersistFile, JsonSerializer.Serialize(new { path = projectRoot }));
        }
        catch (Exception ex)
        {
            _logger.LogWarning(ex, "项目根持久化失败（不影响本次设置）");
        }
    }

    private void LoadPersistedProjectRoot()
    {
        try
        {
            if (!File.Exists(_projectRootPersistFile)) return;
            var json = File.ReadAllText(_projectRootPersistFile);
            using var doc = JsonDocument.Parse(json);
            var path = doc.RootElement.GetProperty("path").GetString();
            if (!string.IsNullOrWhiteSpace(path) && Directory.Exists(path))
            {
                _activeProjectRoot = Path.GetFullPath(path).TrimEnd(Path.DirectorySeparatorChar, Path.AltDirectorySeparatorChar);
                _logger.LogInformation("项目模式：已从持久化恢复活跃项目根 {ProjectRoot}", _activeProjectRoot);
            }
        }
        catch (Exception ex)
        {
            _logger.LogWarning(ex, "读取持久化项目根失败，忽略");
        }
    }

    private static string ResolveRootPath(IConfiguration configuration, IWebHostEnvironment env)
    {
        var configuredRoot = configuration["PythonSandbox:WorkspaceRoot"];
        var root = string.IsNullOrWhiteSpace(configuredRoot)
            ? Path.Combine(env.ContentRootPath, "workspace")
            : InstallDirResolver.Resolve(configuredRoot);

        if (!Path.IsPathRooted(root))
        {
            root = Path.Combine(env.ContentRootPath, root);
        }

        return Path.GetFullPath(root);
    }

    public Task<WorkspaceListResponse> ListAsync(string virtualPath, CancellationToken ct = default)
    {
        var physicalPath = ResolveAndValidatePath(virtualPath, mustExist: false);
        var response = new WorkspaceListResponse { Path = NormalizeVirtualPath(virtualPath) };

        if (!Directory.Exists(physicalPath))
        {
            response.Nodes = Array.Empty<WorkspaceNode>();
            return Task.FromResult(response);
        }

        var nodes = new List<WorkspaceNode>();

        foreach (var dir in Directory.GetDirectories(physicalPath).OrderBy(d => d))
        {
            ct.ThrowIfCancellationRequested();
            var info = new DirectoryInfo(dir);
            var relativePath = GetRelativeVirtualPath(dir);
            nodes.Add(new WorkspaceNode
            {
                Name = info.Name,
                Path = relativePath,
                Kind = WorkspaceNodeKind.Folder,
                CreatedAt = info.CreationTimeUtc,
                UpdatedAt = info.LastWriteTimeUtc
            });
        }

        foreach (var file in Directory.GetFiles(physicalPath).OrderBy(f => f))
        {
            ct.ThrowIfCancellationRequested();
            var info = new FileInfo(file);
            var relativePath = GetRelativeVirtualPath(file);
            nodes.Add(ToFileNode(info, relativePath));
        }

        response.Nodes = nodes;
        return Task.FromResult(response);
    }

    public Task<WorkspaceReadResponse> ReadAsync(string virtualPath, CancellationToken ct = default)
    {
        var physicalPath = ResolveAndValidatePath(virtualPath, mustExist: true);

        if (!File.Exists(physicalPath))
        {
            throw new FileNotFoundException($"文件不存在: {virtualPath}");
        }

        var info = new FileInfo(physicalPath);
        var ext = Path.GetExtension(physicalPath);
        var isText = IsTextFile(ext);
        var response = new WorkspaceReadResponse
        {
            Path = NormalizeVirtualPath(virtualPath),
            IsText = isText,
            SizeBytes = info.Length,
            MimeType = GetMimeType(ext),
            DownloadUrl = GetDownloadUrl(virtualPath),
            UpdatedAt = info.LastWriteTimeUtc
        };

        if (isText)
        {
            response.Content = File.ReadAllText(physicalPath, Encoding.UTF8);
        }

        return Task.FromResult(response);
    }

    public async Task<WorkspaceNode> WriteAsync(string virtualPath, string content, WorkspaceWriteContext? ctx = null, bool append = false, CancellationToken ct = default)
    {
        var bytes = Encoding.UTF8.GetBytes(content);
        return await WriteBytesAsync(virtualPath, bytes, ctx, append, ct);
    }

    public async Task<WorkspaceNode> WriteBytesAsync(string virtualPath, byte[] content, WorkspaceWriteContext? ctx = null, bool append = false, CancellationToken ct = default)
    {
        virtualPath = RedirectLegacyFilesPath(virtualPath);
        var physicalPath = ResolveAndValidatePath(virtualPath, mustExist: false);
        var directory = Path.GetDirectoryName(physicalPath);
        if (!string.IsNullOrEmpty(directory))
        {
            Directory.CreateDirectory(directory);
        }

        var fileLock = FileLocks.GetOrAdd(physicalPath, _ => new SemaphoreSlim(1, 1));
        await fileLock.WaitAsync(ct);
        try
        {
            byte[] finalContent = content;
            if (append && File.Exists(physicalPath))
            {
                var existing = await File.ReadAllBytesAsync(physicalPath, ct);
                finalContent = new byte[existing.Length + content.Length];
                Buffer.BlockCopy(existing, 0, finalContent, 0, existing.Length);
                Buffer.BlockCopy(content, 0, finalContent, existing.Length, content.Length);
            }

            var tmpPath = physicalPath + ".tmp" + Guid.NewGuid().ToString("N");
            await File.WriteAllBytesAsync(tmpPath, finalContent, ct);
            File.Move(tmpPath, physicalPath, overwrite: true);

            _logger.LogInformation(
                "Workspace file written: {Path}, size: {Size}, append: {Append}, user: {UserId}, tool: {ToolName}, conversation: {ConversationId}",
                physicalPath, finalContent.Length, append, ctx?.UserId, ctx?.ToolName, ctx?.ConversationId);

            // H1：会话-文件索引（用户上传走 upload，其余工具/AI 生成走 output）
            var writeKind = string.Equals(ctx?.Source, "user_upload", StringComparison.OrdinalIgnoreCase)
                ? IWorkspaceItemService.Kinds.Upload
                : IWorkspaceItemService.Kinds.Output;
            await RecordIndexAsync(virtualPath, writeKind, ctx,
                mimeType: LookupMimeType(Path.GetExtension(physicalPath)),
                sizeBytes: finalContent.Length, ct: ct);

            var info = new FileInfo(physicalPath);
            return ToFileNode(info, NormalizeVirtualPath(virtualPath), ctx?.Source);
        }
        finally
        {
            fileLock.Release();
        }
    }

    public async Task<WorkspaceNode> UploadAsync(Stream source, UploadOptions options, WorkspaceWriteContext? ctx = null, CancellationToken ct = default)
    {
        if (source == null) throw new ArgumentNullException(nameof(source));

        var declaredFileName = options.DeclaredFileName ?? "upload";
        var extension = Path.GetExtension(declaredFileName);
        if (string.IsNullOrWhiteSpace(extension))
        {
            extension = ".bin";
        }

        if (BlockedExecutableExtensions.Contains(extension))
        {
            throw new InvalidOperationException($"禁止上传可执行文件: {extension}");
        }

        var maxBytes = options.MaxBytes ?? DefaultMaxUploadBytes;
        await CheckQuotaAsync(maxBytes, ctx, ct);

        var baseName = Path.GetFileNameWithoutExtension(declaredFileName);
        var tempPath = Path.Combine(_uploadsPath, $"tmp_{Guid.NewGuid():N}_{DateTime.Now:HHmmssfff}{extension}");
        Directory.CreateDirectory(_uploadsPath);

        byte[] header;
        string checksumHex;
        long written;

        try
        {
            await using (var tempStream = new FileStream(tempPath, FileMode.Create, FileAccess.Write, FileShare.None, 65536, true))
            {
                using var sha256 = SHA256.Create();
                var buffer = new byte[65536];
                var headerBuffer = new List<byte>(16);
                written = 0;
                int read;
                while ((read = await source.ReadAsync(buffer, 0, buffer.Length, ct)) > 0)
                {
                    if (written + read > maxBytes)
                    {
                        var allowed = maxBytes - written;
                        if (allowed > 0)
                        {
                            await tempStream.WriteAsync(buffer, 0, (int)allowed, ct);
                            sha256.TransformBlock(buffer, 0, (int)allowed, null, 0);
                            CollectHeaderBytes(headerBuffer, buffer, (int)allowed);
                        }
                        written = maxBytes;
                        throw new InvalidOperationException($"文件大小超过限制 {maxBytes} bytes");
                    }

                    await tempStream.WriteAsync(buffer, 0, read, ct);
                    sha256.TransformBlock(buffer, 0, read, null, 0);
                    CollectHeaderBytes(headerBuffer, buffer, read);
                    written += read;
                }

                sha256.TransformFinalBlock(Array.Empty<byte>(), 0, 0);
                checksumHex = BitConverter.ToString(sha256.Hash!).Replace("-", string.Empty);
                header = headerBuffer.Take(16).ToArray();
            }

            var validatedMimeType = ValidateMimeType(extension, header, options.DeclaredMimeType);

            var (virtualPath, physicalPath) = ResolveUploadPath(extension, baseName, version: 1);
            var resolvedVersion = 1;
            const int MaxVersionAttempts = 100;
            while (File.Exists(physicalPath) && !options.AllowOverwrite && resolvedVersion < MaxVersionAttempts)
            {
                resolvedVersion++;
                (virtualPath, physicalPath) = ResolveUploadPath(extension, baseName, resolvedVersion);
            }

            if (File.Exists(physicalPath) && !options.AllowOverwrite)
            {
                throw new IOException($"文件版本数超过上限 {MaxVersionAttempts}，请删除旧版本后重试");
            }

            var directory = Path.GetDirectoryName(physicalPath);
            if (!string.IsNullOrEmpty(directory))
            {
                Directory.CreateDirectory(directory);
            }

            File.Move(tempPath, physicalPath, overwrite: options.AllowOverwrite);

            _logger.LogInformation(
                "Workspace file uploaded: {Path}, size: {Size}, version: {Version}, checksum: {Checksum}, user: {UserId}, conversation: {ConversationId}",
                physicalPath, written, resolvedVersion, checksumHex, ctx?.UserId, ctx?.ConversationId);

            // H2：会话-文件索引（用户上传）
            await RecordIndexAsync(virtualPath, IWorkspaceItemService.Kinds.Upload, ctx,
                mimeType: validatedMimeType, sizeBytes: written, ct: ct);

            var info = new FileInfo(physicalPath);
            var node = ToFileNode(info, NormalizeVirtualPath(virtualPath), ctx?.Source ?? "user_upload");
            node.Status = WorkspaceNodeStatus.Ready;
            node.Version = resolvedVersion;
            node.ChecksumSha256 = checksumHex;
            node.MimeType = validatedMimeType;
            return node;
        }
        finally
        {
            if (File.Exists(tempPath))
            {
                try { File.Delete(tempPath); } catch { /* ignore */ }
            }
        }
    }

    public Task DeleteAsync(string virtualPath, WorkspaceWriteContext? ctx = null, CancellationToken ct = default)
    {
        var physicalPath = ResolveAndValidatePath(virtualPath, mustExist: true);

        if (File.Exists(physicalPath))
        {
            File.Delete(physicalPath);
            _logger.LogInformation(
                "Workspace file deleted: {Path}, user: {UserId}, tool: {ToolName}, conversation: {ConversationId}",
                physicalPath, ctx?.UserId, ctx?.ToolName, ctx?.ConversationId);
        }
        else if (Directory.Exists(physicalPath))
        {
            if (Directory.GetFileSystemEntries(physicalPath).Length > 0)
            {
                throw new IOException("只能删除空目录");
            }
            Directory.Delete(physicalPath);
            _logger.LogInformation(
                "Workspace directory deleted: {Path}, user: {UserId}, tool: {ToolName}, conversation: {ConversationId}",
                physicalPath, ctx?.UserId, ctx?.ToolName, ctx?.ConversationId);
        }

        return Task.CompletedTask;
    }

    public Task<bool> AuthorizeAsync(string virtualPath, WriteIntent intent, WorkspaceWriteContext? ctx = null, CancellationToken ct = default)
    {
        // M1 阶段默认放行，但保留钩子供未来审批网关接入。
        _logger.LogDebug(
            "Workspace authorize check: {Path}, intent: {Intent}, user: {UserId}, tool: {ToolName}",
            virtualPath, intent, ctx?.UserId, ctx?.ToolName);
        return Task.FromResult(true);
    }

    public string GetDownloadUrl(string virtualPath)
    {
        var normalized = NormalizeVirtualPath(virtualPath);
        return normalized;
    }

    /// <summary>
    /// 会话-文件索引挂钩（工作区对话隔离，H1/H2）：
    /// ctx 带 ConversationId 时把该文件幂等归集到对应会话，索引失败不阻塞主流程。
    /// </summary>
    private async Task RecordIndexAsync(string virtualPath, string kind, WorkspaceWriteContext? ctx, string? mimeType = null, long? sizeBytes = null, CancellationToken ct = default)
    {
        if (ctx == null) return;
        if (!long.TryParse(ctx.ConversationId, out var conversationId) || conversationId <= 0) return;
        await _items.RecordAsync(
            conversationId,
            ctx.UserId ?? "local",
            NormalizeVirtualPath(virtualPath),
            kind,
            mimeType: mimeType,
            sizeBytes: sizeBytes,
            source: ctx.Source ?? ctx.ToolName,
            ct: ct);
    }

    public (string VirtualPath, string PhysicalPath) ResolveGeneratedPath(string extension, string? customName = null)
    {
        var dateDir = DateTime.Now.ToString("yyyyMMdd");
        var baseName = string.IsNullOrEmpty(customName)
            ? Guid.NewGuid().ToString("N")[..8]
            : customName;
        var fileName = $"{baseName}_{DateTime.Now:HHmmssfff}.{extension.TrimStart('.')}";
        var relativePath = $"/workspace/outputs/{dateDir}/{fileName}";
        var physicalPath = ResolveAndValidatePath(relativePath, mustExist: false);
        return (relativePath, physicalPath);
    }

    public (string VirtualPath, string PhysicalPath) ResolveScratchPath(string extension, string? customName = null)
    {
        var dateDir = DateTime.Now.ToString("yyyyMMdd");
        var baseName = string.IsNullOrEmpty(customName)
            ? Guid.NewGuid().ToString("N")[..8]
            : customName;
        var fileName = $"{baseName}_{DateTime.Now:HHmmssfff}.{extension.TrimStart('.')}";
        var relativePath = $"/workspace/scratch/{dateDir}/{fileName}";
        var physicalPath = ResolveAndValidatePath(relativePath, mustExist: false);
        return (relativePath, physicalPath);
    }

    public (string VirtualPath, string PhysicalPath) ResolveUploadPath(string extension, string? customName = null, int version = 1)
    {
        var dateDir = DateTime.Now.ToString("yyyyMMdd");
        var extWithoutDot = extension.TrimStart('.').ToLowerInvariant();
        var baseName = string.IsNullOrWhiteSpace(customName)
            ? Guid.NewGuid().ToString("N")[..8]
            : SanitizeFileName(customName);

        var versionSuffix = version > 1 ? $"_v{version}" : string.Empty;
        var fileName = $"{baseName}{versionSuffix}_{DateTime.Now:HHmmssfff}.{extWithoutDot}";
        var relativePath = $"/workspace/uploads/{dateDir}/{fileName}";
        var physicalPath = ResolveAndValidatePath(relativePath, mustExist: false);
        return (relativePath, physicalPath);
    }

    public (string VirtualPath, string PhysicalPath) ResolveScriptPath(string? customName = null)
    {
        var baseName = string.IsNullOrWhiteSpace(customName)
            ? "script"
            : SanitizeFileName(customName);
        var fileName = $"{baseName}_{DateTime.Now:yyyyMMdd_HHmmssfff}.py";
        var relativePath = $"/workspace/scripts/{fileName}";
        var physicalPath = ResolveAndValidatePath(relativePath, mustExist: false);
        return (relativePath, physicalPath);
    }

    /// <summary>
    /// files/ 遗留目录退役（打磨任务2 S2）：语义与 scratch 重叠，新写入重定向到 scratch/；
    /// 目录保留在磁盘上，旧文件仍可读取，由 FileCleanupService 按 72h 自然清理。
    /// </summary>
    private string RedirectLegacyFilesPath(string virtualPath)
    {
        var normalized = NormalizeVirtualPath(virtualPath);
        const string legacyPrefix = "/workspace/files/";
        if (normalized.StartsWith(legacyPrefix, StringComparison.OrdinalIgnoreCase))
        {
            var redirected = "/workspace/scratch/" + normalized[legacyPrefix.Length..];
            _logger.LogInformation("files/ 目录已退役，写入重定向: {Old} -> {New}", normalized, redirected);
            return redirected;
        }
        return virtualPath;
    }

    private string ResolveAndValidatePath(string virtualPath, bool mustExist)
    {
        if (string.IsNullOrWhiteSpace(virtualPath))
        {
            throw new ArgumentException("路径不能为空");
        }

        var normalized = NormalizeVirtualPath(virtualPath);

        // 双根路由（打磨任务2 S4）：/workspace → 系统轨根；/project → 用户轨活跃项目根。
        // 三层校验（前缀/越界/符号链接）逻辑不变，只是白名单根按前缀选择。
        string rootPath;
        string relativePath;
        if (IsUnderVirtualRoot(normalized, "/workspace"))
        {
            rootPath = _rootPath;
            relativePath = normalized.Length <= "/workspace".Length
                ? string.Empty
                : normalized["/workspace/".Length..];
        }
        else if (IsUnderVirtualRoot(normalized, "/project"))
        {
            var projectRoot = _activeProjectRoot
                ?? throw new InvalidOperationException("未选择项目：/project 命名空间不可用，请先在工作区面板选择项目目录");
            rootPath = projectRoot;
            relativePath = normalized.Length <= "/project".Length
                ? string.Empty
                : normalized["/project/".Length..];
        }
        else
        {
            throw new ArgumentException($"路径必须以 /workspace/ 或 /project/ 开头: {virtualPath}");
        }

        var physicalPath = Path.GetFullPath(Path.Combine(rootPath, relativePath));
        var rootFullPath = Path.GetFullPath(rootPath).TrimEnd(Path.DirectorySeparatorChar, Path.AltDirectorySeparatorChar);

        if (!physicalPath.StartsWith(rootFullPath, StringComparison.OrdinalIgnoreCase))
        {
            throw new UnauthorizedAccessException($"路径越界: {virtualPath}");
        }

        // 拒绝符号链接逃逸
        if (File.Exists(physicalPath) || Directory.Exists(physicalPath))
        {
            try
            {
                var linkTarget = File.ResolveLinkTarget(physicalPath, returnFinalTarget: true);
                if (linkTarget != null)
                {
                    var targetFullPath = Path.GetFullPath(linkTarget.FullName).TrimEnd(Path.DirectorySeparatorChar, Path.AltDirectorySeparatorChar);
                    if (!targetFullPath.StartsWith(rootFullPath, StringComparison.OrdinalIgnoreCase))
                    {
                        throw new UnauthorizedAccessException($"符号链接越界: {virtualPath}");
                    }
                }
            }
            catch (UnauthorizedAccessException)
            {
                throw;
            }
            catch
            {
                // 非链接或解析失败时忽略
            }
        }

        if (mustExist && !File.Exists(physicalPath) && !Directory.Exists(physicalPath))
        {
            throw new FileNotFoundException($"路径不存在: {virtualPath}");
        }

        return physicalPath;
    }

    private string NormalizeVirtualPath(string virtualPath)
    {
        var p = virtualPath?.Trim().Replace("\\", "/") ?? "/workspace";
        if (!p.StartsWith("/"))
        {
            p = "/" + p;
        }
        // S4：/project 是合法的第二虚拟根，不再被强制改写为 /workspace/project
        if (!IsUnderVirtualRoot(p, "/workspace") && !IsUnderVirtualRoot(p, "/project"))
        {
            p = "/workspace" + p;
        }
        if (p.Length > 1 && p.EndsWith("/"))
        {
            p = p[..^1];
        }
        return p;
    }

    /// <summary>段级前缀判定：等于虚拟根，或位于其下（避免 /workspacex 这类误匹配）。</summary>
    private static bool IsUnderVirtualRoot(string normalized, string virtualRoot)
        => normalized.Equals(virtualRoot, StringComparison.OrdinalIgnoreCase)
           || normalized.StartsWith(virtualRoot + "/", StringComparison.OrdinalIgnoreCase);

    private string GetRelativeVirtualPath(string physicalPath)
    {
        var fullPath = Path.GetFullPath(physicalPath).TrimEnd(Path.DirectorySeparatorChar, Path.AltDirectorySeparatorChar);

        // 系统轨优先（S4）：工作区根内的路径恒映射 /workspace——即使项目根包含工作区根
        var workspaceRoot = Path.GetFullPath(_rootPath).TrimEnd(Path.DirectorySeparatorChar, Path.AltDirectorySeparatorChar);
        if (fullPath.StartsWith(workspaceRoot, StringComparison.OrdinalIgnoreCase))
        {
            var rel = fullPath[workspaceRoot.Length..].Replace("\\", "/");
            return "/workspace" + (rel.StartsWith("/") ? rel : "/" + rel);
        }

        var projectRoot = _activeProjectRoot;
        if (!string.IsNullOrEmpty(projectRoot))
        {
            var pr = Path.GetFullPath(projectRoot).TrimEnd(Path.DirectorySeparatorChar, Path.AltDirectorySeparatorChar);
            if (fullPath.StartsWith(pr, StringComparison.OrdinalIgnoreCase))
            {
                var rel = fullPath[pr.Length..].Replace("\\", "/");
                return "/project" + (rel.StartsWith("/") ? rel : "/" + rel);
            }
        }

        return "/workspace/" + Path.GetFileName(fullPath);
    }

    private WorkspaceNode ToFileNode(FileInfo info, string virtualPath, string? source = null)
    {
        var ext = Path.GetExtension(info.Name);
        return new WorkspaceNode
        {
            Name = info.Name,
            Path = virtualPath,
            Kind = WorkspaceNodeKind.File,
            SizeBytes = info.Length,
            MimeType = GetMimeType(ext),
            Source = source,
            CreatedAt = info.CreationTimeUtc,
            UpdatedAt = info.LastWriteTimeUtc,
            DownloadUrl = GetDownloadUrl(virtualPath)
        };
    }

    private static bool IsTextFile(string extension)
    {
        return TextExtensions.Contains(extension);
    }

    /// <summary>按扩展名查 MIME 类型（内联预览端点等场景使用），未知返回 application/octet-stream。</summary>
    public string GetMimeType(string extension) => LookupMimeType(extension);

    private static string LookupMimeType(string extension)
    {
        return MimeTypes.TryGetValue(extension, out var mime) ? mime : "application/octet-stream";
    }

    private static void CollectHeaderBytes(List<byte> header, byte[] buffer, int count)
    {
        if (header.Count >= 16) return;
        var take = Math.Min(count, 16 - header.Count);
        header.AddRange(buffer.AsSpan(0, take).ToArray());
    }

    private static string ValidateMimeType(string extension, byte[] header, string? declaredMimeType)
    {
        var ext = extension.StartsWith('.') ? extension : "." + extension;

        if (MagicSignatures.TryGetValue(ext, out var signature))
        {
            if (header.Length >= signature.Length &&
                header.AsSpan(0, signature.Length).SequenceEqual(signature))
            {
                return LookupMimeType(ext);
            }
            throw new InvalidOperationException($"文件签名与扩展名 {ext} 不匹配，可能存在 MIME 伪装");
        }

        if (!string.IsNullOrWhiteSpace(declaredMimeType))
        {
            return declaredMimeType;
        }

        return LookupMimeType(ext);
    }

    private static string SanitizeFileName(string fileName)
    {
        var name = Path.GetFileName(fileName).Trim();
        name = Regex.Replace(name, "[<>:\"\\\\|?*\\x00-\\x1f]", "_");
        name = Regex.Replace(name, "\\.{2,}", "_");
        if (string.IsNullOrWhiteSpace(name) || name.All(c => c == '.'))
        {
            name = "upload";
        }
        return name;
    }

    protected virtual Task CheckQuotaAsync(long requestedBytes, WorkspaceWriteContext? ctx, CancellationToken ct)
    {
        // M1 阶段占位：未来接入按用户/会话配额。
        return Task.CompletedTask;
    }
}
