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
                    "/life",
                    "生活",
                    "日常生活相关能力区域"
            ),
            directory(
                    "/life/notes",
                    "笔记",
                    "向工作区文本笔记追加记录；记录待办、想法或持续日志时使用"
            ),
            directory(
                    "/personal",
                    "个人",
                    "当前用户专属的个人数据与长期状态区域"
            ),
            directory(
                    "/personal/memory",
                    "个人记忆",
                    "记住、回读、搜索与遗忘跨会话用户记忆；涉及用户偏好与长期事实时使用"
            ),
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
                    "/system/artifacts",
                    "成果工件",
                    "生成、发布、呈现与回读面向用户的工件；交付可视成果时使用"
            ),
            directory(
                    "/system/capabilities",
                    "能力发现与调用",
                    "能力目录的列出、定义读取与统一调用入口；找能力或调用能力都从这里开始"
            ),
            directory(
                    "/system/context",
                    "上下文",
                    "按标识回读或查询此前工具调用的完整结果；需要取回被压缩掉的细节时使用"
            ),
            directory(
                    "/system/files",
                    "工作区文件",
                    "读写、移动、搜索工作区内的文件与目录；处理本地内容时从这里进入"
            ),
            directory(
                    "/system/interaction",
                    "用户交互",
                    "向用户提问并等待回答；缺少关键信息且无法自行决断时使用"
            ),
            directory(
                    "/system/pipelines",
                    "固定流程",
                    "由按钮、系统事件或主对话触发的版本化信息转换流程"
            ),
            directory(
                    "/system/schedule",
                    "定时任务",
                    "创建、启停、删除与立即触发定时任务；需要周期性或延迟执行时使用"
            ),
            directory(
                    "/system/tasks",
                    "任务台账",
                    "创建、更新与回读跨轮任务台账；多步工作需要在上下文之外留痕时使用"
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
