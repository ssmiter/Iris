package com.iris.workspace;

import org.springframework.beans.factory.annotation.Value;
import org.springframework.stereotype.Service;

import java.io.IOException;
import java.nio.file.Path;

/**
 * 工作区路径围栏（docs/04 §1）——第一安全原则。
 * 所有文件工具的入口都必须经 resolve() 解析路径，禁止自行拼接。
 */
@Service
public class WorkspaceService {

    private final Path root;

    public WorkspaceService(@Value("${iris.workspace:~/Iris/workspace}") String workspaceDir) throws IOException {
        this.root = Path.of(workspaceDir.replace("~", System.getProperty("user.home")))
                .toAbsolutePath().normalize().toRealPath();
    }

    public Path root() {
        return root;
    }

    /**
     * 把工作区内相对路径解析为安全绝对路径。
     * 越界（绝对路径/../逃逸/symlink 逃逸）一律抛出——fail-close。
     */
    public Path resolve(String relativePath) throws IOException {
        if (relativePath == null || relativePath.isBlank()) {
            throw new SecurityException("路径为空");
        }
        Path candidate = root.resolve(relativePath).normalize();
        // 未存在的文件 toRealPath 会失败：先校验文本形态，存在后再做 realPath 复核
        if (!candidate.startsWith(root)) {
            throw new SecurityException(
                    "路径越界：只能操作工作区内文件（收到 " + relativePath + "，请用工作区相对路径）");
        }
        if (java.nio.file.Files.exists(candidate)) {
            Path real = candidate.toRealPath();
            if (!real.startsWith(root)) {
                throw new SecurityException("路径越界：符号链接指向工作区外");
            }
            return real;
        }
        return candidate;
    }
}
