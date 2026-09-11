package com.iris.workspace;

import com.iris.tools.core.ToolRuntimeException;
import org.springframework.stereotype.Service;

import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.LinkOption;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Set;

/**
 * 用户在浏览面板明确登记的外部目录。
 *
 * <p>它和模型工具的工作区围栏是两条边界：模型工具仍只能使用默认工作区；
 * 登记根只给 browse=true 的用户面板提供 Windows 文件管理器式的浏览/打开能力。
 * 持久层使用工作区内一行一个路径的轻量文件，避免为这个本地 UX 引入数据库表。</p>
 */
@Service
public final class WorkspaceRootRegistry {
    private final Path workspaceRoot;
    private final Path persistenceFile;
    private final Set<Path> persistentRoots = new LinkedHashSet<>();
    private final Set<Path> sessionRoots = new LinkedHashSet<>();

    public WorkspaceRootRegistry(WorkspaceService workspace) throws IOException {
        this.workspaceRoot = workspace.root();
        this.persistenceFile = workspaceRoot.resolve(".iris/registered-roots.txt");
        load();
        persistentRoots.add(workspaceRoot);
    }

    public synchronized Roots snapshot() {
        return new Roots(displayPaths(persistentRoots), displayPaths(sessionRoots));
    }

    public synchronized Path register(String rawPath, String scope) throws IOException {
        Path root = canonicalDirectory(rawPath);
        if (root.getParent() == null || root.equals(root.getRoot())) {
            throw new ToolRuntimeException(
                    "workspace_root_too_broad",
                    "不能登记盘符根目录；请选择盘符下的具体工作目录"
            );
        }
        if ("session".equalsIgnoreCase(scope)) {
            sessionRoots.add(root);
        } else {
            persistentRoots.add(root);
            persist();
        }
        return root;
    }

    public synchronized void unregister(String rawPath) throws IOException {
        Path root = canonicalDirectory(rawPath);
        if (root.equals(workspaceRoot)) return;
        persistentRoots.remove(root);
        sessionRoots.remove(root);
        persist();
    }

    public synchronized boolean allows(Path candidate) throws IOException {
        Path absolute = candidate.toAbsolutePath().normalize();
        if (!Files.exists(absolute, LinkOption.NOFOLLOW_LINKS)) {
            Path parent = absolute.getParent();
            if (parent == null) return false;
            absolute = parent.toRealPath();
        } else {
            absolute = absolute.toRealPath();
        }
        return allRoots().stream().anyMatch(absolute::startsWith);
    }

    /** 选择覆盖目标的最长登记根，避免嵌套目录被较浅根截断。 */
    public synchronized Path bestRoot(Path candidate) throws IOException {
        Path absolute = candidate.toAbsolutePath().normalize();
        return allRoots().stream()
                .filter(root -> absolute.startsWith(root))
                .sorted((a, b) -> Integer.compare(b.getNameCount(), a.getNameCount()))
                .findFirst()
                .orElse(null);
    }

    private List<Path> allRoots() {
        List<Path> roots = new ArrayList<>(persistentRoots);
        roots.addAll(sessionRoots);
        return roots;
    }

    private Path canonicalDirectory(String rawPath) throws IOException {
        if (rawPath == null || rawPath.isBlank()) {
            throw new ToolRuntimeException("workspace_root_invalid", "目录路径不能为空");
        }
        String normalized = rawPath.trim().replace('/', java.io.File.separatorChar);
        if (normalized.equalsIgnoreCase("/workspace")
                || normalized.equalsIgnoreCase("workspace")) {
            return workspaceRoot;
        }
        Path candidate;
        try {
            candidate = Path.of(normalized).toAbsolutePath().normalize();
        } catch (RuntimeException exception) {
            throw new ToolRuntimeException("workspace_root_invalid", "目录路径格式无效");
        }
        if (!Files.isDirectory(candidate, LinkOption.NOFOLLOW_LINKS)) {
            throw new ToolRuntimeException(
                    "workspace_root_not_found", "目录不存在或不是目录：" + rawPath);
        }
        Path real = candidate.toRealPath();
        if (!Files.isDirectory(real, LinkOption.NOFOLLOW_LINKS)) {
            throw new ToolRuntimeException("workspace_root_not_found", "目录不是目录：" + rawPath);
        }
        return real;
    }

    private void load() throws IOException {
        if (!Files.exists(persistenceFile)) return;
        for (String line : Files.readAllLines(persistenceFile, StandardCharsets.UTF_8)) {
            if (line.isBlank()) continue;
            try {
                Path root = Path.of(line.trim()).toRealPath();
                if (Files.isDirectory(root, LinkOption.NOFOLLOW_LINKS)) persistentRoots.add(root);
            } catch (Exception ignored) {
                // 机器上的目录可能已被移动/删除，下一次登记时自然恢复。
            }
        }
    }

    private void persist() throws IOException {
        Files.createDirectories(persistenceFile.getParent());
        String content = persistentRoots.stream()
                .filter(root -> !root.equals(workspaceRoot))
                .map(Path::toString)
                .sorted()
                .reduce((left, right) -> left + System.lineSeparator() + right)
                .map(value -> value + System.lineSeparator())
                .orElse("");
        Files.writeString(persistenceFile, content, StandardCharsets.UTF_8);
    }

    private List<String> displayPaths(Set<Path> roots) {
        return roots.stream().map(this::displayPath).toList();
    }

    public String displayPath(Path path) {
        return path.toString().replace('\\', '/');
    }

    public record Roots(List<String> roots, List<String> sessionRoots) { }
}
