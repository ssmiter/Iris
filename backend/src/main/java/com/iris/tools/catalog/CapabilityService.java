package com.iris.tools.catalog;

import com.iris.tools.core.ToolRegistry;
import com.iris.tools.core.ToolRegistry.ToolBinding;
import com.iris.tools.core.ToolRuntimeException;
import com.iris.tools.core.CapabilityAvailability;
import com.iris.tools.core.CapabilityAvailabilityService;
import com.iris.tools.catalog.CapabilityDirectoryCatalog.DirectoryDefinition;
import com.iris.agent.pipeline.PipelineDefinitionRegistry;
import com.iris.agent.pipeline.PipelineDefinitionRegistry.Binding;
import com.iris.tools.catalog.CapabilityCatalogSource.Definition;
import com.iris.retrieval.HybridRetrievalEngine;
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
    private final CapabilityAvailabilityService availability;
    private final CapabilityDirectoryCatalog directoryCatalog;
    private final PipelineDefinitionRegistry pipelines;
    private final HybridRetrievalEngine retrieval;
    private final DirectoryStatsService directoryStats;
    private final List<CapabilityCatalogSource> extensionSources;

    public CapabilityService(
            ToolRegistry registry,
            CapabilityAvailabilityService availability,
            CapabilityDirectoryCatalog directoryCatalog,
            PipelineDefinitionRegistry pipelines,
            HybridRetrievalEngine retrieval,
            DirectoryStatsService directoryStats,
            List<CapabilityCatalogSource> extensionSources
    ) {
        this.registry = registry;
        this.availability = availability;
        this.directoryCatalog = directoryCatalog;
        this.pipelines = pipelines;
        this.retrieval = retrieval;
        this.directoryStats = directoryStats;
        this.extensionSources = List.copyOf(extensionSources);
    }

    private List<CatalogDocument> searchDocuments() {
        return java.util.stream.Stream.concat(
                registry.all().stream()
                .filter(binding -> !BASE_DISCOVERY_TOOLS.contains(
                        binding.manifest().name()
                ))
                .map(this::document),
                java.util.stream.Stream.concat(
                        pipelines.all().stream().map(this::document),
                        extensionDefinitions().stream().map(this::document)
                )
        )
                .sorted(Comparator.comparing(CatalogDocument::path))
                .toList();
    }

    private List<Definition> extensionDefinitions() {
        return extensionSources.stream()
                .flatMap(source -> source.definitions().stream())
                .sorted(Comparator.comparing(Definition::path))
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
        for (Binding binding : pipelines.all()) {
            String path = binding.definition().capabilityPath();
            if (!DomainCatalog.visible(systemCode, path)) continue;
            String[] segs = path.substring(1).split("/");
            StringBuilder cur = new StringBuilder();
            for (String seg : segs) {
                cur.append('/').append(seg);
                counts.merge(cur.toString(), 1, Integer::sum);
            }
        }
        for (Definition definition : extensionDefinitions()) {
            if (!DomainCatalog.visible(systemCode, definition.path())) {
                continue;
            }
            String[] segments = definition.path().substring(1).split("/");
            StringBuilder current = new StringBuilder();
            for (String segment : segments) {
                current.append('/').append(segment);
                counts.merge(current.toString(), 1, Integer::sum);
            }
        }
        for (DirectoryDefinition directory : directoryCatalog.all()) {
            if (!DomainCatalog.visible(systemCode, directory.path())) {
                continue;
            }
            addDirectoryPath(counts, directory.path());
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
        for (Binding binding : pipelines.all()) {
            String path = binding.definition().capabilityPath();
            if (!DomainCatalog.visible(systemCode, path)
                    || !path.startsWith(prefix)) {
                continue;
            }
            String remainder = path.substring(prefix.length());
            int slash = remainder.indexOf('/');
            if (slash >= 0) {
                directories.merge(
                        prefix + remainder.substring(0, slash),
                        1,
                        Integer::sum
                );
            } else {
                items.add(card(binding));
            }
        }
        for (Definition definition : extensionDefinitions()) {
            String path = definition.path();
            if (!DomainCatalog.visible(systemCode, path)
                    || !path.startsWith(prefix)) {
                continue;
            }
            String remainder = path.substring(prefix.length());
            int slash = remainder.indexOf('/');
            if (slash >= 0) {
                directories.merge(
                        prefix + remainder.substring(0, slash),
                        1,
                        Integer::sum
                );
            } else {
                items.add(card(definition));
            }
        }
        for (DirectoryDefinition directory : directoryCatalog.all()) {
            if (DomainCatalog.visible(systemCode, directory.path())
                    && isDirectChild(parent, directory.path())) {
                directories.putIfAbsent(directory.path(), 0);
            }
        }
        List<DirectoryCard> directoryCards = directories.entrySet().stream()
                .sorted(Map.Entry.comparingByKey())
                .map(entry -> directoryCard(
                        entry.getKey(),
                        entry.getValue()
                ))
                .toList();
        return new CapabilityListing(
                parent,
                "具体对象或动作已明确时停止逐层浏览，改用 search_files(namespace=capabilities)；"
                        + "directories[].path 只能继续列目录，只有 items[].path 才能读取精确定义。",
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
        String normalizedQuery = query.trim();
        List<Pattern> queryPatterns = compileSearchPatterns(
                normalizedQuery,
                regex,
                caseSensitive
        );
        Pattern globPattern = compileGlob(glob);
        List<CatalogDocument> candidates = searchDocuments().stream()
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
        List<RankedDocument> lexical = candidates.stream()
                .map(document -> rank(document, queryPatterns))
                .toList();
        List<RankedDocument> matches;
        String retrievalStrategy;
        String semanticModelIdentity;
        if (regex) {
            matches = lexical.stream()
                    .filter(result -> result.score() > 0)
                    .sorted(Comparator
                            .comparingInt(RankedDocument::score)
                            .reversed()
                            .thenComparing(result ->
                                    result.document().path()))
                    .toList();
            retrievalStrategy = "lexical_regex";
            semanticModelIdentity = null;
        } else {
            var fused = retrieval.rank(
                    normalizedQuery,
                    lexical.stream().map(result ->
                            new HybridRetrievalEngine.Candidate<>(
                                    result,
                                    result.document().path(),
                                    semanticText(result.document()),
                                    result.score(),
                                    exactAnchor(
                                            normalizedQuery,
                                            result.document(),
                                            caseSensitive
                                    )
                            )
                    ).toList(),
                    candidates.size()
            );
            matches = fused.matches().stream().map(item -> {
                RankedDocument lexicalResult = item.value();
                return new RankedDocument(
                        lexicalResult.score(),
                        lexicalResult.score() > 0
                                ? lexicalResult.matchedField()
                                : "semantic",
                        lexicalResult.document(),
                        item.lexicalScore(),
                        item.semanticScore(),
                        item.combinedScore(),
                        item.exactAnchor(),
                        item.strategy()
                );
            }).toList();
            retrievalStrategy = fused.strategy();
            semanticModelIdentity = fused.modelIdentity();
        }
        return new CapabilityFileSearchResult(
                normalizedQuery,
                parent,
                candidates.size(),
                matches.size(),
                matches.stream()
                        .limit(limit)
                        .map(this::fileMatch)
                        .toList(),
                matches.size() > limit,
                candidates.size(),
                retrievalStrategy,
                semanticModelIdentity
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

    public Optional<Binding> readPipeline(
            String capabilityPath,
            String systemCode
    ) {
        String path = normalizePath(capabilityPath);
        return pipelines.findByPath(path)
                .filter(binding -> DomainCatalog.visible(
                        systemCode,
                        binding.definition().capabilityPath()
                ));
    }

    public Optional<Definition> readExtension(
            String capabilityPath,
            String systemCode
    ) {
        String path = normalizePath(capabilityPath);
        if (!DomainCatalog.visible(systemCode, path)) {
            return Optional.empty();
        }
        return extensionSources.stream()
                .map(source -> source.findByPath(path))
                .flatMap(Optional::stream)
                .findFirst();
    }

    public CapabilityAvailability availability(ToolBinding binding) {
        return availability.current(binding);
    }

    private RankedDocument rank(
            CatalogDocument document,
            List<Pattern> patterns
    ) {
        int score = 0;
        String matchedField = null;
        for (Pattern pattern : patterns) {
            if (pattern.matcher(document.name()).find()) {
                score += 80;
                matchedField = prefer(matchedField, "name");
            }
            if (pattern.matcher(document.path()).find()) {
                score += 50;
                matchedField = prefer(matchedField, "path");
            }
            if (pattern.matcher(document.description()).find()) {
                score += 30;
                matchedField = prefer(matchedField, "description");
            }
            if (pattern.matcher(document.parameterNames()).find()) {
                score += 20;
                matchedField = prefer(matchedField, "parameters");
            }
            if (pattern.matcher(document.metadata()).find()) {
                score += 10;
                matchedField = prefer(matchedField, "metadata");
            }
        }
        return new RankedDocument(
                score,
                matchedField,
                document,
                0D,
                null,
                0D,
                false,
                "lexical"
        );
    }

    private String semanticText(CatalogDocument document) {
        return String.join("\n",
                document.name(),
                document.path(),
                document.description(),
                document.parameterNames(),
                document.metadata()
        );
    }

    private boolean exactAnchor(
            String query,
            CatalogDocument document,
            boolean caseSensitive
    ) {
        String needle = caseSensitive
                ? query : query.toLowerCase(Locale.ROOT);
        String name = caseSensitive
                ? document.name()
                : document.name().toLowerCase(Locale.ROOT);
        String path = caseSensitive
                ? document.path()
                : document.path().toLowerCase(Locale.ROOT);
        return name.contains(needle) || path.contains(needle);
    }

    private String prefer(String current, String candidate) {
        if (current == null) {
            return candidate;
        }
        List<String> priority = List.of(
                "name",
                "path",
                "description",
                "parameters",
                "metadata"
        );
        return priority.indexOf(candidate) < priority.indexOf(current)
                ? candidate
                : current;
    }

    private CapabilityFileMatch fileMatch(RankedDocument ranked) {
        CatalogDocument document = ranked.document();
        CapabilityAvailability current = document.binding() == null
                ? new CapabilityAvailability(
                        CapabilityAvailability.Status.valueOf(
                                document.availability().toUpperCase(Locale.ROOT)
                        ),
                        document.availabilityReason(),
                        java.time.Instant.now()
                )
                : availability.current(document.binding());
        return new CapabilityFileMatch(
                document.path(),
                document.name(),
                document.description(),
                ranked.matchedField(),
                document.riskLevel(),
                current.value(),
                current.reason(),
                ranked.lexicalScore(),
                ranked.semanticScore(),
                ranked.combinedScore(),
                ranked.exactAnchor(),
                ranked.strategy()
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
                "tool",
                binding.capabilityPath(),
                binding.manifest().name(),
                binding.manifest().description(),
                String.join(" ", parameters),
                metadata,
                binding.manifest().riskLevel()
                        .name().toLowerCase(Locale.ROOT),
                null,
                null
        );
    }

    private CatalogDocument document(Binding binding) {
        var definition = binding.definition();
        java.util.ArrayList<String> parameters = new java.util.ArrayList<>();
        definition.inputSchema().path("properties")
                .fieldNames().forEachRemaining(parameters::add);
        parameters.sort(String::compareTo);
        return new CatalogDocument(
                null,
                "pipeline",
                definition.capabilityPath(),
                definition.name(),
                definition.description(),
                String.join(" ", parameters),
                definition.id() + " " + definition.version()
                        + " pipeline",
                "standard",
                "available",
                "本地 Pipeline Definition 已注册"
        );
    }

    private CatalogDocument document(Definition definition) {
        List<String> parameters = new ArrayList<>();
        definition.manifest().path("inputSchema").path("properties")
                .fieldNames().forEachRemaining(parameters::add);
        parameters.sort(String::compareTo);
        String extensionMetadata = String.join(" ",
                definition.manifest().path("title").asText(""),
                definition.manifest().path("whenToUse").asText(""),
                definition.manifest().path("dependencies").toString()
        );
        return new CatalogDocument(
                null,
                definition.kind(),
                definition.path(),
                definition.name(),
                definition.description(),
                String.join(" ", parameters),
                definition.id() + " " + definition.version()
                        + " " + definition.kind()
                        + " " + extensionMetadata,
                definition.riskLevel(),
                definition.availability(),
                definition.availabilityReason()
        );
    }

    private List<Pattern> compileSearchPatterns(
            String query,
            boolean regex,
            boolean caseSensitive
    ) {
        if (regex) {
            return List.of(compileSearchPattern(
                    query,
                    true,
                    caseSensitive
            ));
        }
        return searchTerms(query).stream()
                .map(term -> compileSearchPattern(
                        term,
                        false,
                        caseSensitive
                ))
                .toList();
    }

    private List<String> searchTerms(String query) {
        java.util.LinkedHashSet<String> terms =
                new java.util.LinkedHashSet<>();
        java.util.regex.Matcher matcher = Pattern.compile(
                "[\\p{IsHan}]+|[\\p{L}\\p{N}_-]+"
        ).matcher(query);
        while (matcher.find()) {
            String token = matcher.group();
            if (token.codePoints().allMatch(codePoint ->
                    Character.UnicodeScript.of(codePoint)
                            == Character.UnicodeScript.HAN)) {
                int[] characters = token.codePoints().toArray();
                if (characters.length <= 2) {
                    terms.add(token);
                    continue;
                }
                for (int index = 0; index < characters.length - 1; index++) {
                    terms.add(new String(characters, index, 2));
                }
            } else if (token.length() >= 2) {
                terms.add(token);
            }
        }
        if (terms.isEmpty()) {
            terms.add(query);
        }
        return List.copyOf(terms);
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
        CapabilityAvailability current = availability.current(binding);
        return new CapabilityCard(
                binding.manifest().id(),
                binding.manifest().version(),
                "tool",
                binding.manifest().name(),
                binding.capabilityPath(),
                binding.manifest().description(),
                binding.manifest().riskLevel().name().toLowerCase(),
                current.value(),
                current.reason()
        );
    }

    private CapabilityCard card(Binding binding) {
        var definition = binding.definition();
        return new CapabilityCard(
                definition.id(),
                definition.version(),
                "pipeline",
                definition.name(),
                definition.capabilityPath(),
                definition.description(),
                "standard",
                "available",
                "本地 Pipeline Definition 已注册"
        );
    }

    private CapabilityCard card(Definition definition) {
        return new CapabilityCard(
                definition.id(),
                definition.version(),
                definition.kind(),
                definition.name(),
                definition.path(),
                definition.description(),
                definition.riskLevel(),
                definition.availability(),
                definition.availabilityReason()
        );
    }

    private DirectoryCard directoryCard(String path, int count) {
        Optional<DirectoryDefinition> definition =
                directoryCatalog.find(path);
        String segment = path.substring(path.lastIndexOf('/') + 1);
        List<String> expose = definition
                .map(DirectoryDefinition::statsExpose)
                .orElse(List.of());
        Map<String, Object> stats = expose.isEmpty()
                ? Map.of()
                : directoryStats.stats(path, count, expose);
        return new DirectoryCard(
                path,
                definition.map(DirectoryDefinition::title)
                        .orElseGet(() ->
                                DomainCatalog.segmentLabel(segment)
                        ),
                definition.map(DirectoryDefinition::description)
                        .orElse("按目录组织的能力集合"),
                count,
                stats
        );
    }

    private boolean isDirectChild(String parent, String candidate) {
        String prefix = "/".equals(parent) ? "/" : parent + "/";
        if (!candidate.startsWith(prefix)) {
            return false;
        }
        String remainder = candidate.substring(prefix.length());
        return !remainder.isBlank() && !remainder.contains("/");
    }

    private void addDirectoryPath(
            Map<String, Integer> counts,
            String path
    ) {
        String[] segments = path.substring(1).split("/");
        StringBuilder current = new StringBuilder();
        for (String segment : segments) {
            current.append('/').append(segment);
            counts.putIfAbsent(current.toString(), 0);
        }
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
            String description,
            int capabilityCount,
            /** `_directory.yml` 声明的口径的实时值；未声明则为空表。 */
            Map<String, Object> stats
    ) {
    }

    public record CapabilityCard(
            String id,
            String version,
            String kind,
            String name,
            String path,
            String description,
            String riskLevel,
            String availability,
            String availabilityReason
    ) {
    }

    public record CapabilityListing(
            String parentPath,
            String guidance,
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
            int scannedEntries,
            String retrievalStrategy,
            String semanticModelIdentity
    ) {
    }

    public record CapabilityFileMatch(
            String path,
            String name,
            String preview,
            String matchedField,
            String riskLevel,
            String availability,
            String availabilityReason,
            double lexicalScore,
            Double semanticScore,
            double combinedScore,
            boolean exactAnchor,
            String retrievalStrategy
    ) {
    }

    private record CatalogDocument(
            ToolBinding binding,
            String kind,
            String path,
            String name,
            String description,
            String parameterNames,
            String metadata,
            String riskLevel,
            String availability,
            String availabilityReason
    ) {
    }

    private record RankedDocument(
            int score,
            String matchedField,
            CatalogDocument document,
            double lexicalScore,
            Double semanticScore,
            double combinedScore,
            boolean exactAnchor,
            String strategy
    ) {
    }
}
