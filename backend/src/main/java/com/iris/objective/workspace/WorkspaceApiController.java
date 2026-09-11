package com.iris.objective.workspace;

import com.iris.execution.BackgroundShellService;
import com.iris.workspace.WorkspaceFileMutationService;
import com.iris.workspace.WorkspaceFileMutationService.TargetState;
import com.iris.workspace.WorkspaceFileService;
import com.iris.workspace.WorkspacePathGuard;
import com.iris.workspace.WorkspaceRootRegistry;
import com.iris.workspace.WorkspaceService;
import com.iris.tools.core.ToolRuntimeException;
import org.springframework.http.HttpHeaders;
import org.springframework.http.HttpStatus;
import org.springframework.http.MediaType;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.DeleteMapping;
import org.springframework.web.bind.annotation.RequestParam;
import org.springframework.web.bind.annotation.RestController;
import org.springframework.web.multipart.MultipartFile;
import org.springframework.web.server.ResponseStatusException;
import reactor.core.publisher.Mono;
import reactor.core.scheduler.Schedulers;

import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.LinkOption;
import java.nio.file.Path;
import java.time.Instant;
import java.util.ArrayList;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.Set;

/**
 * 工作区文件 API（WonWork 契约形状，docs/46）。
 *
 * <p>纯客观执行：模型通道的路径经 {@link WorkspaceService#resolve} 围栏解析
 * （fail-close），审批/裁决由前端 Runtime 负责。默认路径是工作区内相对路径
 * （正斜杠）；浏览面板可显式带 browse=true 访问用户已选择的物理目录。</p>
 */
@RestController
@RequestMapping("/api/workspace")
public class WorkspaceApiController {

    private static final int DEFAULT_LINE_COUNT = 2000;
    private static final int MAX_LINE_COUNT = 100_000;
    private static final int GREP_MAX_MATCHES = 200;
    private static final int GLOB_MAX_RESULTS = 500;

    private final WorkspaceService workspace;
    private final WorkspaceFileService files;
    private final WorkspaceFileMutationService mutations;
    private final WorkspaceRootRegistry roots;
    private final WorkspacePathGuard pathGuard;
    private final BackgroundShellService backgroundShell;

    public WorkspaceApiController(
            WorkspaceService workspace,
            WorkspaceFileService files,
            WorkspaceFileMutationService mutations,
            WorkspaceRootRegistry roots,
            WorkspacePathGuard pathGuard,
            BackgroundShellService backgroundShell
    ) {
        this.workspace = workspace;
        this.files = files;
        this.mutations = mutations;
        this.roots = roots;
        this.pathGuard = pathGuard;
        this.backgroundShell = backgroundShell;
    }

    public record WorkspaceNode(
            String name,
            String path,
            String kind,
            Long sizeBytes,
            String modifiedAt
    ) { }

    public record WriteRequest(
            String path,
            String content,
            Boolean append,
            String expectedContent,
            String encoding,
            Boolean browse
    ) { }

    public record RenameRequest(
            String path,
            String name,
            String newName,
            Boolean browse
    ) { }

    public record MkdirRequest(String path, String name, Boolean browse) { }

    public record GrepRequest(
            String path,
            String pattern,
            String glob,
            Boolean caseInsensitive,
            Integer maxMatches,
            Integer maxResults
    ) { }

    /** content 是前端检索适配器的稳定字段；text 保留为 JSON 读取时的兼容别名。 */
    public record GrepMatch(String path, int line, String content) {
        public String text() { return content; }
    }

    public record GrepResponse(
            List<GrepMatch> matches,
            boolean truncated,
            int scannedFiles
    ) { }

    public record GlobRequest(String path, String pattern, Integer maxResults) { }

    public record GlobResponse(
            List<String> matches,
            boolean truncated,
            int scannedFiles
    ) { }

    @GetMapping("/info")
    public Map<String, String> info() {
        return Map.of("rootPath", workspace.root().toString());
    }

    @GetMapping("/list")
    public Mono<Map<String, Object>> list(
            @RequestParam(value = "path", defaultValue = "") String path,
            @RequestParam(value = "recursive", defaultValue = "false")
            boolean recursive,
            @RequestParam(value = "browse", defaultValue = "false") boolean browse
    ) {
        return Mono.fromCallable(() -> {
            BrowseLocation location = browseLocation(
                    path == null || path.isBlank() ? "/workspace" : path,
                    browse, true, true);
            var result = files.list(
                    location.root(),
                    new WorkspaceFileService.ListRequest(
                            location.relative(), recursive, recursive ? 8 : 1, null,
                            false, false, 0, 5_000
                    ),
                    () -> false
            );
            List<WorkspaceNode> nodes = new ArrayList<>();
            for (var entry : result.entries()) {
                String entryPath = entry.path();
                String name = entryPath.contains("/")
                        ? entryPath.substring(entryPath.lastIndexOf('/') + 1)
                        : entryPath;
                nodes.add(new WorkspaceNode(
                        name,
                        location.displayChild(entryPath),
                        "directory".equals(entry.kind()) ? "folder" : "file",
                        entry.sizeBytes(),
                        entry.modifiedAt() == null
                                ? null : entry.modifiedAt().toString()
                ));
            }
            return Map.<String, Object>of(
                    "path", location.display(),
                    "nodes", nodes,
                    "recursive", recursive,
                    "truncated", result.scanTruncated()
            );
        }).subscribeOn(Schedulers.boundedElastic())
          .onErrorMap(IOException.class, this::badRequest);
    }

    @GetMapping("/read")
    public Mono<Map<String, Object>> read(
            @RequestParam("path") String path,
            @RequestParam(value = "offset", required = false) Integer offset,
            @RequestParam(value = "limit", required = false) Integer limit,
            @RequestParam(value = "browse", defaultValue = "false") boolean browse
    ) {
        return Mono.fromCallable(() -> {
            BrowseLocation location = browseLocation(path, browse, true, false);
            int startLine = offset == null ? 1 : Math.max(1, offset);
            int lineCount = limit == null
                    ? DEFAULT_LINE_COUNT
                    : Math.min(Math.max(1, limit), MAX_LINE_COUNT);
            final WorkspaceFileService.ReadResult result;
            try {
                result = files.read(
                        location.root(),
                        new WorkspaceFileService.ReadRequest(
                                location.relative(), startLine, lineCount
                        ),
                        () -> false
                );
            } catch (ToolRuntimeException failure) {
                if (!"workspace_file_not_text".equals(failure.code())) throw failure;
                Path binary = location.physical();
                Map<String, Object> response = new java.util.LinkedHashMap<>();
                response.put("path", location.display());
                response.put("isText", false);
                response.put("sizeBytes", Files.size(binary));
                response.put("mimeType", probeMimeType(binary));
                response.put("updatedAt", Files.getLastModifiedTime(binary)
                        .toInstant().toString());
                response.put("downloadUrl", "/api/workspace/download?path="
                        + java.net.URLEncoder.encode(location.display(), StandardCharsets.UTF_8));
                return response;
            }
            StringBuilder content = new StringBuilder();
            for (var line : result.lines()) {
                content.append(line.text()).append('\n');
            }
            int totalLines;
            if (result.nextStartLine() == null) {
                totalLines = result.lines().isEmpty()
                        ? 0
                        : result.lines()
                                .get(result.lines().size() - 1).number();
            } else {
                var full = files.read(
                        location.root(),
                        new WorkspaceFileService.ReadRequest(
                                location.relative(), 1, MAX_LINE_COUNT + 1
                        ),
                        () -> false
                );
                totalLines = full.lines().isEmpty()
                        ? 0
                        : full.lines().get(full.lines().size() - 1).number();
            }
            Path physical = location.physical();
            Map<String, Object> response = new java.util.LinkedHashMap<>();
            response.put("path", location.display());
            response.put("content", content.toString());
            response.put("isText", true);
            response.put("sizeBytes", result.sizeBytes());
            response.put("mimeType", probeMimeType(physical));
            response.put("updatedAt", Files.getLastModifiedTime(physical)
                    .toInstant().toString());
            response.put("truncated", result.truncated());
            response.put("totalLines", totalLines);
            response.put("downloadUrl", "/api/workspace/download?path="
                    + java.net.URLEncoder.encode(location.display(), StandardCharsets.UTF_8));
            return response;
        }).subscribeOn(Schedulers.boundedElastic())
          .onErrorMap(IOException.class, this::badRequest);
    }

    @PostMapping("/write")
    public Mono<WorkspaceNode> write(@RequestBody WriteRequest request) {
        return Mono.fromCallable(() -> {
            if (request.path() == null || request.path().isBlank()) {
                throw new ResponseStatusException(
                        HttpStatus.BAD_REQUEST, "path 不能为空");
            }
            BrowseLocation location = browseLocation(
                    request.path(), Boolean.TRUE.equals(request.browse()), false, false);
            Path root = location.root();
            TargetState target = mutations.inspect(root, location.relative());
            if (request.expectedContent() != null && target.exists()) {
                String current = Files.readString(
                        target.physicalPath(), StandardCharsets.UTF_8);
                if (!request.expectedContent().equals(current)) {
                    throw new ResponseStatusException(
                            HttpStatus.CONFLICT,
                            "文件内容在写入前已变化，请重新读取后再写入");
                }
            }
            String content = request.content() == null ? "" : request.content();
            if ("base64".equalsIgnoreCase(request.encoding())) {
                final byte[] bytes;
                try {
                    bytes = java.util.Base64.getDecoder().decode(content);
                } catch (IllegalArgumentException exception) {
                    throw new ResponseStatusException(
                            HttpStatus.BAD_REQUEST, "base64 内容格式无效");
                }
                if (Boolean.TRUE.equals(request.append()) && target.exists()) {
                    byte[] previous = Files.readAllBytes(target.physicalPath());
                    byte[] combined = new byte[previous.length + bytes.length];
                    System.arraycopy(previous, 0, combined, 0, previous.length);
                    System.arraycopy(bytes, 0, combined, previous.length, bytes.length);
                    mutations.writeBytes(target, combined);
                } else {
                    mutations.writeBytes(target, bytes);
                }
                return nodeOf(target.physicalPath(), location.display());
            }
            if (Boolean.TRUE.equals(request.append()) && target.exists()) {
                String previous = new String(
                        Files.readAllBytes(target.physicalPath()),
                        StandardCharsets.UTF_8
                );
                mutations.writeUtf8(
                        target,
                        previous + content
                );
            } else {
                mutations.writeUtf8(target, content);
            }
            return nodeOf(target.physicalPath(), location.display());
        }).subscribeOn(Schedulers.boundedElastic())
          .onErrorMap(IOException.class, this::badRequest);
    }

    @PostMapping("/upload")
    public Mono<Map<String, Object>> upload(
            @RequestParam(value = "path", required = false) String path,
            @RequestParam("file") MultipartFile file,
            @RequestParam(value = "declaredMimeType", required = false)
            String declaredMimeType
    ) {
        return Mono.fromCallable(() -> {
            String safeName = file.getOriginalFilename() == null
                    ? "upload.bin"
                    : Path.of(file.getOriginalFilename()).getFileName().toString();
            if (safeName.isBlank() || safeName.equals(".") || safeName.equals("..")) {
                safeName = "upload.bin";
            }
            String targetPath = path == null || path.isBlank()
                    ? "uploads/" + safeName
                    : path;
            if (path == null || path.isBlank()) {
                Files.createDirectories(workspace.root().resolve("uploads"));
            }
            TargetState target = mutations.inspect(workspace.root(), targetPath);
            mutations.writeBytes(target, file.getBytes());
            WorkspaceNode node = nodeOf(target.physicalPath(), targetPath);
            Map<String, Object> response = new java.util.LinkedHashMap<>();
            response.put("path", node.path());
            response.put("name", node.name());
            response.put("sizeBytes", node.sizeBytes() == null ? 0L : node.sizeBytes());
            response.put("mimeType", declaredMimeType == null || declaredMimeType.isBlank()
                    ? probeMimeType(target.physicalPath()) : declaredMimeType);
            response.put("status", "Ready");
            response.put("version", 1);
            response.put("createdAt", Instant.now().toString());
            response.put("updatedAt", Files.getLastModifiedTime(target.physicalPath())
                    .toInstant().toString());
            return response;
        }).subscribeOn(Schedulers.boundedElastic())
          .onErrorMap(IOException.class, this::badRequest);
    }

    @PostMapping("/mkdir")
    public Mono<WorkspaceNode> mkdir(@RequestBody MkdirRequest request) {
        return Mono.fromCallable(() -> {
            String combined = request.name() == null || request.name().isBlank()
                    ? request.path() : join(request.path(), request.name());
            if (combined == null || combined.isBlank()) {
                throw new ResponseStatusException(HttpStatus.BAD_REQUEST, "path 不能为空");
            }
            BrowseLocation location = browseLocation(
                    combined, Boolean.TRUE.equals(request.browse()), false, true);
            Path root = location.root();
            TargetState target = mutations.inspectDirectory(root, location.relative());
            if (target.exists()) {
                throw new ResponseStatusException(
                        HttpStatus.CONFLICT, "目录已存在: " + location.display());
            }
            mutations.createDirectory(target);
            return nodeOf(target.physicalPath(), location.display());
        }).subscribeOn(Schedulers.boundedElastic())
          .onErrorMap(IOException.class, this::badRequest);
    }

    @PostMapping("/rename")
    public Mono<WorkspaceNode> rename(@RequestBody RenameRequest request) {
        return Mono.fromCallable(() -> {
            String requestedName = request.name() == null || request.name().isBlank()
                    ? request.newName() : request.name();
            if (requestedName == null || requestedName.isBlank()
                    || requestedName.contains("/")
                    || requestedName.contains("\\")) {
                throw new ResponseStatusException(
                        HttpStatus.BAD_REQUEST, "非法名称");
            }
            // 重命名作用于文件和目录；先按文件解析，只有明确的
            // target_not_file 才回退到目录解析，避免把其他路径错误吞掉。
            BrowseLocation sourceLocation = browseAnyLocation(
                    request.path(), Boolean.TRUE.equals(request.browse()));
            String parent = parentOf(sourceLocation.relative());
            String renamed = join(parent, requestedName);
            Path root = sourceLocation.root();
            TargetState source = inspectAny(root, sourceLocation);
            if (!source.exists()) {
                throw new ResponseStatusException(
                        HttpStatus.NOT_FOUND, "路径不存在: " + request.path());
            }
            TargetState destination = inspectTarget(root, renamed);
            if (destination.exists()) {
                throw new ResponseStatusException(
                        HttpStatus.CONFLICT, "同名已存在: " + renamed);
            }
            mutations.moveFile(source, destination);
            return nodeOf(destination.physicalPath(), sourceLocation.displayChild(renamed));
        }).subscribeOn(Schedulers.boundedElastic())
          .onErrorMap(IOException.class, this::badRequest);
    }

    @DeleteMapping("/delete")
    public Mono<Map<String, Object>> delete(
            @RequestParam("path") String path,
            @RequestParam(value = "recursive", defaultValue = "false")
            boolean recursive,
            @RequestParam(value = "browse", defaultValue = "false") boolean browse,
            @RequestParam(value = "recycle", defaultValue = "false") boolean recycle
    ) {
        return Mono.fromCallable(() -> {
            BrowseLocation location = browseAnyLocation(path, browse);
            Path root = location.root();
            TargetState target = inspectAny(root, location);
            if (!target.exists()) {
                throw new ResponseStatusException(
                        HttpStatus.NOT_FOUND, "路径不存在: " + path);
            }
            int deletedEntries;
            if (target.kind()
                    == WorkspaceFileMutationService.ResourceKind.DIRECTORY) {
                if (recursive) {
                    deletedEntries = mutations.deleteDirectoryRecursively(target);
                } else {
                    mutations.requireEmptyDirectory(target);
                    mutations.deleteDirectory(target);
                    deletedEntries = 1;
                }
            } else {
                mutations.deleteFile(target);
                deletedEntries = 1;
            }
            return Map.<String, Object>of(
                    "deleted", true,
                    "deletedEntries", deletedEntries,
                    "recycled", false,
                    "recycleRequested", recycle,
                    "path", location.display());
        }).subscribeOn(Schedulers.boundedElastic())
          .onErrorMap(IOException.class, this::badRequest);
    }

    @PostMapping("/grep")
    public Mono<GrepResponse> grep(@RequestBody GrepRequest request) {
        return Mono.fromCallable(() -> {
            String requestedPath = request.path() == null || request.path().isBlank()
                    ? "/workspace" : request.path();
            BrowseLocation location = browseLocation(requestedPath, false, true, true);
            Integer requestedMax = request.maxResults() != null
                    ? request.maxResults() : request.maxMatches();
            int maxMatches = requestedMax == null
                    ? GREP_MAX_MATCHES
                    : Math.min(Math.max(1, requestedMax), 1_000);
            var result = files.search(
                    location.root(),
                    new WorkspaceFileService.SearchRequest(
                            location.relative(),
                            request.pattern(),
                            true,
                            !Boolean.TRUE.equals(request.caseInsensitive()),
                            request.glob(),
                            false,
                            false,
                            0,
                            maxMatches
                    ),
                    () -> false
            );
            List<GrepMatch> matches = new ArrayList<>();
            for (var match : result.matches()) {
                matches.add(new GrepMatch(
                        location.displayChild(match.path()),
                        match.line(),
                        match.preview()
                ));
            }
            return new GrepResponse(
                    matches,
                    result.unsearchedCandidates() > 0,
                    result.searchedFiles()
            );
        }).subscribeOn(Schedulers.boundedElastic())
          .onErrorMap(IOException.class, this::badRequest);
    }

    @PostMapping("/glob")
    public Mono<GlobResponse> glob(@RequestBody GlobRequest request) {
        return Mono.fromCallable(() -> {
            String requestedPath = request.path() == null || request.path().isBlank()
                    ? "/workspace" : request.path();
            BrowseLocation location = browseLocation(requestedPath, false, true, true);
            int maxResults = request.maxResults() == null
                    ? GLOB_MAX_RESULTS
                    : Math.min(Math.max(1, request.maxResults()), 2_000);
            var result = files.list(
                    location.root(),
                    new WorkspaceFileService.ListRequest(
                            location.relative(),
                            true, 12, request.pattern(),
                            false, false, 0, maxResults
                    ),
                    () -> false
            );
            List<String> matches = result.entries().stream()
                    .map(WorkspaceFileService.FileEntry::path)
                    .map(location::displayChild)
                    .toList();
            return new GlobResponse(
                    matches, result.scanTruncated(), result.scannedEntries());
        }).subscribeOn(Schedulers.boundedElastic())
          .onErrorMap(IOException.class, this::badRequest);
    }

    /** 统一下载端点：完整字节只在用户显式下载时返回，不进入对话上下文。 */
    @GetMapping("/download")
    public Mono<ResponseEntity<byte[]>> download(
            @RequestParam("path") String path,
            @RequestParam(value = "browse", defaultValue = "false") boolean browse
    ) {
        return Mono.fromCallable(() -> {
            BrowseLocation location = browseLocation(path, browse, true, false);
            long size = Files.size(location.physical());
            if (size > 64L * 1024 * 1024) {
                throw new ResponseStatusException(
                        HttpStatus.PAYLOAD_TOO_LARGE, "下载文件超过 64 MB 上限");
            }
            byte[] body = Files.readAllBytes(location.physical());
            String fileName = location.physical().getFileName().toString();
            MediaType mediaType = safeMediaType(probeMimeType(location.physical()));
            HttpHeaders headers = new HttpHeaders();
            headers.setContentType(mediaType);
            headers.setContentLength(body.length);
            headers.setContentDisposition(
                    org.springframework.http.ContentDisposition.attachment()
                            .filename(fileName, StandardCharsets.UTF_8).build());
            return new ResponseEntity<>(body, headers, HttpStatus.OK);
        }).subscribeOn(Schedulers.boundedElastic())
          .onErrorMap(IOException.class, this::badRequest);
    }

    /** 内联预览端点：图片/文本供浏览面板使用，仍有明确响应预算。 */
    @GetMapping("/preview")
    public Mono<ResponseEntity<byte[]>> preview(
            @RequestParam("path") String path,
            @RequestParam(value = "browse", defaultValue = "false") boolean browse
    ) {
        return Mono.fromCallable(() -> {
            BrowseLocation location = browseLocation(path, browse, true, false);
            long size = Files.size(location.physical());
            if (size > 16L * 1024 * 1024) {
                throw new ResponseStatusException(
                        HttpStatus.PAYLOAD_TOO_LARGE, "预览文件超过 16 MB 上限，请下载后查看");
            }
            byte[] body = Files.readAllBytes(location.physical());
            HttpHeaders headers = new HttpHeaders();
            headers.setContentType(safeMediaType(probeMimeType(location.physical())));
            headers.setContentLength(body.length);
            headers.setCacheControl("private, max-age=30");
            return new ResponseEntity<>(body, headers, HttpStatus.OK);
        }).subscribeOn(Schedulers.boundedElastic())
          .onErrorMap(IOException.class, this::badRequest);
    }

    /** 让浏览面板在 Windows「我的电脑」中展示固定盘，不触碰任何文件内容。 */
    @GetMapping("/drives")
    public Mono<Map<String, Object>> drives() {
        return Mono.fromCallable(() -> {
            List<Map<String, Object>> values = new ArrayList<>();
            for (Path root : java.nio.file.FileSystems.getDefault().getRootDirectories()) {
                try {
                    Map<String, Object> drive = new java.util.LinkedHashMap<>();
                    drive.put("path", root.toString().replace('\\', '/')
                            .replaceAll("/$", "") + "/");
                    drive.put("label", root.getFileName() == null
                            ? root.toString() : root.getFileName().toString());
                    drive.put("totalBytes", Files.getFileStore(root).getTotalSpace());
                    drive.put("freeBytes", Files.getFileStore(root).getUsableSpace());
                    values.add(drive);
                } catch (IOException ignored) {
                    // 某些可移动盘在枚举期间不可用，跳过而非让整个面板失败。
                }
            }
            return Map.<String, Object>of("drives", values);
        }).subscribeOn(Schedulers.boundedElastic());
    }

    @GetMapping("/shell/tasks/{taskId}/wait")
    public Mono<BackgroundShellService.Event> waitShellTask(
            @org.springframework.web.bind.annotation.PathVariable String taskId
    ) {
        return Mono.fromCallable(() -> backgroundShell.waitFor(taskId))
                .subscribeOn(Schedulers.boundedElastic());
    }

    @PostMapping("/shell/tasks/{taskId}/stop")
    public Mono<Map<String, Object>> stopShellTask(
            @org.springframework.web.bind.annotation.PathVariable String taskId
    ) {
        return Mono.fromSupplier(() -> Map.<String, Object>of(
                "stopped", backgroundShell.stop(taskId),
                "taskId", taskId
        )).subscribeOn(Schedulers.boundedElastic());
    }

    /** 系统文件管理器动作只接受用户 browse 通道；模型工具没有该入口。 */
    @PostMapping("/reveal")
    public Mono<Map<String, Object>> reveal(@RequestBody BrowseRequest request) {
        return systemOpen(request, true);
    }

    @PostMapping("/open")
    public Mono<Map<String, Object>> open(@RequestBody BrowseRequest request) {
        return systemOpen(request, false);
    }

    /** 约定文件是上下文的低频事实源：只返回工作区内常见层级，内容有界。 */
    @GetMapping("/conventions")
    public Mono<Map<String, Object>> conventions() {
        return Mono.fromCallable(() -> {
            List<Map<String, Object>> values = new ArrayList<>();
            Set<String> candidates = Set.of(
                    "AGENTS.md", "CLAUDE.md", ".codex/instructions.md",
                    ".claude/CLAUDE.md");
            int skipped = 0;
            for (String candidate : candidates) {
                Path file = workspace.root().resolve(candidate).normalize();
                if (!file.startsWith(workspace.root())
                        || !Files.isRegularFile(file, LinkOption.NOFOLLOW_LINKS)) {
                    continue;
                }
                try {
                    String content = Files.readString(file, StandardCharsets.UTF_8);
                    boolean truncated = content.length() > 30_000;
                    if (truncated) content = content.substring(0, 30_000);
                    Map<String, Object> value = new java.util.LinkedHashMap<>();
                    value.put("path", workspace.root().relativize(file).toString().replace('\\', '/'));
                    value.put("scope", candidate.startsWith(".codex") ? "workspace" : "project");
                    value.put("content", content);
                    value.put("truncated", truncated);
                    values.add(value);
                } catch (IOException ignored) {
                    skipped++;
                }
            }
            return Map.<String, Object>of("files", values, "skipped", skipped);
        }).subscribeOn(Schedulers.boundedElastic());
    }

    @GetMapping("/roots")
    public Mono<WorkspaceRootRegistry.Roots> listRoots() {
        return Mono.fromSupplier(roots::snapshot);
    }

    @PostMapping("/roots")
    public Mono<Map<String, Object>> registerRoot(@RequestBody RootRequest request) {
        return Mono.fromCallable(() -> {
            Path registered = roots.register(request.path(), request.scope());
            WorkspaceRootRegistry.Roots snapshot = roots.snapshot();
            return Map.<String, Object>of(
                    "path", roots.displayPath(registered),
                    "roots", snapshot.roots(),
                    "sessionRoots", snapshot.sessionRoots());
        }).subscribeOn(Schedulers.boundedElastic());
    }

    @DeleteMapping("/roots")
    public Mono<Void> unregisterRoot(@RequestParam("path") String path) {
        return Mono.fromRunnable(() -> {
            try {
                roots.unregister(path);
            } catch (IOException exception) {
                throw badRequest(exception);
            }
        }).subscribeOn(Schedulers.boundedElastic()).then();
    }

    private Mono<Map<String, Object>> systemOpen(BrowseRequest request, boolean reveal) {
        return Mono.fromCallable(() -> {
            if (!Boolean.TRUE.equals(request.browse())) {
                throw new ResponseStatusException(HttpStatus.FORBIDDEN,
                        "open/reveal 只允许由浏览面板显式发起");
            }
            BrowseLocation location = browseAnyLocation(request.path(), true);
            Path target = location.physical();
            if (reveal && Files.isRegularFile(target)) {
                new ProcessBuilder("explorer.exe", "/select,", target.toString()).start();
            } else {
                java.awt.Desktop.getDesktop().open(target.toFile());
            }
            return Map.<String, Object>of("path", location.display());
        }).subscribeOn(Schedulers.boundedElastic());
    }

    private BrowseLocation browseLocation(
            String rawPath,
            boolean browse,
            boolean existing,
            boolean directory
    ) throws IOException {
        String path = rawPath == null || rawPath.isBlank() ? "/workspace" : rawPath.trim();
        boolean virtualWorkspace = path.equals("/workspace")
                || path.equals("workspace")
                || path.startsWith("/workspace/")
                || path.startsWith("workspace/");
        // 物理路径在模型工具侧也允许通过，但必须先进入登记根；browse 只影响
        // UI 动作语义，不是绕过路径围栏的开关。
        if (virtualWorkspace || !looksAbsolute(path)) {
            String relative = stripWorkspacePrefix(path);
            if (directory) {
                relative = pathGuard.normalizeDirectory(relative);
            } else if (existing || !relative.equals(".")) {
                relative = pathGuard.normalizeFile(relative);
            }
            Path physical = existing
                    ? (directory
                        ? pathGuard.resolveExistingDirectory(workspace.root(), relative).physicalPath()
                        : pathGuard.resolveExistingFile(workspace.root(), relative).physicalPath())
                    : workspace.root().resolve(relative.replace('/', java.io.File.separatorChar)).normalize();
            return new BrowseLocation(workspace.root(), relative, physical, true);
        }

        Path physical;
        try {
            physical = Path.of(path.replace('/', java.io.File.separatorChar))
                    .toAbsolutePath().normalize();
        } catch (RuntimeException exception) {
            throw new ToolRuntimeException("workspace_path_invalid", "物理路径格式无效：" + path);
        }
        if (!browse && !roots.allows(physical)) {
            throw new ResponseStatusException(
                    HttpStatus.CONFLICT,
                    "目录尚未登记；请先在浏览面板选择‘授权给助手’",
                    new ToolRuntimeException(
                            "directory_not_registered", "目录尚未登记：" + path));
        }
        Path selectedRoot = roots.bestRoot(physical);
        // browse=true 是用户本人在文件管理器中的显式动作，可从任意盘符开始；
        // 模型通道仍必须命中登记根。盘符根只作为浏览的临时锚点，不会写入登记表。
        if (selectedRoot == null && browse) selectedRoot = physical.getRoot();
        if (selectedRoot == null) {
            throw new ToolRuntimeException("directory_not_registered", "目录尚未登记：" + path);
        }
        if (existing) {
            if (!Files.exists(physical, LinkOption.NOFOLLOW_LINKS)) {
                throw new ToolRuntimeException("workspace_path_not_found", "路径不存在：" + path);
            }
            physical = physical.toRealPath();
        } else {
            Path parent = physical.getParent();
            if (parent == null || (!browse && !roots.allows(parent))) {
                throw new ToolRuntimeException("directory_not_registered", "父目录尚未登记：" + path);
            }
        }
        String relative = selectedRoot.relativize(physical).toString().replace('\\', '/');
        if (relative.isBlank()) relative = ".";
        if (directory && existing && !Files.isDirectory(physical, LinkOption.NOFOLLOW_LINKS)) {
            throw new ToolRuntimeException("workspace_target_not_directory", "路径不是目录：" + path);
        }
        if (!directory && existing && !Files.isRegularFile(physical, LinkOption.NOFOLLOW_LINKS)) {
            throw new ToolRuntimeException("workspace_target_not_file", "路径不是文件：" + path);
        }
        return new BrowseLocation(selectedRoot, relative, physical, false);
    }

    /** 需要同时支持文件/目录的用户动作（重命名、删除、打开）。 */
    private BrowseLocation browseAnyLocation(String rawPath, boolean browse)
            throws IOException {
        try {
            return browseLocation(rawPath, browse, true, false);
        } catch (ToolRuntimeException failure) {
            if (!"workspace_target_not_file".equals(failure.code())) {
                throw failure;
            }
            return browseLocation(rawPath, browse, true, true);
        }
    }

    private TargetState inspectAny(Path root, BrowseLocation location)
            throws IOException {
        return Files.isDirectory(location.physical(), LinkOption.NOFOLLOW_LINKS)
                ? mutations.inspectDirectory(root, location.relative())
                : mutations.inspect(root, location.relative());
    }

    private TargetState inspectTarget(Path root, String relative)
            throws IOException {
        Path physical = root.resolve(relative.replace('/', java.io.File.separatorChar))
                .normalize();
        return Files.isDirectory(physical, LinkOption.NOFOLLOW_LINKS)
                ? mutations.inspectDirectory(root, relative)
                : mutations.inspect(root, relative);
    }

    private String stripWorkspacePrefix(String path) {
        if (path.equals("/workspace") || path.equals("workspace")) return ".";
        if (path.startsWith("/workspace/")) return path.substring("/workspace/".length());
        if (path.startsWith("workspace/")) return path.substring("workspace/".length());
        return path;
    }

    private boolean looksAbsolute(String path) {
        return path.matches("^[A-Za-z]:[\\\\/].*")
                || path.startsWith("\\\\") || path.startsWith("//");
    }

    private String probeMimeType(Path path) {
        try {
            String value = Files.probeContentType(path);
            if (value != null && !value.isBlank()) return value;
        } catch (IOException ignored) { }
        String name = path.getFileName() == null ? "" : path.getFileName().toString().toLowerCase(Locale.ROOT);
        if (name.endsWith(".md") || name.endsWith(".txt") || name.endsWith(".json")
                || name.endsWith(".java") || name.endsWith(".ts") || name.endsWith(".tsx")
                || name.endsWith(".css") || name.endsWith(".html")) return "text/plain";
        return "application/octet-stream";
    }

    private MediaType safeMediaType(String value) {
        try { return MediaType.parseMediaType(value); }
        catch (RuntimeException ignored) { return MediaType.APPLICATION_OCTET_STREAM; }
    }

    public record BrowseRequest(String path, Boolean browse) { }

    public record RootRequest(String path, String scope) { }

    private record BrowseLocation(
            Path root,
            String relative,
            Path physical,
            boolean workspaceVirtual
    ) {
        String display() {
            if (workspaceVirtual) {
                return "/workspace" + (".".equals(relative) || relative.isBlank()
                        ? "" : "/" + relative);
            }
            return root.toString().replace('\\', '/')
                    + (".".equals(relative) || relative.isBlank() ? "" : "/" + relative);
        }

        String displayChild(String child) {
            if (workspaceVirtual) return "/workspace/" + child;
            return root.toString().replace('\\', '/') + "/" + child;
        }
    }

    private WorkspaceNode nodeOf(Path physical, String logical)
            throws IOException {
        boolean directory = java.nio.file.Files.isDirectory(physical);
        Long size = directory
                ? null
                : java.nio.file.Files.size(physical);
        Instant modified = java.nio.file.Files
                .getLastModifiedTime(physical).toInstant();
        String name = logical.contains("/")
                ? logical.substring(logical.lastIndexOf('/') + 1)
                : logical;
        return new WorkspaceNode(
                name,
                logical,
                directory ? "folder" : "file",
                size,
                modified.toString()
        );
    }

    private String join(String parent, String name) {
        if (name == null || name.isBlank()) {
            throw new ResponseStatusException(
                    HttpStatus.BAD_REQUEST, "name 不能为空");
        }
        if (parent == null || parent.isBlank()) {
            return name;
        }
        return parent.replaceAll("/+$", "") + "/" + name;
    }

    private String parentOf(String path) {
        int slash = path.lastIndexOf('/');
        return slash < 0 ? "" : path.substring(0, slash);
    }

    private ResponseStatusException badRequest(IOException failure) {
        return new ResponseStatusException(
                HttpStatus.BAD_REQUEST, failure.getMessage());
    }
}
