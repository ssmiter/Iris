package com.iris.objective.system;

import org.springframework.stereotype.Service;

import java.io.IOException;
import java.io.UncheckedIOException;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.Paths;

/**
 * 用户主目录（~/.wonwork/）路径解析（对照 WonWork UserHomeService.cs）。
 *
 * <p>用户级持久数据的统一根目录（providers.json / memory/ / skills/），
 * 与安装目录分离。目录名沿用 .wonwork 以便与 WonWork 客户端共存时
 * 共享同一份用户配置。</p>
 */
@Service
public class UserHomeService {

    private final Path root;

    public UserHomeService() {
        this.root = Paths.get(System.getProperty("user.home"), ".wonwork");
        ensure(root);
    }

    /** ~/.wonwork/ 根目录（确保存在）。 */
    public Path root() {
        return root;
    }

    /** ~/.wonwork/memory/（确保存在）。 */
    public Path memoryDir() {
        return ensure(root.resolve("memory"));
    }

    /** ~/.wonwork/skills/（确保存在）。 */
    public Path skillsDir() {
        return ensure(root.resolve("skills"));
    }

    /** ~/.wonwork/providers.json（文件路径，不确保存在——不存在=尚未配置）。 */
    public Path providersFile() {
        return root.resolve("providers.json");
    }

    private Path ensure(Path dir) {
        try {
            Files.createDirectories(dir);
        } catch (IOException e) {
            throw new UncheckedIOException("创建用户主目录失败: " + dir, e);
        }
        return dir;
    }
}
