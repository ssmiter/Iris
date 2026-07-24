package com.iris.tools.catalog;

import com.iris.tools.core.ToolRegistry;
import com.iris.tools.core.ToolRegistry.ToolBinding;
import org.springframework.stereotype.Service;

import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Locale;
import java.util.Optional;

/**
 * 能力树服务（docs/03 §5）：目录树 + 每个目录的工具数统计。
 * 统计是模型的方向感——"/travel 有 128 个工具"比"有个 /travel 目录"更能引导探索。
 */
@Service
public class CapabilityService {

    private final ToolRegistry registry;

    public CapabilityService(ToolRegistry registry) {
        this.registry = registry;
    }

    public record CapabilityNode(
            String path,
            String name,
            int toolCount,
            List<CapabilityNode> children
    ) {}

    /** 按身份过滤后的能力树（统计递归汇总）。 */
    public CapabilityNode tree(String systemCode) {
        Map<String, Integer> counts = new LinkedHashMap<>();
        for (ToolBinding binding : registry.all()) {
            String path = binding.capabilityPath();
            if (!DomainCatalog.visible(systemCode, path)) continue;
            // 沿路径向上累计每一级目录
            String[] segs = path.substring(1).split("/");
            StringBuilder cur = new StringBuilder();
            for (String seg : segs) {
                cur.append('/').append(seg);
                counts.merge(cur.toString(), 1, Integer::sum);
            }
        }
        return buildNode("", counts);
    }

    public CapabilityListing list(String parentPath, String systemCode) {
        String parent = normalizePath(parentPath);
        List<ToolBinding> visible = registry.all().stream()
                .filter(binding -> DomainCatalog.visible(
                        systemCode,
                        binding.capabilityPath()
                ))
                .toList();
        Map<String, Integer> directories = new LinkedHashMap<>();
        List<CapabilityCard> items = new ArrayList<>();
        String prefix = "/".equals(parent) ? "/" : parent + "/";
        for (ToolBinding binding : visible) {
            if (!binding.capabilityPath().startsWith(prefix)) {
                continue;
            }
            String remainder = binding.capabilityPath()
                    .substring(prefix.length());
            int slash = remainder.indexOf('/');
            if (slash >= 0) {
                String child = prefix + remainder.substring(0, slash);
                directories.merge(child, 1, Integer::sum);
            } else {
                items.add(card(binding));
            }
        }
        List<DirectoryCard> directoryCards = directories.entrySet().stream()
                .sorted(Map.Entry.comparingByKey())
                .map(entry -> new DirectoryCard(
                        entry.getKey(),
                        DomainCatalog.segmentLabel(
                                entry.getKey().substring(
                                        entry.getKey().lastIndexOf('/') + 1
                                )
                        ),
                        entry.getValue()
                ))
                .toList();
        return new CapabilityListing(
                parent,
                directoryCards,
                items.stream()
                        .sorted(java.util.Comparator.comparing(
                                CapabilityCard::path
                        ))
                        .toList()
        );
    }

    public SearchResult search(
            String query,
            int limit,
            String systemCode
    ) {
        if (query == null || query.isBlank()) {
            throw new IllegalArgumentException("Search query cannot be blank");
        }
        if (limit < 1 || limit > 50) {
            throw new IllegalArgumentException(
                    "Search limit must be between 1 and 50"
            );
        }
        List<String> terms = List.of(
                query.toLowerCase(Locale.ROOT).trim().split("\\s+")
        );
        List<RankedCard> matches = registry.all().stream()
                .filter(binding -> DomainCatalog.visible(
                        systemCode,
                        binding.capabilityPath()
                ))
                .map(binding -> new RankedCard(
                        score(binding, terms),
                        card(binding)
                ))
                .filter(result -> result.score() > 0)
                .sorted(java.util.Comparator
                        .comparingInt(RankedCard::score)
                        .reversed()
                        .thenComparing(result -> result.card().path()))
                .toList();
        return new SearchResult(
                query.trim(),
                matches.size(),
                matches.stream()
                        .limit(limit)
                        .map(RankedCard::card)
                        .toList()
        );
    }

    public Optional<ToolBinding> read(
            String capabilityPath,
            String systemCode
    ) {
        String path = normalizePath(capabilityPath);
        return registry.all().stream()
                .filter(binding -> binding.capabilityPath().equals(path))
                .filter(binding -> DomainCatalog.visible(
                        systemCode,
                        binding.capabilityPath()
                ))
                .findFirst();
    }

    private int score(ToolBinding binding, List<String> terms) {
        String name = binding.manifest().name().toLowerCase(Locale.ROOT);
        String description = binding.manifest().description()
                .toLowerCase(Locale.ROOT);
        String path = binding.capabilityPath().toLowerCase(Locale.ROOT);
        String schema = binding.manifest().inputSchema()
                .path("properties").fieldNames().hasNext()
                ? binding.manifest().inputSchema()
                        .path("properties").toString()
                        .toLowerCase(Locale.ROOT)
                : "";
        int score = 0;
        for (String term : terms) {
            if (name.equals(term)) {
                score += 20;
            } else if (name.contains(term)) {
                score += 10;
            }
            if (path.contains(term)) {
                score += 6;
            }
            if (description.contains(term)) {
                score += 4;
            }
            if (schema.contains(term)) {
                score += 2;
            }
        }
        return score;
    }

    private CapabilityCard card(ToolBinding binding) {
        return new CapabilityCard(
                binding.manifest().id(),
                binding.manifest().version(),
                binding.manifest().name(),
                binding.capabilityPath(),
                binding.manifest().description(),
                binding.manifest().riskLevel().name().toLowerCase(),
                "available"
        );
    }

    private String normalizePath(String path) {
        if (path == null || path.isBlank() || "/".equals(path.trim())) {
            return "/";
        }
        String normalized = path.trim().replace('\\', '/');
        if (!normalized.startsWith("/")
                || normalized.endsWith("/")
                || normalized.contains("//")
                || normalized.contains("..")) {
            throw new IllegalArgumentException(
                    "Capability path is invalid"
            );
        }
        return normalized;
    }

    private CapabilityNode buildNode(String path, Map<String, Integer> counts) {
        List<CapabilityNode> children = new ArrayList<>();
        String prefix = path.isEmpty() ? "/" : path + "/";
        counts.keySet().stream()
                .filter(p -> p.startsWith(prefix) && p.substring(prefix.length()).indexOf('/') < 0)
                .sorted()
                .forEach(p -> children.add(buildNode(p, counts)));
        String name = path.isEmpty() ? "根"
                : DomainCatalog.segmentLabel(path.substring(path.lastIndexOf('/') + 1));
        return new CapabilityNode(path.isEmpty() ? "/" : path, name,
                counts.getOrDefault(path, 0), children);
    }

    public record DirectoryCard(
            String path,
            String title,
            int capabilityCount
    ) {
    }

    public record CapabilityCard(
            String id,
            String version,
            String name,
            String path,
            String description,
            String riskLevel,
            String availability
    ) {
    }

    public record CapabilityListing(
            String parentPath,
            List<DirectoryCard> directories,
            List<CapabilityCard> items
    ) {
    }

    public record SearchResult(
            String query,
            int total,
            List<CapabilityCard> items
    ) {
    }

    private record RankedCard(int score, CapabilityCard card) {
    }
}
