package com.iris.workspace;

import com.iris.storage.ManagedObjectStore;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.stereotype.Service;

import java.io.IOException;
import java.nio.file.Files;
import java.nio.file.Path;

/**
 * 工作区路径围栏（docs/04 §1）——第一安全原则。
 * 所有文件工具的入口都必须经 resolve() 解析路径，禁止自行拼接。
 */
@Service
public class WorkspaceService {

    private final Path root;
    private final WorkspacePathGuard pathGuard;

    public WorkspaceService(
            @Value("${iris.workspace:~/Iris/workspace}") String workspaceDir,
            WorkspacePathGuard pathGuard,
            ManagedObjectStore objectStore
    ) throws IOException {
        this.pathGuard = pathGuard;
        String expanded = workspaceDir.startsWith("~/")
                || workspaceDir.startsWith("~\\")
                ? System.getProperty("user.home") + workspaceDir.substring(1)
                : workspaceDir;
        Path configured = Path.of(expanded).toAbsolutePath().normalize();
        Files.createDirectories(configured);
        this.root = configured.toRealPath();
        objectStore.requireSeparatedFrom(root);
    }

    public Path root() {
        return root;
    }

    /**
     * 把工作区内相对路径解析为安全绝对路径。
     * 越界（绝对路径/../逃逸/symlink 逃逸）一律抛出——fail-close。
     */
    public Path resolve(String relativePath) throws IOException {
        return pathGuard.resolveForWrite(root, relativePath).physicalPath();
    }
}
