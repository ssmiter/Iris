package com.iris.tools.catalog;

import com.iris.extension.ExtensionDirectoryRegistry;
import com.iris.extension.ExtensionScanner;
import org.springframework.stereotype.Component;

import java.util.ArrayList;
import java.util.Comparator;
import java.util.List;
import java.util.Optional;

/**
 * 可以先于具体工具存在的语义目录地图。
 *
 * <p>它只描述“有哪些业务区域值得导航”，不声明工具、不改变 Provider tool surface，
 * 也不拥有执行绑定。内核 Tool 路径从其 Java package 派生，拓展 Tool 路径从其
 * 目录派生（docs/31 映射禁令），两者在这里只投影元数据。</p>
 */
@Component
public class CapabilityDirectoryCatalog {
    private final ExtensionDirectoryRegistry extensionDirectories;
    private final List<DirectoryDefinition> definitions = List.of(
            // 内核域元数据随内核留代码；业务域元数据在内建拓展根的
            // _directory.yml 里（docs/31 §11 M2），经 ExtensionDirectoryRegistry
            // 叠加进下面的 all() 合并视图。
            directory(
                    "/system",
                    "系统闭环",
                    "Iris 自身的能力发现、运行协作与固定流程入口"
            ),
            directory(
                    "/system/agents",
                    "Agent 协作",
                    "使用同一 Agentic 内核执行有界委派、异步通信与取消"
            ),
            directory(
                    "/system/pipelines",
                    "固定流程",
                    "由按钮、系统事件或主对话触发的版本化信息转换流程"
            )
    ).stream().sorted(
            Comparator.comparing(DirectoryDefinition::path)
    ).toList();

    public CapabilityDirectoryCatalog(
            ExtensionDirectoryRegistry extensionDirectories
    ) {
        this.extensionDirectories = extensionDirectories;
    }

    /**
     * 代码内定义 + 拓展根 `_directory.yml` 的合并视图（docs/31 §2.2）：
     * 代码优先——拓展只能新增代码没有的目录、补充元数据，hidden 即消失。
     */
    public List<DirectoryDefinition> all() {
        List<DirectoryDefinition> merged = new ArrayList<>(definitions);
        List<String> knownPaths = definitions.stream()
                .map(DirectoryDefinition::path)
                .toList();
        for (ExtensionScanner.ScannedDirectory directory
                : extensionDirectories.all()) {
            if (directory.metadata().hidden()
                    || knownPaths.contains(directory.directoryPath())) {
                continue;
            }
            String label = directory.metadata().label();
            merged.add(new DirectoryDefinition(
                    directory.directoryPath(),
                    label == null || label.isBlank()
                            ? directory.directoryPath()
                            : label,
                    directory.metadata().summary() == null
                            ? ""
                            : directory.metadata().summary(),
                    directory.metadata().stats() == null
                            ? List.of()
                            : directory.metadata().stats().exposeOrEmpty()
            ));
        }
        return merged;
    }

    public Optional<DirectoryDefinition> find(String path) {
        return all().stream()
                .filter(definition -> definition.path().equals(path))
                .findFirst();
    }

    private static DirectoryDefinition directory(
            String path,
            String title,
            String description
    ) {
        return new DirectoryDefinition(path, title, description, List.of());
    }

    public record DirectoryDefinition(
            String path,
            String title,
            String description,
            /** `_directory.yml` 声明要暴露的统计口径（docs/31 §2.2）；空=不统计。 */
            List<String> statsExpose
    ) {
    }
}
