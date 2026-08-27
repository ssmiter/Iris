package com.iris.workspace;

import com.iris.tools.core.ToolRuntimeException;
import org.springframework.stereotype.Component;

import java.io.IOException;
import java.nio.file.DirectoryStream;
import java.nio.file.Files;
import java.nio.file.LinkOption;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.Comparator;
import java.util.List;
import java.util.Locale;
import java.util.Set;

/**
 * 工作区逻辑路径与物理路径之间的唯一安全边界。
 *
 * Tool 只持有稳定的逻辑相对路径；盘符、UNC、链接解析和 root containment
 * 全部收敛在这里，便于未来把物理访问替换为 staged I/O 或 Sandbox Helper。
 */
@Component
public class WorkspacePathGuard {

    private static final Set<String> WINDOWS_DEVICE_NAMES = Set.of(
            "con", "prn", "aux", "nul",
            "com1", "com2", "com3", "com4", "com5",
            "com6", "com7", "com8", "com9",
            "lpt1", "lpt2", "lpt3", "lpt4", "lpt5",
            "lpt6", "lpt7", "lpt8", "lpt9"
    );

    private static final Set<String> GENERATED_DIRECTORIES = Set.of(
            ".git", ".svn", ".idea", "node_modules", "target",
            "dist", "build", "coverage", ".next", ".gradle"
    );
    private static final int MAX_SUGGESTION_ENTRIES = 2_000;
    private static final int MAX_SUGGESTION_DEPTH = 6;

    public String normalizeFile(String rawPath) {
        return normalize(rawPath, false);
    }

    public String normalizeDirectory(String rawPath) {
        return normalize(
                rawPath == null || rawPath.isBlank() ? "." : rawPath,
                true
        );
    }

    public ResolvedPath resolveExistingFile(
            Path configuredRoot,
            String rawPath
    ) throws IOException {
        return resolveExisting(
                configuredRoot,
                normalizeFile(rawPath),
                TargetKind.FILE
        );
    }

    public ResolvedPath resolveExistingDirectory(
            Path configuredRoot,
            String rawPath
    ) throws IOException {
        return resolveExisting(
                configuredRoot,
                normalizeDirectory(rawPath),
                TargetKind.DIRECTORY
        );
    }

    public ResolvedPath resolveForWrite(
            Path configuredRoot,
            String rawPath
    ) throws IOException {
        String logicalPath = normalizeFile(rawPath);
        return resolveForMutation(
                configuredRoot,
                logicalPath,
                TargetKind.FILE
        );
    }

    public ResolvedPath resolveDirectoryForWrite(
            Path configuredRoot,
            String rawPath
    ) throws IOException {
        String logicalPath = normalizeDirectory(rawPath);
        if (".".equals(logicalPath)) {
            throw new ToolRuntimeException(
                    "invalid_workspace_path",
                    "工作区根目录不能作为目录写操作的目标"
            );
        }
        return resolveForMutation(
                configuredRoot,
                logicalPath,
                TargetKind.DIRECTORY
        );
    }

    private ResolvedPath resolveForMutation(
            Path configuredRoot,
            String logicalPath,
            TargetKind kind
    ) throws IOException {
        Path root = realRoot(configuredRoot);
        Path target = root.resolve(toPlatformPath(logicalPath)).normalize();
        requireInside(root, target);

        Path parent = target.getParent();
        if (parent == null
                || !Files.exists(parent, LinkOption.NOFOLLOW_LINKS)
                || !Files.isDirectory(parent, LinkOption.NOFOLLOW_LINKS)) {
            throw new ToolRuntimeException(
                    "workspace_parent_not_found",
                    "目标的直接父目录不存在；请先创建父目录"
            );
        }
        Path realParent = parent.toRealPath();
        requireInside(root, realParent);

        if (Files.exists(target, LinkOption.NOFOLLOW_LINKS)) {
            if (Files.isSymbolicLink(target)) {
                throw new ToolRuntimeException(
                        "workspace_write_target_is_link",
                        "写入目标不能是符号链接：" + logicalPath
                );
            }
            Path realTarget = target.toRealPath();
            requireInside(root, realTarget);
            boolean valid = switch (kind) {
                case FILE -> Files.isRegularFile(realTarget);
                case DIRECTORY -> Files.isDirectory(realTarget);
            };
            if (!valid) {
                throw new ToolRuntimeException(
                        kind == TargetKind.FILE
                                ? "workspace_target_not_file"
                                : "workspace_target_not_directory",
                        "目标存在但不是"
                                + (kind == TargetKind.FILE
                                        ? "普通文件："
                                        : "目录：")
                                + logicalPath
                );
            }
        }
        return new ResolvedPath(logicalPath, target);
    }

    public String logicalPath(Path configuredRoot, Path physicalPath)
            throws IOException {
        Path root = realRoot(configuredRoot);
        Path absolute = physicalPath.toAbsolutePath().normalize();
        requireInside(root, absolute);
        String relative = root.relativize(absolute).toString()
                .replace('\\', '/');
        return relative.isBlank() ? "." : relative;
    }

    private ResolvedPath resolveExisting(
            Path configuredRoot,
            String logicalPath,
            TargetKind kind
    ) throws IOException {
        Path root = realRoot(configuredRoot);
        Path candidate = root.resolve(toPlatformPath(logicalPath)).normalize();
        requireInside(root, candidate);
        if (!Files.exists(candidate, LinkOption.NOFOLLOW_LINKS)) {
            throw new ToolRuntimeException(
                    "workspace_path_not_found",
                    missingPathMessage(root, logicalPath)
            );
        }

        Path realTarget = candidate.toRealPath();
        requireInside(root, realTarget);
        boolean valid = switch (kind) {
            case FILE -> Files.isRegularFile(realTarget);
            case DIRECTORY -> Files.isDirectory(realTarget);
        };
        if (!valid) {
            throw new ToolRuntimeException(
                    kind == TargetKind.FILE
                            ? "workspace_target_not_file"
                            : "workspace_target_not_directory",
                    "工作区路径不是"
                            + (kind == TargetKind.FILE ? "普通文件：" : "目录：")
                            + logicalPath
            );
        }
        return new ResolvedPath(logicalPath, realTarget);
    }

    private String normalize(String rawPath, boolean allowRoot) {
        if (rawPath == null || rawPath.isBlank()) {
            throw new ToolRuntimeException(
                    "invalid_workspace_path",
                    "工作区路径不能为空"
            );
        }
        if (rawPath.indexOf('\0') >= 0
                || rawPath.indexOf(':') >= 0
                || rawPath.startsWith("/")
                || rawPath.startsWith("\\")
                || rawPath.startsWith("//")
                || rawPath.startsWith("\\\\")) {
            throw outsideFence(
                    "只能使用工作区内相对路径，不能使用盘符、UNC 或 device path"
            );
        }

        Path logical;
        try {
            logical = Path.of(rawPath);
        } catch (RuntimeException exception) {
            throw new ToolRuntimeException(
                    "invalid_workspace_path",
                    "工作区路径格式无效"
            );
        }
        if (logical.isAbsolute()) {
            throw outsideFence("只能使用工作区内相对路径");
        }
        for (Path segmentPath : logical) {
            String segment = segmentPath.toString();
            if ("..".equals(segment)) {
                throw outsideFence("路径不能包含 .. 逃逸段");
            }
            validateWindowsSegment(segment);
        }

        String normalized = logical.normalize().toString()
                .replace('\\', '/');
        if (normalized.isBlank() || ".".equals(normalized)) {
            if (allowRoot) {
                return ".";
            }
            throw new ToolRuntimeException(
                    "invalid_workspace_path",
                    "路径必须指向工作区内文件"
            );
        }
        return normalized;
    }

    private void validateWindowsSegment(String segment) {
        if (segment.isBlank() || ".".equals(segment)) {
            return;
        }
        if (segment.endsWith(" ") || segment.endsWith(".")) {
            throw new ToolRuntimeException(
                    "invalid_workspace_path",
                    "Windows 路径段不能以空格或句点结尾：" + segment
            );
        }
        String baseName = segment;
        int dot = baseName.indexOf('.');
        if (dot >= 0) {
            baseName = baseName.substring(0, dot);
        }
        if (WINDOWS_DEVICE_NAMES.contains(
                baseName.toLowerCase(Locale.ROOT)
        )) {
            throw new ToolRuntimeException(
                    "invalid_workspace_path",
                    "Windows 设备名不能作为文件路径段：" + segment
            );
        }
    }

    private Path realRoot(Path configuredRoot) throws IOException {
        if (configuredRoot == null) {
            throw new ToolRuntimeException(
                    "workspace_unavailable",
                    "当前任务没有可用工作区"
            );
        }
        return configuredRoot.toRealPath();
    }

    private Path toPlatformPath(String logicalPath) {
        return ".".equals(logicalPath)
                ? Path.of("")
                : Path.of(logicalPath.replace('/', java.io.File.separatorChar));
    }

    private void requireInside(Path root, Path candidate) {
        if (!candidate.startsWith(root)) {
            throw outsideFence("目标路径越过工作区围栏");
        }
    }

    private ToolRuntimeException outsideFence(String detail) {
        return new ToolRuntimeException(
                "workspace_path_outside_fence",
                "路径越界：" + detail
                        + "。Iris 只允许操作工作区根目录内的相对路径，"
                        + "越界请求一律拒绝，不会读写任何文件"
        );
    }

    /**
     * 给「路径不存在」失败分支用的完整教学消息：
     * 说明当前工作区根，并在工作区内找最接近的真实路径作为建议。
     */
    public String describeMissingPath(Path configuredRoot, String logicalPath)
            throws IOException {
        return missingPathMessage(realRoot(configuredRoot), logicalPath);
    }

    private String missingPathMessage(Path root, String logicalPath) {
        StringBuilder message = new StringBuilder()
                .append("工作区内找不到路径 ").append(logicalPath)
                .append("；当前工作区根是 ").append(root)
                .append("。请先用 list_files 确认实际路径再重试");
        List<String> similar = findSimilarPaths(root, logicalPath);
        if (!similar.isEmpty()) {
            message.append("。最接近的现有路径：")
                    .append(String.join("、", similar));
        }
        return message.toString();
    }

    private List<String> findSimilarPaths(Path root, String logicalPath) {
        List<String> paths = new ArrayList<>();
        collectPaths(root, root, 0, paths);
        String target = logicalPath.toLowerCase(Locale.ROOT);
        int threshold = Math.max(2, target.length() / 3);
        return paths.stream()
                .filter(path -> Math.abs(path.length() - target.length())
                        <= threshold)
                .map(path -> new SimilarPath(
                        path,
                        editDistance(
                                target,
                                path.toLowerCase(Locale.ROOT)
                        )
                ))
                .filter(candidate -> candidate.distance() <= threshold)
                .sorted(Comparator.comparingInt(SimilarPath::distance))
                .limit(3)
                .map(SimilarPath::path)
                .toList();
    }

    private void collectPaths(
            Path root,
            Path directory,
            int depth,
            List<String> paths
    ) {
        if (depth > MAX_SUGGESTION_DEPTH
                || paths.size() >= MAX_SUGGESTION_ENTRIES) {
            return;
        }
        try (DirectoryStream<Path> stream =
                     Files.newDirectoryStream(directory)) {
            for (Path child : stream) {
                if (paths.size() >= MAX_SUGGESTION_ENTRIES) {
                    return;
                }
                String name = child.getFileName().toString();
                boolean isDirectory = Files.isDirectory(
                        child,
                        LinkOption.NOFOLLOW_LINKS
                );
                if (isDirectory && GENERATED_DIRECTORIES.contains(
                        name.toLowerCase(Locale.ROOT)
                )) {
                    continue;
                }
                String relative = root.relativize(child).toString()
                        .replace('\\', '/');
                paths.add(isDirectory ? relative + "/" : relative);
                if (isDirectory) {
                    collectPaths(root, child, depth + 1, paths);
                }
            }
        } catch (IOException ignored) {
            // 相似路径只是提示；列不出来时退回不带建议的消息
        }
    }

    private int editDistance(String left, String right) {
        int[] previous = new int[right.length() + 1];
        for (int column = 0; column <= right.length(); column++) {
            previous[column] = column;
        }
        for (int row = 1; row <= left.length(); row++) {
            int[] current = new int[right.length() + 1];
            current[0] = row;
            for (int column = 1; column <= right.length(); column++) {
                int cost = left.charAt(row - 1) == right.charAt(column - 1)
                        ? 0
                        : 1;
                current[column] = Math.min(
                        Math.min(current[column - 1] + 1, previous[column] + 1),
                        previous[column - 1] + cost
                );
            }
            previous = current;
        }
        return previous[right.length()];
    }

    private record SimilarPath(String path, int distance) {
    }

    private enum TargetKind {
        FILE,
        DIRECTORY
    }

    public record ResolvedPath(String logicalPath, Path physicalPath) {
    }
}
