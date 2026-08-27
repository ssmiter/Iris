package com.iris.storage;

import org.springframework.boot.SpringApplication;
import org.springframework.boot.env.EnvironmentPostProcessor;
import org.springframework.core.env.ConfigurableEnvironment;

import java.io.IOException;
import java.nio.file.Files;
import java.nio.file.Path;

/**
 * SQLite 数据库父目录自举（docs/41 §2.1）。
 *
 * <p>在 context refresh 之前解析 {@code spring.datasource.url}（占位符已求值），
 * 为 {@code jdbc:sqlite:} 目标创建父目录。缺这一步时新机器/自定义
 * {@code IRIS_DB_PATH} 会在 Hikari 初始化深处炸出「path does not exist」，
 * 根因埋在几百行堆栈底部——这里把它提前成一行人话。
 *
 * <p>同步、fail-close：目录建不出来直接终止启动，错误即根因。
 */
public final class SqliteDirectoryBootstrap implements EnvironmentPostProcessor {
    private static final String PREFIX = "jdbc:sqlite:";

    @Override
    public void postProcessEnvironment(
            ConfigurableEnvironment environment,
            SpringApplication application
    ) {
        String url = environment.getProperty("spring.datasource.url");
        if (url == null || !url.startsWith(PREFIX)) {
            return;
        }
        String raw = url.substring(PREFIX.length());
        // 内存库与 URI 参数形态不需要目录自举
        if (raw.isBlank() || raw.startsWith(":memory:") || raw.startsWith("file::memory:")) {
            return;
        }
        Path parent = Path.of(raw).toAbsolutePath().getParent();
        if (parent == null || Files.isDirectory(parent)) {
            return;
        }
        try {
            Files.createDirectories(parent);
        } catch (IOException error) {
            throw new IllegalStateException(
                    "Iris 数据库目录创建失败：" + parent
                            + "。请检查 IRIS_DB_PATH 指向或目录权限。",
                    error
            );
        }
    }
}
