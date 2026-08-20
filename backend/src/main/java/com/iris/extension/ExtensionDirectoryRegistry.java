package com.iris.extension;

import com.iris.tools.catalog.CatalogGenerationService;
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
    private final CatalogGenerationService generationService;

    public ExtensionDirectoryRegistry(
            CatalogGenerationService generationService
    ) {
        this.generationService = generationService;
    }

    public void replaceRoot(
            Path root,
            List<ExtensionScanner.ScannedDirectory> directories
    ) {
        byRoot.put(root, List.copyOf(directories));
        generationService.bump();
    }

    public void removeRoot(Path root) {
        byRoot.remove(root);
        generationService.bump();
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
