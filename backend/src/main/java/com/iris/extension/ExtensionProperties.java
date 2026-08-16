package com.iris.extension;

import org.springframework.boot.context.properties.ConfigurationProperties;

import java.nio.file.Path;
import java.util.ArrayList;
import java.util.List;

/**
 * 拓展根配置（docs/31 §2）。默认根在 ExtensionProviderService 中按
 * 工作区与用户主目录派生；此处只承载显式覆盖。
 */
@ConfigurationProperties(prefix = "iris.extension")
public class ExtensionProperties {

    /** 总开关；false 时扫描器与监听器都不启动。 */
    private boolean enabled = true;

    /** 显式拓展根列表；为空时使用默认根（工作区级 + 机器级）。 */
    private List<Path> roots = new ArrayList<>();

    /**
     * 内建拓展根（docs/31 §5.2 rank 50）：随发行物出厂的插件目录，
     * 相对路径按后端工作目录解析（开发期 mvnw/spring-boot:run 的
     * basedir 是 backend/，故默认 ../extensions 即仓库根 extensions/）。
     * 设为不存在路径即等效关闭。
     */
    private Path bundledRoot = Path.of("..", "extensions");

    /** 文件事件到重新扫描的防抖间隔。 */
    private long scanDebounceMs = 500;

    public boolean isEnabled() {
        return enabled;
    }

    public void setEnabled(boolean enabled) {
        this.enabled = enabled;
    }

    public List<Path> getRoots() {
        return roots;
    }

    public void setRoots(List<Path> roots) {
        this.roots = roots == null ? new ArrayList<>() : roots;
    }

    public Path getBundledRoot() {
        return bundledRoot;
    }

    public void setBundledRoot(Path bundledRoot) {
        this.bundledRoot = bundledRoot;
    }

    public long getScanDebounceMs() {
        return scanDebounceMs;
    }

    public void setScanDebounceMs(long scanDebounceMs) {
        this.scanDebounceMs = scanDebounceMs;
    }
}
