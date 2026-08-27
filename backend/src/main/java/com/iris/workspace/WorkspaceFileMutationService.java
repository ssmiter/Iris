package com.iris.workspace;

import com.iris.tools.core.ToolRuntimeException;
import org.springframework.stereotype.Service;

import java.io.IOException;
import java.io.ByteArrayOutputStream;
import java.io.InputStream;
import java.io.OutputStream;
import java.nio.charset.Charset;
import java.nio.charset.StandardCharsets;
import java.nio.file.AtomicMoveNotSupportedException;
import java.nio.file.Files;
import java.nio.file.LinkOption;
import java.nio.file.Path;
import java.nio.file.StandardCopyOption;
import java.security.DigestInputStream;
import java.security.MessageDigest;
import java.security.NoSuchAlgorithmException;
import java.time.Instant;
import java.util.HexFormat;
import java.util.function.BooleanSupplier;

/**
 * 工作区写入的版本、文本快照与同目录原子替换语义。
 */
@Service
public class WorkspaceFileMutationService {

    private static final long MAX_EDIT_BYTES = 4L * 1024 * 1024;

    private final WorkspacePathGuard pathGuard;
    private final WorkspaceFileService fileService;

    public WorkspaceFileMutationService(
            WorkspacePathGuard pathGuard,
            WorkspaceFileService fileService
    ) {
        this.pathGuard = pathGuard;
        this.fileService = fileService;
    }

    public TargetState inspect(Path workspaceRoot, String path)
            throws IOException {
        WorkspacePathGuard.ResolvedPath resolved =
                pathGuard.resolveForWrite(workspaceRoot, path);
        Path target = resolved.physicalPath();
        if (!Files.exists(target, LinkOption.NOFOLLOW_LINKS)) {
            return new TargetState(
                    resolved.logicalPath(),
                    target,
                    ResourceKind.FILE,
                    false,
                    "absent",
                    0,
                    null
            );
        }
        if (!Files.isRegularFile(target, LinkOption.NOFOLLOW_LINKS)) {
            throw new ToolRuntimeException(
                    "workspace_path_not_regular_file",
                    "当前文件原语只接受普通文件：" + resolved.logicalPath()
            );
        }
        return new TargetState(
                resolved.logicalPath(),
                target,
                ResourceKind.FILE,
                true,
                versionOf(target),
                Files.size(target),
                Files.getLastModifiedTime(target).toInstant()
        );
    }

    public WorkspaceFileService.TextDocument readForEdit(
            Path workspaceRoot,
            String path,
            BooleanSupplier cancelled
    ) throws IOException {
        return fileService.readDocument(
                workspaceRoot,
                path,
                MAX_EDIT_BYTES,
                cancelled
        );
    }

    public String versionOf(Path target) throws IOException {
        if (!Files.exists(target, LinkOption.NOFOLLOW_LINKS)) {
            return "absent";
        }
        MessageDigest digest = sha256();
        try (DigestInputStream input = new DigestInputStream(
                Files.newInputStream(target),
                digest
        )) {
            input.transferTo(OutputStream.nullOutputStream());
        }
        return HexFormat.of().formatHex(digest.digest());
    }

    public String versionOf(TargetState target) throws IOException {
        return currentVersion(target);
    }

    public void requireVersion(TargetState target, String expected)
            throws IOException {
        String current = currentVersion(target);
        if (!current.equals(expected)) {
            throw new ToolRuntimeException(
                    "workspace_file_version_changed",
                    "文件在准备或审批后发生变化；请重新读取并发起新的操作"
            );
        }
    }

    public void writeUtf8(TargetState target, String content)
            throws IOException {
        writeAtomically(
                target,
                content.getBytes(StandardCharsets.UTF_8)
        );
    }

    public void writeDocument(
            TargetState target,
            WorkspaceFileService.TextDocument source,
            String content
    ) throws IOException {
        writeAtomically(
                target,
                encode(content, source.charset(), source.bomBytes())
        );
    }

    public void writeBytes(TargetState target, byte[] content)
            throws IOException {
        writeAtomically(target, content);
    }

    /**
     * 目标不存在时的教学消息：含当前工作区根与最接近的真实路径建议。
     */
    public String describeMissingPath(Path workspaceRoot, String logicalPath)
            throws IOException {
        return pathGuard.describeMissingPath(workspaceRoot, logicalPath);
    }

    public void deleteFile(TargetState target) throws IOException {
        if (!target.exists()) {
            throw new ToolRuntimeException(
                    "workspace_path_not_found",
                    "要删除的工作区文件不存在：" + target.logicalPath()
                            + "；请先用 list_files 确认路径再重试"
            );
        }
        requireVersion(target, target.version());
        Files.delete(target.physicalPath());
    }

    public void moveFile(TargetState source, TargetState destination)
            throws IOException {
        if (!source.exists()) {
            throw new ToolRuntimeException(
                    "workspace_path_not_found",
                    "要移动的工作区文件不存在：" + source.logicalPath()
                            + "；请先用 list_files 确认路径再重试"
            );
        }
        if (destination.exists()) {
            throw new ToolRuntimeException(
                    "workspace_move_destination_exists",
                    "移动目标已经存在；Iris 不会隐式覆盖："
                            + destination.logicalPath()
            );
        }
        if (source.logicalPath().equals(destination.logicalPath())) {
            throw new ToolRuntimeException(
                    "workspace_move_same_path",
                    "移动源路径与目标路径相同"
            );
        }
        Path destinationParent = destination.physicalPath().getParent();
        if (destinationParent == null
                || !Files.isDirectory(
                destinationParent,
                LinkOption.NOFOLLOW_LINKS
        )) {
            throw new ToolRuntimeException(
                    "workspace_parent_not_found",
                    "移动目标的父目录不存在；请先创建或选择已有目录"
            );
        }
        requireVersion(source, source.version());
        requireVersion(destination, destination.version());
        try {
            Files.move(
                    source.physicalPath(),
                    destination.physicalPath(),
                    StandardCopyOption.ATOMIC_MOVE
            );
        } catch (AtomicMoveNotSupportedException exception) {
            throw new ToolRuntimeException(
                    "workspace_atomic_move_unavailable",
                    "当前文件系统不支持原子移动，Iris 未执行复制后删除降级"
            );
        }
    }

    public CopyResult copyFile(
            TargetState source,
            TargetState destination,
            long maxBytes,
            BooleanSupplier cancelled
    ) throws IOException {
        requireKind(source, ResourceKind.FILE);
        requireKind(destination, ResourceKind.FILE);
        if (!source.exists()) {
            throw ToolRuntimeException.beforeCommit(
                    "workspace_path_not_found",
                    "要复制的工作区文件不存在：" + source.logicalPath()
                            + "；请先用 list_files 确认路径再重试"
            );
        }
        if (destination.exists()) {
            throw ToolRuntimeException.beforeCommit(
                    "workspace_copy_destination_exists",
                    "复制目标已经存在；Iris 不会隐式覆盖："
                            + destination.logicalPath()
            );
        }
        if (source.logicalPath().equals(destination.logicalPath())) {
            throw ToolRuntimeException.beforeCommit(
                    "workspace_copy_same_path",
                    "复制源路径与目标路径相同"
            );
        }
        Path parent = destination.physicalPath().getParent();
        if (parent == null
                || !Files.isDirectory(parent, LinkOption.NOFOLLOW_LINKS)) {
            throw ToolRuntimeException.beforeCommit(
                    "workspace_parent_not_found",
                    "复制目标的父目录不存在；请先使用 make_directory 创建"
            );
        }
        requireVersion(source, source.version());
        requireVersion(destination, destination.version());

        Path temporary = Files.createTempFile(
                parent,
                ".iris-copy-",
                ".tmp"
        );
        MessageDigest digest = sha256();
        long copied = 0;
        try {
            try (InputStream input = Files.newInputStream(
                    source.physicalPath()
            );
                 OutputStream output = Files.newOutputStream(temporary)) {
                byte[] buffer = new byte[64 * 1024];
                int read;
                while ((read = input.read(buffer)) != -1) {
                    if (read == 0) {
                        continue;
                    }
                    if (cancelled.getAsBoolean()) {
                        throw ToolRuntimeException.beforeCommit(
                                "cancelled_before_commit",
                                "任务已停止，目标文件尚未创建"
                        );
                    }
                    copied += read;
                    if (copied > maxBytes) {
                        throw ToolRuntimeException.beforeCommit(
                                "workspace_copy_too_large",
                                "源文件超过复制上限，目标文件尚未创建"
                        );
                    }
                    output.write(buffer, 0, read);
                    digest.update(buffer, 0, read);
                }
            }
            String copiedHash = HexFormat.of().formatHex(digest.digest());
            if (!copiedHash.equals(source.version())) {
                throw ToolRuntimeException.beforeCommit(
                        "workspace_file_version_changed",
                        "源文件在复制期间发生变化；目标文件尚未创建，请重新发起操作"
                );
            }
            requireVersion(destination, destination.version());
            if (cancelled.getAsBoolean()) {
                throw ToolRuntimeException.beforeCommit(
                        "cancelled_before_commit",
                        "任务已停止，目标文件尚未创建"
                );
            }
            try {
                Files.move(
                        temporary,
                        destination.physicalPath(),
                        StandardCopyOption.ATOMIC_MOVE
                );
            } catch (AtomicMoveNotSupportedException exception) {
                throw ToolRuntimeException.beforeCommit(
                        "workspace_atomic_copy_unavailable",
                        "当前文件系统不支持原子提交复制结果，Iris 未执行降级写入"
                );
            }
            return new CopyResult(copied, copiedHash);
        } finally {
            Files.deleteIfExists(temporary);
        }
    }

    public TargetState inspectDirectory(Path workspaceRoot, String path)
            throws IOException {
        WorkspacePathGuard.ResolvedPath resolved =
                pathGuard.resolveDirectoryForWrite(workspaceRoot, path);
        Path target = resolved.physicalPath();
        if (!Files.exists(target, LinkOption.NOFOLLOW_LINKS)) {
            return new TargetState(
                    resolved.logicalPath(),
                    target,
                    ResourceKind.DIRECTORY,
                    false,
                    "absent",
                    0,
                    null
            );
        }
        if (!Files.isDirectory(target, LinkOption.NOFOLLOW_LINKS)) {
            throw new ToolRuntimeException(
                    "workspace_path_not_directory",
                    "目标路径不是目录：" + resolved.logicalPath()
            );
        }
        return new TargetState(
                resolved.logicalPath(),
                target,
                ResourceKind.DIRECTORY,
                true,
                "directory",
                0,
                Files.getLastModifiedTime(target).toInstant()
        );
    }

    public void createDirectory(TargetState target) throws IOException {
        requireKind(target, ResourceKind.DIRECTORY);
        requireVersion(target, target.version());
        if (target.exists()) {
            throw new ToolRuntimeException(
                    "workspace_directory_exists",
                    "工作区目录已经存在：" + target.logicalPath()
            );
        }
        Path parent = target.physicalPath().getParent();
        if (parent == null
                || !Files.isDirectory(parent, LinkOption.NOFOLLOW_LINKS)) {
            throw new ToolRuntimeException(
                    "workspace_parent_not_found",
                    "目标父目录不存在；make_directory 每次只创建一级目录"
            );
        }
        Files.createDirectory(target.physicalPath());
    }

    public void deleteDirectory(TargetState target) throws IOException {
        requireKind(target, ResourceKind.DIRECTORY);
        requireVersion(target, target.version());
        if (!target.exists()) {
            return;
        }
        try {
            Files.delete(target.physicalPath());
        } catch (java.nio.file.DirectoryNotEmptyException exception) {
            throw new ToolRuntimeException(
                    "workspace_directory_not_empty",
                    "目录包含后来新增的内容，Iris 不会在恢复时递归删除："
                            + target.logicalPath()
            );
        }
    }

    public void requireEmptyDirectory(TargetState target) throws IOException {
        requireKind(target, ResourceKind.DIRECTORY);
        if (!target.exists()) {
            throw new ToolRuntimeException(
                    "workspace_path_not_found",
                    "工作区目录不存在：" + target.logicalPath()
                            + "；请先用 list_files 确认路径再重试"
            );
        }
        try (java.util.stream.Stream<Path> children =
                     Files.list(target.physicalPath())) {
            if (children.findAny().isPresent()) {
                throw new ToolRuntimeException(
                        "workspace_directory_not_empty",
                        "目录不是空目录；Iris 不会递归删除："
                                + target.logicalPath()
                );
            }
        }
    }

    private void writeAtomically(
            TargetState target,
            byte[] content
    ) throws IOException {
        Path parent = target.physicalPath().getParent();
        if (parent == null) {
            throw new ToolRuntimeException(
                    "invalid_workspace_path",
                    "写入目标没有安全父目录"
            );
        }
        if (!Files.isDirectory(parent, LinkOption.NOFOLLOW_LINKS)) {
            throw new ToolRuntimeException(
                    "workspace_parent_not_found",
                    "写入目标的父目录不存在；请先使用 make_directory 创建"
            );
        }
        Path temporary = Files.createTempFile(parent, ".iris-write-", ".tmp");
        try {
            Files.write(temporary, content);
            try {
                requireVersion(target, target.version());
                Files.move(
                        temporary,
                        target.physicalPath(),
                        StandardCopyOption.ATOMIC_MOVE,
                        StandardCopyOption.REPLACE_EXISTING
                );
            } catch (AtomicMoveNotSupportedException exception) {
                throw new ToolRuntimeException(
                        "workspace_atomic_replace_unavailable",
                        "当前文件系统不支持同目录原子替换，Iris 未执行降级覆盖"
                );
            }
        } finally {
            Files.deleteIfExists(temporary);
        }
    }

    private byte[] encode(
            String content,
            Charset charset,
            int bomBytes
    ) throws IOException {
        ByteArrayOutputStream output = new ByteArrayOutputStream();
        if (bomBytes == 0) {
            return content.getBytes(charset);
        } else if (StandardCharsets.UTF_8.equals(charset)) {
            output.writeBytes(new byte[]{
                    (byte) 0xEF, (byte) 0xBB, (byte) 0xBF
            });
        } else if (StandardCharsets.UTF_16LE.equals(charset)) {
            output.writeBytes(new byte[]{(byte) 0xFF, (byte) 0xFE});
        } else if (StandardCharsets.UTF_16BE.equals(charset)) {
            output.writeBytes(new byte[]{(byte) 0xFE, (byte) 0xFF});
        }
        output.writeBytes(content.getBytes(charset));
        return output.toByteArray();
    }

    private MessageDigest sha256() {
        try {
            return MessageDigest.getInstance("SHA-256");
        } catch (NoSuchAlgorithmException exception) {
            throw new IllegalStateException("SHA-256 unavailable", exception);
        }
    }

    private String currentVersion(TargetState target) throws IOException {
        if (target.kind() == ResourceKind.DIRECTORY) {
            if (!Files.exists(
                    target.physicalPath(),
                    LinkOption.NOFOLLOW_LINKS
            )) {
                return "absent";
            }
            if (!Files.isDirectory(
                    target.physicalPath(),
                    LinkOption.NOFOLLOW_LINKS
            )) {
                return "type_changed";
            }
            return "directory";
        }
        return versionOf(target.physicalPath());
    }

    private void requireKind(TargetState target, ResourceKind expected) {
        if (target.kind() != expected) {
            throw new IllegalArgumentException(
                    "Expected " + expected + " target"
            );
        }
    }

    public enum ResourceKind {
        FILE,
        DIRECTORY
    }

    public record TargetState(
            String logicalPath,
            Path physicalPath,
            ResourceKind kind,
            boolean exists,
            String version,
            long sizeBytes,
            Instant modifiedAt
    ) {
    }

    public record CopyResult(long copiedBytes, String contentHash) {
    }
}
