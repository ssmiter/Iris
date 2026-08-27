package com.iris.workspace;

import com.iris.tools.core.ToolRuntimeException;
import org.springframework.stereotype.Service;

import java.io.BufferedReader;
import java.io.IOException;
import java.io.InputStream;
import java.io.InputStreamReader;
import java.io.PushbackInputStream;
import java.nio.ByteBuffer;
import java.nio.charset.CharacterCodingException;
import java.nio.charset.Charset;
import java.nio.charset.CodingErrorAction;
import java.nio.charset.StandardCharsets;
import java.nio.file.DirectoryStream;
import java.nio.file.FileSystems;
import java.nio.file.Files;
import java.nio.file.LinkOption;
import java.nio.file.Path;
import java.nio.file.PathMatcher;
import java.nio.file.attribute.BasicFileAttributes;
import java.time.Instant;
import java.util.ArrayDeque;
import java.util.ArrayList;
import java.util.Comparator;
import java.util.Deque;
import java.util.List;
import java.util.Locale;
import java.util.Set;
import java.util.function.BooleanSupplier;
import java.util.regex.Matcher;
import java.util.regex.Pattern;
import java.util.regex.PatternSyntaxException;

/**
 * 工作区文本文件的有界读取、遍历与搜索。
 *
 * 该服务不认识 Tool schema，也不做审批；它只执行经 WorkspacePathGuard
 * 解析后的客观文件操作，并让所有可能无界的维度都有明确预算。
 */
@Service
public class WorkspaceFileService {

    private static final long MAX_READ_BYTES = 32L * 1024 * 1024;
    private static final long MAX_SEARCH_FILE_BYTES = 4L * 1024 * 1024;
    private static final int MAX_READ_CHARACTERS = 60_000;
    private static final int MAX_SEARCH_LINE_CHARACTERS = 16_000;
    private static final int MAX_SCANNED_ENTRIES = 10_000;
    private static final int MAX_SEARCH_FILES = 2_000;
    private static final int SAMPLE_BYTES = 8_192;
    private static final Set<String> GENERATED_DIRECTORIES = Set.of(
            ".git", ".svn", ".idea", "node_modules", "target",
            "dist", "build", "coverage", ".next", ".gradle"
    );
    private static final Pattern UNSAFE_REGEX = Pattern.compile(
            "\\([^)]*[+*][^)]*\\)[+*]"
    );
    private static final Comparator<Path> PATH_ORDER =
            Comparator.comparing(
                    (Path path) -> path.getFileName().toString()
                            .toLowerCase(Locale.ROOT)
            ).thenComparing(path -> path.getFileName().toString());

    private final WorkspacePathGuard pathGuard;

    public WorkspaceFileService(WorkspacePathGuard pathGuard) {
        this.pathGuard = pathGuard;
    }

    public ReadResult read(
            Path workspaceRoot,
            ReadRequest request,
            BooleanSupplier cancelled
    ) throws IOException {
        WorkspacePathGuard.ResolvedPath resolved =
                pathGuard.resolveExistingFile(workspaceRoot, request.path());
        long size = Files.size(resolved.physicalPath());
        if (size > MAX_READ_BYTES) {
            throw new ToolRuntimeException(
                    "workspace_file_too_large",
                    "文件为 " + size + " 字节，超过单次读取上限；"
                            + "请先用 search_files 定位内容"
            );
        }
        TextEncoding encoding = detectEncoding(resolved.physicalPath());
        List<NumberedLine> lines = new ArrayList<>();
        int lineNumber = 0;
        int projectedCharacters = 0;
        boolean hasMore = false;
        boolean lineTruncated = false;

        try (BufferedReader reader = openReader(
                resolved.physicalPath(),
                encoding
        )) {
            String line;
            while ((line = reader.readLine()) != null) {
                checkCancelled(cancelled);
                lineNumber++;
                if (lineNumber < request.startLine()) {
                    continue;
                }
                if (lines.size() >= request.lineCount()) {
                    hasMore = true;
                    break;
                }
                int remaining = MAX_READ_CHARACTERS - projectedCharacters;
                if (remaining <= 0) {
                    hasMore = true;
                    break;
                }
                String projected = line;
                if (projected.length() > remaining) {
                    projected = projected.substring(0, remaining);
                    lineTruncated = true;
                    hasMore = true;
                }
                lines.add(new NumberedLine(lineNumber, projected));
                projectedCharacters += projected.length();
                if (lineTruncated) {
                    break;
                }
            }
        }
        if (lineNumber < request.startLine() && size > 0) {
            throw new ToolRuntimeException(
                    "workspace_line_out_of_range",
                    "起始行为 " + request.startLine()
                            + "，但文件读取到第 " + lineNumber + " 行即结束"
            );
        }
        Integer nextStartLine = hasMore && !lineTruncated
                ? (lines.isEmpty()
                        ? request.startLine()
                        : lines.getLast().number() + 1)
                : null;
        return new ReadResult(
                resolved.logicalPath(),
                encoding.label(),
                size,
                List.copyOf(lines),
                size == 0,
                hasMore,
                lineTruncated,
                nextStartLine
        );
    }

    public TextDocument readDocument(
            Path workspaceRoot,
            String path,
            long maxBytes,
            BooleanSupplier cancelled
    ) throws IOException {
        WorkspacePathGuard.ResolvedPath resolved =
                pathGuard.resolveExistingFile(workspaceRoot, path);
        long size = Files.size(resolved.physicalPath());
        if (size > maxBytes) {
            throw new ToolRuntimeException(
                    "workspace_file_too_large_to_edit",
                    "文件为 " + size + " 字节，超过本次文本编辑上限"
            );
        }
        TextEncoding encoding = detectEncoding(resolved.physicalPath());
        StringBuilder content = new StringBuilder((int) Math.min(
                size,
                Integer.MAX_VALUE
        ));
        try (BufferedReader reader = openReader(
                resolved.physicalPath(),
                encoding
        )) {
            char[] buffer = new char[8_192];
            int read;
            while ((read = reader.read(buffer)) != -1) {
                if (read == 0) {
                    continue;
                }
                checkCancelled(cancelled);
                content.append(buffer, 0, read);
            }
        }
        return new TextDocument(
                resolved.logicalPath(),
                resolved.physicalPath(),
                content.toString(),
                encoding.charset(),
                encoding.label(),
                encoding.bomBytes(),
                size
        );
    }

    public ListResult list(
            Path workspaceRoot,
            ListRequest request,
            BooleanSupplier cancelled
    ) throws IOException {
        WorkspacePathGuard.ResolvedPath base =
                pathGuard.resolveExistingDirectory(
                        workspaceRoot,
                        request.path()
                );
        GlobFilter matcher = compileGlob(request.pattern());
        List<FileEntry> entries = new ArrayList<>();
        Deque<DirectoryFrame> pending = new ArrayDeque<>();
        pending.push(new DirectoryFrame(base.physicalPath(), 0));
        int scanned = 0;
        int skipped = 0;
        boolean scanTruncated = false;

        while (!pending.isEmpty()) {
            checkCancelled(cancelled);
            DirectoryFrame frame = pending.pop();
            List<Path> children = childrenOf(frame.path());
            List<Path> directories = new ArrayList<>();
            for (Path child : children) {
                checkCancelled(cancelled);
                if (++scanned > MAX_SCANNED_ENTRIES) {
                    scanTruncated = true;
                    break;
                }
                String relativeToBase = logicalRelative(
                        base.physicalPath(),
                        child
                );
                String name = child.getFileName().toString();
                if (!request.includeHidden() && isHidden(child, name)) {
                    skipped++;
                    continue;
                }
                BasicFileAttributes attributes = Files.readAttributes(
                        child,
                        BasicFileAttributes.class,
                        LinkOption.NOFOLLOW_LINKS
                );
                boolean link = Files.isSymbolicLink(child)
                        || attributes.isSymbolicLink();
                String kind = link
                        ? "link"
                        : attributes.isDirectory()
                                ? "directory"
                                : attributes.isRegularFile()
                                        ? "file"
                                        : "other";
                if (matcher == null || matcher.matches(relativeToBase)) {
                    entries.add(new FileEntry(
                            pathGuard.logicalPath(workspaceRoot, child),
                            kind,
                            attributes.isRegularFile()
                                    ? attributes.size()
                                    : null,
                            attributes.lastModifiedTime().toInstant()
                    ));
                }
                if (request.recursive()
                        && attributes.isDirectory()
                        && !link
                        && frame.depth() + 1 < request.maxDepth()) {
                    if (!request.includeGenerated()
                            && GENERATED_DIRECTORIES.contains(
                                    name.toLowerCase(Locale.ROOT)
                            )) {
                        skipped++;
                    } else {
                        directories.add(child);
                    }
                }
            }
            if (scanTruncated) {
                break;
            }
            for (int index = directories.size() - 1; index >= 0; index--) {
                pending.push(new DirectoryFrame(
                        directories.get(index),
                        frame.depth() + 1
                ));
            }
        }
        // 排序即相关性：最近修改的排前面，平局按路径，截断保留的即最相关头部
        entries.sort(Comparator.comparing(FileEntry::modifiedAt)
                .reversed()
                .thenComparing(FileEntry::path));
        int totalEntries = entries.size();
        int from = Math.min(Math.max(request.offset(), 0), totalEntries);
        int to = Math.min(from + request.maxResults(), totalEntries);
        return new ListResult(
                base.logicalPath(),
                List.copyOf(entries.subList(from, to)),
                totalEntries,
                scanned,
                skipped,
                scanTruncated
        );
    }

    public SearchResult search(
            Path workspaceRoot,
            SearchRequest request,
            BooleanSupplier cancelled
    ) throws IOException {
        WorkspacePathGuard.ResolvedPath base =
                pathGuard.resolveExistingDirectory(
                        workspaceRoot,
                        request.path()
                );
        GlobFilter matcher = compileGlob(request.glob());
        Pattern regex = compileSearchPattern(request);
        List<CandidateFile> candidates = new ArrayList<>();
        Deque<Path> pending = new ArrayDeque<>();
        pending.push(base.physicalPath());
        int candidateFiles = 0;
        int searchedFiles = 0;
        int skippedFiles = 0;
        int scannedEntries = 0;
        boolean scanTruncated = false;

        // 第一阶段：走完目录树收集候选文件；真正的文本扫描放到
        // 第二阶段按最近修改排序后进行，命中预算截断时保留最相关头部
        while (!pending.isEmpty()) {
            checkCancelled(cancelled);
            Path directory = pending.pop();
            List<Path> children = childrenOf(directory);
            List<Path> directories = new ArrayList<>();
            for (Path child : children) {
                checkCancelled(cancelled);
                if (++scannedEntries > MAX_SCANNED_ENTRIES) {
                    scanTruncated = true;
                    break;
                }
                String name = child.getFileName().toString();
                if (!request.includeHidden() && isHidden(child, name)) {
                    skippedFiles++;
                    continue;
                }
                BasicFileAttributes attributes = Files.readAttributes(
                        child,
                        BasicFileAttributes.class,
                        LinkOption.NOFOLLOW_LINKS
                );
                boolean link = Files.isSymbolicLink(child)
                        || attributes.isSymbolicLink();
                if (attributes.isDirectory() && !link) {
                    if (!request.includeGenerated()
                            && GENERATED_DIRECTORIES.contains(
                                    name.toLowerCase(Locale.ROOT)
                            )) {
                        skippedFiles++;
                    } else {
                        directories.add(child);
                    }
                    continue;
                }
                if (!attributes.isRegularFile() || link) {
                    skippedFiles++;
                    continue;
                }
                String relativeToBase = logicalRelative(
                        base.physicalPath(),
                        child
                );
                if (matcher != null && !matcher.matches(relativeToBase)) {
                    continue;
                }
                candidateFiles++;
                if (candidateFiles > MAX_SEARCH_FILES) {
                    scanTruncated = true;
                    break;
                }
                if (attributes.size() > MAX_SEARCH_FILE_BYTES) {
                    skippedFiles++;
                    continue;
                }
                candidates.add(new CandidateFile(
                        child,
                        attributes.lastModifiedTime().toInstant()
                ));
            }
            if (scanTruncated) {
                break;
            }
            for (int index = directories.size() - 1; index >= 0; index--) {
                pending.push(directories.get(index));
            }
        }
        candidates.sort(Comparator.comparing(CandidateFile::modifiedAt)
                .reversed()
                .thenComparing(CandidateFile::path));
        List<SearchMatch> matches = new ArrayList<>();
        int matchBudget = Math.max(request.offset(), 0) + request.maxResults();
        int processed = 0;
        for (CandidateFile candidate : candidates) {
            checkCancelled(cancelled);
            processed++;
            TextEncoding encoding;
            try {
                encoding = detectEncoding(candidate.path());
            } catch (ToolRuntimeException exception) {
                skippedFiles++;
                continue;
            }
            searchedFiles++;
            searchFile(
                    workspaceRoot,
                    candidate,
                    encoding,
                    regex,
                    matchBudget,
                    matches,
                    cancelled
            );
            if (matches.size() >= matchBudget) {
                break;
            }
        }
        int unsearchedCandidates = candidates.size() - processed;
        int from = Math.min(Math.max(request.offset(), 0), matches.size());
        return new SearchResult(
                base.logicalPath(),
                List.copyOf(matches.subList(from, matches.size())),
                candidateFiles,
                searchedFiles,
                skippedFiles,
                scannedEntries,
                scanTruncated,
                unsearchedCandidates
        );
    }

    private void searchFile(
            Path workspaceRoot,
            CandidateFile candidate,
            TextEncoding encoding,
            Pattern pattern,
            int maxResults,
            List<SearchMatch> matches,
            BooleanSupplier cancelled
    ) throws IOException {
        try (BufferedReader reader = openReader(candidate.path(), encoding)) {
            String line;
            int lineNumber = 0;
            while ((line = reader.readLine()) != null) {
                checkCancelled(cancelled);
                lineNumber++;
                String searchable = line.length() > MAX_SEARCH_LINE_CHARACTERS
                        ? line.substring(0, MAX_SEARCH_LINE_CHARACTERS)
                        : line;
                Matcher matcher = pattern.matcher(searchable);
                if (!matcher.find()) {
                    continue;
                }
                String preview = searchable;
                if (preview.length() > 500) {
                    preview = preview.substring(0, 500);
                }
                matches.add(new SearchMatch(
                        pathGuard.logicalPath(workspaceRoot, candidate.path()),
                        lineNumber,
                        matcher.start() + 1,
                        preview,
                        candidate.modifiedAt()
                ));
                if (matches.size() >= maxResults) {
                    return;
                }
            }
        }
    }

    private Pattern compileSearchPattern(SearchRequest request) {
        if (request.query().length() > 256) {
            throw new ToolRuntimeException(
                    "search_query_too_long",
                    "搜索内容不能超过 256 个字符"
            );
        }
        String expression = request.regex()
                ? request.query()
                : Pattern.quote(request.query());
        if (request.regex() && UNSAFE_REGEX.matcher(expression).find()) {
            throw new ToolRuntimeException(
                    "unsafe_search_regex",
                    "正则包含容易造成灾难性回溯的嵌套量词；请缩小为更直接的表达式"
            );
        }
        int flags = request.caseSensitive()
                ? 0
                : Pattern.CASE_INSENSITIVE | Pattern.UNICODE_CASE;
        try {
            return Pattern.compile(expression, flags);
        } catch (PatternSyntaxException exception) {
            throw new ToolRuntimeException(
                    "invalid_search_regex",
                    "搜索正则无效：" + exception.getDescription()
            );
        }
    }

    private GlobFilter compileGlob(String rawPattern) {
        if (rawPattern == null || rawPattern.isBlank()) {
            return null;
        }
        String normalized = rawPattern.replace('\\', '/');
        if (normalized.startsWith("/")
                || normalized.contains(":")
                || List.of(normalized.split("/")).contains("..")) {
            throw new ToolRuntimeException(
                    "invalid_workspace_glob",
                    "glob 必须是相对于搜索目录的模式，不能越过工作区"
            );
        }
        try {
            String platformPattern = normalized.replace(
                    '/',
                    java.io.File.separatorChar
            );
            PathMatcher matcher = FileSystems.getDefault().getPathMatcher(
                    "glob:" + platformPattern
            );
            PathMatcher rootMatcher = normalized.startsWith("**/")
                    ? FileSystems.getDefault().getPathMatcher(
                            "glob:" + platformPattern.substring(3)
                    )
                    : null;
            return new GlobFilter(matcher, rootMatcher);
        } catch (RuntimeException exception) {
            throw new ToolRuntimeException(
                    "invalid_workspace_glob",
                    "glob 模式无效"
            );
        }
    }

    private TextEncoding detectEncoding(Path file) throws IOException {
        byte[] sample;
        try (InputStream input = Files.newInputStream(file)) {
            sample = input.readNBytes(SAMPLE_BYTES);
        }
        if (startsWith(sample, 0xEF, 0xBB, 0xBF)) {
            return new TextEncoding(StandardCharsets.UTF_8, "UTF-8", 3);
        }
        if (startsWith(sample, 0xFF, 0xFE)) {
            return new TextEncoding(StandardCharsets.UTF_16LE, "UTF-16LE", 2);
        }
        if (startsWith(sample, 0xFE, 0xFF)) {
            return new TextEncoding(StandardCharsets.UTF_16BE, "UTF-16BE", 2);
        }
        for (byte value : sample) {
            if (value == 0) {
                throw unsupportedText();
            }
        }
        try {
            StandardCharsets.UTF_8.newDecoder()
                    .onMalformedInput(CodingErrorAction.REPORT)
                    .onUnmappableCharacter(CodingErrorAction.REPORT)
                    .decode(ByteBuffer.wrap(sample));
        } catch (CharacterCodingException exception) {
            throw unsupportedText();
        }
        return new TextEncoding(StandardCharsets.UTF_8, "UTF-8", 0);
    }

    private BufferedReader openReader(Path file, TextEncoding encoding)
            throws IOException {
        PushbackInputStream input = new PushbackInputStream(
                Files.newInputStream(file),
                3
        );
        if (encoding.bomBytes() > 0) {
            input.readNBytes(encoding.bomBytes());
        }
        return new BufferedReader(new InputStreamReader(
                input,
                encoding.charset().newDecoder()
                        .onMalformedInput(CodingErrorAction.REPORT)
                        .onUnmappableCharacter(CodingErrorAction.REPORT)
        ));
    }

    private List<Path> childrenOf(Path directory) throws IOException {
        List<Path> children = new ArrayList<>();
        try (DirectoryStream<Path> stream = Files.newDirectoryStream(directory)) {
            stream.forEach(children::add);
        }
        children.sort(PATH_ORDER);
        return children;
    }

    private String logicalRelative(Path base, Path child) {
        return base.relativize(child).toString().replace('\\', '/');
    }

    private boolean isHidden(Path path, String name) {
        if (name.startsWith(".")) {
            return true;
        }
        try {
            return Files.isHidden(path);
        } catch (IOException exception) {
            return true;
        }
    }

    private boolean startsWith(byte[] bytes, int... prefix) {
        if (bytes.length < prefix.length) {
            return false;
        }
        for (int index = 0; index < prefix.length; index++) {
            if (Byte.toUnsignedInt(bytes[index]) != prefix[index]) {
                return false;
            }
        }
        return true;
    }

    private ToolRuntimeException unsupportedText() {
        return new ToolRuntimeException(
                "workspace_file_not_text",
                "文件不是受支持的文本编码；首版支持 UTF-8 和带 BOM 的 UTF-16"
        );
    }

    private void checkCancelled(BooleanSupplier cancelled) {
        if (cancelled.getAsBoolean()) {
            throw new ToolRuntimeException(
                    "tool_cancelled",
                    "用户已停止当前任务，工作区扫描随即结束"
            );
        }
    }

    public record ReadRequest(String path, int startLine, int lineCount) {
    }

    public record NumberedLine(int number, String text) {
    }

    public record ReadResult(
            String path,
            String encoding,
            long sizeBytes,
            List<NumberedLine> lines,
            boolean empty,
            boolean truncated,
            boolean lineTruncated,
            Integer nextStartLine
    ) {
    }

    public record ListRequest(
            String path,
            boolean recursive,
            int maxDepth,
            String pattern,
            boolean includeHidden,
            boolean includeGenerated,
            int offset,
            int maxResults
    ) {
    }

    public record FileEntry(
            String path,
            String kind,
            Long sizeBytes,
            Instant modifiedAt
    ) {
    }

    public record ListResult(
            String path,
            List<FileEntry> entries,
            int totalEntries,
            int scannedEntries,
            int skippedEntries,
            boolean scanTruncated
    ) {
    }

    public record SearchRequest(
            String path,
            String query,
            boolean regex,
            boolean caseSensitive,
            String glob,
            boolean includeHidden,
            boolean includeGenerated,
            int offset,
            int maxResults
    ) {
    }

    public record SearchMatch(
            String path,
            int line,
            int column,
            String preview,
            Instant modifiedAt
    ) {
    }

    public record SearchResult(
            String path,
            List<SearchMatch> matches,
            int candidateFiles,
            int searchedFiles,
            int skippedFiles,
            int scannedEntries,
            boolean scanTruncated,
            int unsearchedCandidates
    ) {
    }

    public record TextDocument(
            String path,
            Path physicalPath,
            String content,
            Charset charset,
            String encoding,
            int bomBytes,
            long sizeBytes
    ) {
    }

    private record TextEncoding(
            Charset charset,
            String label,
            int bomBytes
    ) {
    }

    private record DirectoryFrame(Path path, int depth) {
    }

    private record CandidateFile(Path path, Instant modifiedAt) {
    }

    private record GlobFilter(
            PathMatcher matcher,
            PathMatcher rootMatcher
    ) {
        private boolean matches(String logicalPath) {
            Path path = Path.of(logicalPath.replace(
                    '/',
                    java.io.File.separatorChar
            ));
            return matcher.matches(path)
                    || (rootMatcher != null && rootMatcher.matches(path));
        }
    }
}
