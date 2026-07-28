package com.iris.workspace;

import com.iris.tools.core.ToolRuntimeException;
import org.springframework.stereotype.Component;

import java.io.IOException;
import java.nio.file.Files;
import java.nio.file.LinkOption;
import java.nio.file.Path;
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
                    "工作区路径不存在：" + logicalPath
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
        );
    }

    private enum TargetKind {
        FILE,
        DIRECTORY
    }

    public record ResolvedPath(String logicalPath, Path physicalPath) {
    }
}
