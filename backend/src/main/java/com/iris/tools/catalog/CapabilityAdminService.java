package com.iris.tools.catalog;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.iris.agent.pipeline.PipelineDefinitionRegistry;
import com.iris.agent.pipeline.PipelineRunRepository;
import com.iris.extension.ExtensionProviderService;
import com.iris.extension.KnowledgeDocumentTool;
import com.iris.extension.ResidentProcessTool;
import com.iris.extension.ShadowedCapability;
import com.iris.extension.SkillTool;
import com.iris.extension.TemplateProcessTool;
import com.iris.tools.core.ToolRegistry;
import org.springframework.stereotype.Service;

import java.util.ArrayList;
import java.util.Comparator;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Optional;

/**
 * 统一能力管理页的只读投影（docs/32 §4）：同一棵能力树 + 来源/遮蔽
 * 切面，给前端管理页消费；与模型发现契约（CapabilityService）分离，
 * 不改变模型侧任何 payload。
 */
@Service
public class CapabilityAdminService {

    /** 管理页视角 = 用户本人视角（personal 身份看到的就是用户拥有的树）。 */
    private static final String ADMIN_SYSTEM_CODE = "personal";
    /** Pipeline 详情"最近运行"区块的条数上限（docs/33 §5）。 */
    private static final int RECENT_RUNS_LIMIT = 10;

    private final CapabilityService capabilities;
    private final CapabilityDirectoryCatalog directoryCatalog;
    private final ToolRegistry registry;
    private final PipelineDefinitionRegistry pipelines;
    private final PipelineRunRepository pipelineRuns;
    private final List<CapabilityCatalogSource> extensionSources;
    private final ExtensionProviderService extensions;
    private final DirectoryStatsService directoryStats;
    private final ObjectMapper objectMapper;

    public CapabilityAdminService(
            CapabilityService capabilities,
            CapabilityDirectoryCatalog directoryCatalog,
            ToolRegistry registry,
            PipelineDefinitionRegistry pipelines,
            PipelineRunRepository pipelineRuns,
            List<CapabilityCatalogSource> extensionSources,
            ExtensionProviderService extensions,
            DirectoryStatsService directoryStats,
            ObjectMapper objectMapper
    ) {
        this.capabilities = capabilities;
        this.directoryCatalog = directoryCatalog;
        this.registry = registry;
        this.pipelines = pipelines;
        this.pipelineRuns = pipelineRuns;
        this.extensionSources = List.copyOf(extensionSources);
        this.extensions = extensions;
        this.directoryStats = directoryStats;
        this.objectMapper = objectMapper;
    }

    public record AdminTreeNode(
            String path,
            String name,
            String title,
            int count,
            /** `_directory.yml` 声明口径的实时值；未声明则为空表。 */
            Map<String, Object> stats,
            List<AdminTreeNode> children
    ) {
    }

    /** 目录树：计数覆盖注册表 + Pipeline + 目录投影源，标题来自目录元数据。 */
    public AdminTreeNode tree() {
        Map<String, Integer> counts = new LinkedHashMap<>();
        int total = 0;
        for (ToolRegistry.ToolBinding binding : registry.all()) {
            accumulate(counts, binding.capabilityPath());
            total++;
        }
        for (PipelineDefinitionRegistry.Binding binding : pipelines.all()) {
            accumulate(counts, binding.definition().capabilityPath());
            total++;
        }
        for (CapabilityCatalogSource.Definition definition
                : extensionDefinitions()) {
            accumulate(counts, definition.path());
            total++;
        }
        for (CapabilityDirectoryCatalog.DirectoryDefinition directory
                : directoryCatalog.all()) {
            accumulate(counts, directory.path());
        }
        return buildNode("", counts, total);
    }

    private void accumulate(Map<String, Integer> counts, String path) {
        if (path == null || !path.startsWith("/")) {
            return;
        }
        String[] segments = path.substring(1).split("/");
        StringBuilder current = new StringBuilder();
        for (String segment : segments) {
            current.append('/').append(segment);
            counts.merge(current.toString(), 1, Integer::sum);
        }
    }

    private AdminTreeNode buildNode(
            String path,
            Map<String, Integer> counts,
            int totalItems
    ) {
        String prefix = path.isEmpty() ? "/" : path + "/";
        List<AdminTreeNode> children = new ArrayList<>();
        for (String candidate : counts.keySet()) {
            if (!candidate.startsWith(prefix)) {
                continue;
            }
            String remainder = candidate.substring(prefix.length());
            if (remainder.contains("/")) {
                continue;
            }
            children.add(buildNode(candidate, counts, totalItems));
        }
        children.sort(Comparator.comparing(AdminTreeNode::path));
        String nodePath = path.isEmpty() ? "/" : path;
        Optional<CapabilityDirectoryCatalog.DirectoryDefinition> directory =
                directoryCatalog.find(nodePath);
        String title = directory
                .map(CapabilityDirectoryCatalog.DirectoryDefinition::title)
                .orElse("");
        int count = path.isEmpty()
                ? totalItems
                : counts.getOrDefault(path, 0);
        List<String> expose = directory
                .map(CapabilityDirectoryCatalog.DirectoryDefinition::statsExpose)
                .orElse(List.of());
        Map<String, Object> stats = expose.isEmpty()
                ? Map.of()
                : directoryStats.stats(nodePath, count, expose);
        String name = path.isEmpty()
                ? "/"
                : path.substring(path.lastIndexOf('/') + 1);
        return new AdminTreeNode(nodePath, name, title, count, stats, children);
    }

    public record AdminItem(
            String id,
            String version,
            String kind,
            String name,
            String path,
            String description,
            String riskLevel,
            String availability,
            String availabilityReason,
            /** kernel | extension | mcp | skill_store | pipeline */
            String origin,
            /** 拓展根 / MCP serverId；内核件为 null。 */
            String sourceRoot,
            /** 来源文件绝对路径；非文件真相件为 null。 */
            String sourceFile,
            /** 非 null 表示被遮蔽（胜出者来源）。 */
            String shadowedBy
    ) {
    }

    public record AdminListing(
            String path,
            List<CapabilityService.DirectoryCard> directories,
            List<AdminItem> items
    ) {
    }

    /** 某目录下的对象清单：kind/q 是查询切面，不是分页（docs/32 §4）。 */
    public AdminListing items(String parentPath, String kind, String query) {
        CapabilityService.CapabilityListing base =
                capabilities.list(parentPath, ADMIN_SYSTEM_CODE);
        List<AdminItem> items = new ArrayList<>();
        for (CapabilityService.CapabilityCard card : base.items()) {
            items.add(enrich(card));
        }
        String parent = capabilities.normalizePath(parentPath);
        for (ShadowedCapability shadow : extensions.shadowed()) {
            String shadowParent = shadow.capabilityPath().substring(
                    0, shadow.capabilityPath().lastIndexOf('/'));
            if (shadowParent.isEmpty()) {
                shadowParent = "/";
            }
            if (!shadowParent.equals(parent)) {
                continue;
            }
            items.add(new AdminItem(
                    null, null, shadow.kind(), shadow.name(),
                    shadow.capabilityPath(), shadow.description(),
                    null, "shadowed", "被 " + shadow.shadowedBy() + " 遮蔽",
                    "extension", shadow.root(), shadow.file(),
                    shadow.shadowedBy()
            ));
        }
        String needle = query == null ? "" : query.trim().toLowerCase();
        List<AdminItem> filtered = items.stream()
                .filter(item -> kind == null || kind.isBlank()
                        || kind.equals(item.kind()))
                .filter(item -> needle.isEmpty()
                        || item.name().toLowerCase().contains(needle)
                        || (item.description() != null && item.description()
                                .toLowerCase().contains(needle)))
                .sorted(Comparator.comparing(AdminItem::path))
                .toList();
        return new AdminListing(parent, base.directories(), filtered);
    }

    /** 单件详情：清单字段 + 完整定义快照。 */
    public Optional<AdminDetail> detail(String path) {
        String normalized = capabilities.normalizePath(path);
        String name = normalized.substring(normalized.lastIndexOf('/') + 1);
        Optional<ToolRegistry.ToolBinding> binding = registry.find(name)
                .filter(found -> found.capabilityPath().equals(normalized));
        if (binding.isPresent()) {
            String parent = normalized.substring(0, normalized.lastIndexOf('/'));
            if (parent.isEmpty()) {
                parent = "/";
            }
            CapabilityService.CapabilityCard card = capabilities
                    .list(parent, ADMIN_SYSTEM_CODE)
                    .items().stream()
                    .filter(item -> item.path().equals(normalized))
                    .findFirst()
                    .orElse(null);
            AdminItem item = card != null
                    ? enrich(card)
                    : enrich(new CapabilityService.CapabilityCard(
                            binding.get().manifest().id(),
                            binding.get().manifest().version(),
                            kindOf(binding.get()),
                            name,
                            normalized,
                            binding.get().manifest().description(),
                            binding.get().manifest().riskLevel().name()
                                    .toLowerCase(java.util.Locale.ROOT),
                            null,
                            null
                    ));
            return Optional.of(new AdminDetail(
                    item,
                    objectMapper.valueToTree(binding.get().manifest()),
                    null
            ));
        }
        for (CapabilityCatalogSource source : extensionSources) {
            Optional<CapabilityCatalogSource.Definition> definition =
                    source.findByPath(normalized);
            if (definition.isPresent()) {
                CapabilityCatalogSource.Definition found = definition.get();
                return Optional.of(new AdminDetail(
                        new AdminItem(
                                found.id(), found.version(), found.kind(),
                                found.name(), found.path(),
                                found.description(), found.riskLevel(),
                                found.availability(),
                                found.availabilityReason(),
                                originOf(found.kind()), null, null, null
                        ),
                        found.manifest(),
                        null
                ));
            }
        }
        // Pipeline 不在注册表也不在投影源：按路径命中 Definition 注册表，
        // 附最近运行（docs/33 §5，管理页视角，不进模型上下文）。
        Optional<PipelineDefinitionRegistry.Binding> pipeline =
                pipelines.findByPath(normalized);
        if (pipeline.isPresent()) {
            var definition = pipeline.get().definition();
            List<PipelineRunSummary> recent = pipelineRuns
                    .recentRunsByDefinition(definition.id(), RECENT_RUNS_LIMIT)
                    .stream()
                    .map(run -> new PipelineRunSummary(
                            run.runId(),
                            run.triggerKind(),
                            run.phase().name().toLowerCase(
                                    java.util.Locale.ROOT),
                            run.startedAt(),
                            run.endedAt(),
                            run.conversationId()
                    ))
                    .toList();
            return Optional.of(new AdminDetail(
                    new AdminItem(
                            definition.id(), definition.version(), "pipeline",
                            definition.name(), normalized,
                            definition.description(), "standard",
                            "available", "本地 Pipeline Definition 已注册",
                            "kernel", null, null, null
                    ),
                    objectMapper.valueToTree(definition),
                    recent
            ));
        }
        return extensions.shadowed().stream()
                .filter(shadow -> shadow.capabilityPath().equals(normalized))
                .findFirst()
                .map(shadow -> new AdminDetail(
                        new AdminItem(
                                null, null, shadow.kind(), shadow.name(),
                                shadow.capabilityPath(), shadow.description(),
                                null, "shadowed",
                                "被 " + shadow.shadowedBy() + " 遮蔽",
                                "extension", shadow.root(), shadow.file(),
                                shadow.shadowedBy()
                        ),
                        null,
                        null
                ));
    }

    public record AdminDetail(
            AdminItem item,
            /** 完整定义快照（manifest JSON）；被遮蔽件为 null。 */
            JsonNode definition,
            /** kind=pipeline 时的最近运行（新→旧）；其他 kind 为 null。 */
            List<PipelineRunSummary> recentRuns
    ) {
    }

    public record PipelineRunSummary(
            String runId,
            String triggerKind,
            String phase,
            java.time.Instant startedAt,
            java.time.Instant endedAt,
            String conversationId
    ) {
    }

    private AdminItem enrich(CapabilityService.CapabilityCard card) {
        Optional<ToolRegistry.ToolBinding> binding = registry.find(card.name());
        if (binding.isPresent()) {
            ToolRegistry.ToolBinding found = binding.get();
            String provider = registry.providerOf(card.name());
            String origin = "kernel";
            String sourceRoot = null;
            String sourceFile = null;
            if (provider != null && provider.startsWith("extension:")) {
                origin = "extension";
                sourceRoot = provider.substring("extension:".length());
                sourceFile = extensions.fileOf(found.capabilityPath());
            } else if (provider != null && provider.startsWith("mcp:")) {
                origin = "mcp";
                sourceRoot = provider.substring("mcp:".length());
            }
            return new AdminItem(
                    card.id(), card.version(), kindOf(found), card.name(),
                    card.path(), card.description(), card.riskLevel(),
                    card.availability(), card.availabilityReason(),
                    origin, sourceRoot, sourceFile, null
            );
        }
        return new AdminItem(
                card.id(), card.version(), card.kind(), card.name(),
                card.path(), card.description(), card.riskLevel(),
                card.availability(), card.availabilityReason(),
                originOf(card.kind()),
                null, null, null
        );
    }

    /** 非注册表叶子的来源切面：DB 真相各归各类（docs/32 §4、docs/33 §3）。 */
    private String originOf(String kind) {
        return switch (kind) {
            case "pipeline" -> "kernel";
            case "schedule" -> "schedule";
            default -> "skill_store";
        };
    }

    /** 注册表工具的 kind 细分：实例类型即种类（docs/32 §1）。 */
    private String kindOf(ToolRegistry.ToolBinding binding) {
        return switch (binding.tool()) {
            case ResidentProcessTool ignored -> "process";
            case TemplateProcessTool ignored -> "template";
            case SkillTool ignored -> "skill";
            case KnowledgeDocumentTool ignored -> "knowledge";
            default -> {
                String provider = registry.providerOf(
                        binding.manifest().name());
                yield provider != null && provider.startsWith("mcp:")
                        ? "mcp_tool" : "kernel_tool";
            }
        };
    }

    private List<CapabilityCatalogSource.Definition> extensionDefinitions() {
        return extensionSources.stream()
                .flatMap(source -> source.definitions().stream())
                .toList();
    }
}
