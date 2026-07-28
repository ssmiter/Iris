package com.iris.tools.catalog;

import com.iris.tools.core.ToolRegistry;
import com.iris.tools.core.ToolRegistry.ToolBinding;
import com.iris.tools.core.ToolRuntimeException;
import org.springframework.stereotype.Service;

import java.util.ArrayList;
import java.util.Comparator;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Locale;
import java.util.Optional;
import java.util.Set;
import java.util.regex.Pattern;
import java.util.regex.PatternSyntaxException;

/**
 * 能力树服务（docs/03 §5）：目录树 + 每个目录的工具数统计。
 * 统计是模型的方向感——"/travel 有 128 个工具"比"有个 /travel 目录"更能引导探索。
 */
@Service
public class CapabilityService {

    private static final int MAX_QUERY_CHARACTERS = 256;
    private static final Pattern UNSAFE_REGEX = Pattern.compile(
            "\\([^)]*[+*][^)]*\\)[+*]"
    );
    private static final Set<String> BASE_DISCOVERY_TOOLS = Set.of(
            "list_capabilities",
            "search_files",
            "read_capability"
    );

    private final ToolRegistry registry;
    private final List<CatalogDocument> searchDocuments;

    public CapabilityService(ToolRegistry registry) {
        this.registry = registry;
        this.searchDocuments = registry.all().stream()
                .filter(binding -> !BASE_DISCOVERY_TOOLS.contains(
                        binding.manifest().name()
                ))
                .map(this::document)
                .sorted(Comparator.comparing(CatalogDocument::path))
                .toList();
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

    /**
     * search_files 的 Capability namespace projection。
     *
     * Definition 仍以 Registry binding 为执行真相；这里仅预编译稳定字段，避免每次
     * 查询重新序列化 schema 或构造虚拟 Markdown 文件。
     */
    public CapabilityFileSearchResult searchFiles(
            String query,
            String parentPath,
            boolean regex,
            boolean caseSensitive,
            String glob,
            int limit,
            String systemCode
    ) {
        if (query == null || query.isBlank()) {
            throw new IllegalArgumentException("query 不能为空");
        }
        if (query.length() > MAX_QUERY_CHARACTERS) {
            throw new ToolRuntimeException(
                    "search_query_too_long",
                    "搜索内容不能超过 " + MAX_QUERY_CHARACTERS + " 个字符"
            );
        }
        if (limit < 1 || limit > 100) {
            throw new IllegalArgumentException(
                    "搜索结果上限必须在 1 到 100 之间"
            );
        }
        String parent = normalizePath(parentPath);
        Pattern queryPattern = compileSearchPattern(
                query.trim(),
                regex,
                caseSensitive
        );
        Pattern globPattern = compileGlob(glob);
        List<CatalogDocument> candidates = searchDocuments.stream()
                .filter(document -> DomainCatalog.visible(
                        systemCode,
                        document.path()
                ))
                .filter(document -> within(document.path(), parent))
                .filter(document -> matchesGlob(
                        document.path(),
                        parent,
                        globPattern
                ))
                .toList();
        List<RankedDocument> matches = candidates.stream()
                .map(document -> rank(document, queryPattern))
                .filter(result -> result.score() > 0)
                .sorted(Comparator
                        .comparingInt(RankedDocument::score)
                        .reversed()
                        .thenComparing(result -> result.document().path()))
                .toList();
        return new CapabilityFileSearchResult(
                query.trim(),
                parent,
                candidates.size(),
                matches.size(),
                matches.stream()
                        .limit(limit)
                        .map(this::fileMatch)
                        .toList(),
                matches.size() > limit,
                candidates.size()
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

    private RankedDocument rank(
            CatalogDocument document,
            Pattern pattern
    ) {
        int score = 0;
        String matchedField = null;
        if (pattern.matcher(document.name()).find()) {
            score += 80;
            matchedField = "name";
        }
        if (pattern.matcher(document.path()).find()) {
            score += 50;
            if (matchedField == null) matchedField = "path";
        }
        if (pattern.matcher(document.description()).find()) {
            score += 30;
            if (matchedField == null) matchedField = "description";
        }
        if (pattern.matcher(document.parameterNames()).find()) {
            score += 20;
            if (matchedField == null) matchedField = "parameters";
        }
        if (pattern.matcher(document.metadata()).find()) {
            score += 10;
            if (matchedField == null) matchedField = "metadata";
        }
        return new RankedDocument(score, matchedField, document);
    }

    private CapabilityFileMatch fileMatch(RankedDocument ranked) {
        CatalogDocument document = ranked.document();
        return new CapabilityFileMatch(
                document.path(),
                document.name(),
                document.description(),
                ranked.matchedField(),
                document.binding().manifest().riskLevel()
                        .name().toLowerCase(Locale.ROOT)
        );
    }

    private CatalogDocument document(ToolBinding binding) {
        List<String> parameters = new ArrayList<>();
        binding.manifest().inputSchema().path("properties")
                .fieldNames().forEachRemaining(parameters::add);
        parameters.sort(String::compareTo);
        String metadata = String.join(" ",
                binding.manifest().id(),
                binding.manifest().version(),
                binding.manifest().riskLevel().name(),
                binding.manifest().sideEffect().name()
        );
        return new CatalogDocument(
                binding,
                binding.capabilityPath(),
                binding.manifest().name(),
                binding.manifest().description(),
                String.join(" ", parameters),
                metadata
        );
    }

    private Pattern compileSearchPattern(
            String query,
            boolean regex,
            boolean caseSensitive
    ) {
        String expression = regex ? query : Pattern.quote(query);
        if (regex && UNSAFE_REGEX.matcher(expression).find()) {
            throw new ToolRuntimeException(
                    "unsafe_search_regex",
                    "正则包含容易造成灾难性回溯的嵌套量词；请使用更直接的表达式"
            );
        }
        int flags = caseSensitive
                ? 0
                : Pattern.CASE_INSENSITIVE | Pattern.UNICODE_CASE;
        try {
            return Pattern.compile(expression, flags);
        } catch (PatternSyntaxException exception) {
            throw new ToolRuntimeException(
                    "invalid_search_regex",
                    "搜索正则无效：" + exception.getDescription()
            );
        }
    }

    private Pattern compileGlob(String glob) {
        if (glob == null || glob.isBlank()) {
            return null;
        }
        String normalized = glob.trim().replace('\\', '/');
        if (normalized.length() > 256
                || normalized.startsWith("/")
                || normalized.contains(":")
                || List.of(normalized.split("/")).contains("..")) {
            throw new ToolRuntimeException(
                    "invalid_search_glob",
                    "glob 必须是能力目录内不含 .. 的相对模式"
            );
        }
        StringBuilder expression = new StringBuilder("^");
        for (int index = 0; index < normalized.length(); index++) {
            char current = normalized.charAt(index);
            if (current == '*') {
                if (index + 1 < normalized.length()
                        && normalized.charAt(index + 1) == '*') {
                    expression.append(".*");
                    index++;
                } else {
                    expression.append("[^/]*");
                }
            } else if (current == '?') {
                expression.append("[^/]");
            } else {
                if (".+()^${}|[]\\".indexOf(current) >= 0) {
                    expression.append('\\');
                }
                expression.append(current);
            }
        }
        expression.append('$');
        return Pattern.compile(expression.toString());
    }

    private boolean matchesGlob(
            String path,
            String parent,
            Pattern globPattern
    ) {
        if (globPattern == null) {
            return true;
        }
        String prefix = "/".equals(parent) ? "/" : parent + "/";
        String relative = path.startsWith(prefix)
                ? path.substring(prefix.length())
                : path;
        return globPattern.matcher(relative).matches();
    }

    private boolean within(String path, String parent) {
        return "/".equals(parent)
                || path.equals(parent)
                || path.startsWith(parent + "/");
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

    public String normalizePath(String path) {
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

    public record CapabilityFileSearchResult(
            String query,
            String path,
            int candidateFiles,
            int total,
            List<CapabilityFileMatch> matches,
            boolean truncated,
            int scannedEntries
    ) {
    }

    public record CapabilityFileMatch(
            String path,
            String name,
            String preview,
            String matchedField,
            String riskLevel
    ) {
    }

    private record CatalogDocument(
            ToolBinding binding,
            String path,
            String name,
            String description,
            String parameterNames,
            String metadata
    ) {
    }

    private record RankedDocument(
            int score,
            String matchedField,
            CatalogDocument document
    ) {
    }
}
