package com.iris.extension;

import org.springframework.stereotype.Component;

import java.nio.file.Path;
import java.util.Comparator;
import java.util.List;
import java.util.Map;
import java.util.concurrent.ConcurrentHashMap;

/**
 * 拓展目录元数据的运行时视图（docs/31 §2.2）。扫描器按根整体替换，
 * CapabilityDirectoryCatalog 读取时与代码内定义合并（代码优先）。
 */
@Component
public class ExtensionDirectoryRegistry {

    private final Map<Path, List<ExtensionScanner.ScannedDirectory>> byRoot =
            new ConcurrentHashMap<>();

    public void replaceRoot(
            Path root,
            List<ExtensionScanner.ScannedDirectory> directories
    ) {
        byRoot.put(root, List.copyOf(directories));
    }

    public void removeRoot(Path root) {
        byRoot.remove(root);
    }

    public List<ExtensionScanner.ScannedDirectory> all() {
        return byRoot.values().stream()
                .flatMap(List::stream)
                .sorted(Comparator.comparing(
                        ExtensionScanner.ScannedDirectory::directoryPath
                ))
                .toList();
    }
}
