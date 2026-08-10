package com.iris.tools.system.files;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.node.ArrayNode;
import com.fasterxml.jackson.databind.node.ObjectNode;
import com.iris.tools.catalog.CapabilityService;
import com.iris.tools.catalog.CapabilityService.CapabilityFileMatch;
import com.iris.tools.catalog.CapabilityService.CapabilityFileSearchResult;
import com.iris.tools.core.CommittedOperation;
import com.iris.tools.core.PreparedOperation;
import com.iris.tools.core.RiskLevel;
import com.iris.tools.core.Tool;
import com.iris.tools.core.ToolContext;
import com.iris.tools.core.ToolManifest;
import com.iris.tools.core.ToolOutcome;
import com.iris.tools.core.VerificationResult;
import com.iris.workspace.WorkspaceFileService;
import com.iris.workspace.WorkspaceFileService.SearchMatch;
import com.iris.workspace.WorkspaceFileService.SearchRequest;
import com.iris.workspace.WorkspaceFileService.SearchResult;
import com.iris.workspace.WorkspacePathGuard;
import org.springframework.beans.factory.ObjectProvider;
import org.springframework.stereotype.Component;

import java.io.IOException;
import java.time.Instant;
import java.util.List;

/**
 * 有界搜索工作区文本或 Capability Catalog projection。
 * package 自动形成 /system/files/search_files。
 */
@Component
public class SearchFilesTool implements Tool {

    private static final int DEFAULT_RESULTS = 100;

    private final ObjectMapper objectMapper;
    private final WorkspacePathGuard pathGuard;
    private final WorkspaceFileService fileService;
    private final ObjectProvider<CapabilityService> capabilities;
    private final ToolManifest manifest;

    public SearchFilesTool(
            ObjectMapper objectMapper,
            WorkspacePathGuard pathGuard,
            WorkspaceFileService fileService,
            ObjectProvider<CapabilityService> capabilities
    ) {
        this.objectMapper = objectMapper;
        this.pathGuard = pathGuard;
        this.fileService = fileService;
        this.capabilities = capabilities;
        this.manifest = new ToolManifest(
                "iris.system.files.search_files",
                "5",
                "search_files",
                "搜索工作区文本或能力目录描述；不知道事实或能力位于何处时按命名空间定位",
                inputSchema(),
                outputSchema(),
                RiskLevel.READ_ONLY,
                ToolManifest.SideEffect.NONE,
                20,
                90_000,
                ToolManifest.IdempotencySemantics.IDEMPOTENT,
                ToolManifest.EvidencePolicy.SUMMARY,
                ToolManifest.ContextRetention.REFETCHABLE,
                ToolManifest.ConcurrencySemantics.PARALLEL_SAFE,
                ToolManifest.CancellationSemantics.COOPERATIVE
        );
    }

    @Override
    public ToolManifest manifest() {
        return manifest;
    }

    @Override
    public PreparedOperation prepare(JsonNode input, ToolContext context) {
        String namespace = normalizeNamespace(
                input.path("namespace").asText("workspace")
        );
        String path = "capabilities".equals(namespace)
                ? capabilities.getObject().normalizePath(
                        input.path("path").asText("/")
                )
                : pathGuard.normalizeDirectory(
                        input.path("path").asText(".")
                );
        String query = WorkspaceFileToolSupport.requiredText(
                input.path("query").asText(),
                "query"
        );
        ObjectNode normalized = objectMapper.createObjectNode();
        normalized.put("namespace", namespace);
        normalized.put("path", path);
        normalized.put("query", query);
        normalized.put("regex", input.path("regex").asBoolean(false));
        normalized.put(
                "case_sensitive",
                input.path("case_sensitive").asBoolean(false)
        );
        putOptionalText(normalized, "glob", input.get("glob"));
        return new PreparedOperation(
                normalized,
                "在 " + ("capabilities".equals(namespace)
                        ? "能力目录 "
                        : "工作区目录 ")
                        + path + " 内搜索，不改变任何外部状态",
                List.of(),
                Instant.now().plusSeconds(60)
        );
    }

    @Override
    public ToolOutcome execute(
            CommittedOperation operation,
            ToolContext context
    ) throws IOException {
        JsonNode input = operation.normalizedInput();
        if ("capabilities".equals(
                input.path("namespace").asText("workspace")
        )) {
            return executeCapabilitySearch(input);
        }
        SearchResult result = fileService.search(
                context.workspaceRoot(),
                new SearchRequest(
                        input.path("path").asText(),
                        input.path("query").asText(),
                        input.path("regex").asBoolean(),
                        input.path("case_sensitive").asBoolean(),
                        nullableText(input.get("glob")),
                        false,
                        false,
                        DEFAULT_RESULTS
                ),
                context::cancelled
        );
        ObjectNode output = objectMapper.createObjectNode();
        output.put("namespace", "workspace");
        output.put("path", result.path());
        ArrayNode matches = output.putArray("matches");
        for (SearchMatch match : result.matches()) {
            ObjectNode item = matches.addObject();
            item.put("kind", "file");
            item.put("path", match.path());
            item.put("line", match.line());
            item.put("column", match.column());
            item.put("preview", match.preview());
        }
        output.put("candidateFiles", result.candidateFiles());
        output.put("searchedFiles", result.searchedFiles());
        output.put("skippedFiles", result.skippedFiles());
        output.put("scannedEntries", result.scannedEntries());
        output.put("truncated", result.truncated());
        output.put("guidance", guidance(result));
        return ToolOutcome.succeeded(output);
    }

    private ToolOutcome executeCapabilitySearch(JsonNode input) {
        CapabilityFileSearchResult result = capabilities.getObject()
                .searchFiles(
                        input.path("query").asText(),
                        input.path("path").asText(),
                        input.path("regex").asBoolean(),
                        input.path("case_sensitive").asBoolean(),
                        nullableText(input.get("glob")),
                        DEFAULT_RESULTS,
                        "personal"
                );
        ObjectNode output = objectMapper.createObjectNode();
        output.put("namespace", "capabilities");
        output.put("path", result.path());
        ArrayNode matches = output.putArray("matches");
        for (CapabilityFileMatch match : result.matches()) {
            ObjectNode item = matches.addObject();
            item.put("kind", "capability");
            item.put("path", match.path());
            item.put("line", 1);
            item.put("column", 1);
            item.put("preview", match.preview());
            item.put("name", match.name());
            item.put("matchedField", match.matchedField());
            item.put("riskLevel", match.riskLevel());
            item.put("availability", match.availability());
            item.put(
                    "availabilityReason",
                    match.availabilityReason()
            );
            item.put("lexicalScore", match.lexicalScore());
            if (match.semanticScore() == null) {
                item.putNull("semanticScore");
            } else {
                item.put("semanticScore", match.semanticScore());
            }
            item.put("combinedScore", match.combinedScore());
            item.put("exactAnchor", match.exactAnchor());
            item.put("retrievalStrategy", match.retrievalStrategy());
        }
        output.put("candidateFiles", result.candidateFiles());
        output.put("searchedFiles", result.candidateFiles());
        output.put("skippedFiles", 0);
        output.put("scannedEntries", result.scannedEntries());
        output.put("truncated", result.truncated());
        output.put("totalMatches", result.total());
        output.put("retrievalStrategy", result.retrievalStrategy());
        if (result.semanticModelIdentity() == null) {
            output.putNull("semanticModelIdentity");
        } else {
            output.put(
                    "semanticModelIdentity",
                    result.semanticModelIdentity()
            );
        }
        output.put("guidance", capabilityGuidance(result));
        return ToolOutcome.succeeded(output);
    }

    @Override
    public VerificationResult verify(
            ToolOutcome outcome,
            CommittedOperation operation,
            ToolContext context
    ) {
        String path = operation.normalizedInput().path("path").asText();
        boolean capabilitySearch = "capabilities".equals(
                operation.normalizedInput().path("namespace").asText()
        );
        return VerificationResult.confirmed(List.of(
                new VerificationResult.Evidence(
                        capabilitySearch
                                ? "capability_catalog_search"
                                : "workspace_text_search",
                        path,
                        capabilitySearch
                                ? "已在当前可见 Registry projection 中完成有界搜索"
                                : "已在工作区围栏内完成有界文本扫描"
                )
        ));
    }

    private String guidance(SearchResult result) {
        if (result.truncated()) {
            return "搜索已到预算；请缩小 path、glob 或使用更精确的 query";
        }
        if (result.matches().isEmpty()) {
            if (result.searchedFiles() == 0) {
                return "没有可搜索的文本文件；请先用 list_files 确认路径和文件类型";
            }
            return "已实际搜索 " + result.searchedFiles()
                    + " 个文本文件且无命中；可调整关键词、大小写或 glob";
        }
        return "命中已完整返回；可用 read_file 核对相邻原文";
    }

    private String capabilityGuidance(CapabilityFileSearchResult result) {
        if (result.truncated()) {
            return "能力命中已到预算；请缩小 path、glob 或使用更精确的 query";
        }
        if (result.matches().isEmpty()) {
            if (result.candidateFiles() == 0) {
                return "该能力目录下没有可搜索条目；请用 list_capabilities 核对目录";
            }
            return "已实际搜索 " + result.candidateFiles()
                    + " 个能力描述且无命中；可改搜对象、动作或目录段";
        }
        if (result.matches().stream().allMatch(match ->
                "unavailable".equals(match.availability()))) {
            return "找到相关 Definition，但当前 binding 均不可用；读取卡片中的 availabilityReason，先补齐对应 Application 或 Environment";
        }
        return "每个 path 都是精确能力地址；选择刚好够用的候选后 read_capability，"
                + "再把返回的 path、manifestHash 与参数交给 invoke_capability";
    }

    private String normalizeNamespace(String value) {
        String normalized = value == null
                ? "workspace"
                : value.trim().toLowerCase(java.util.Locale.ROOT);
        if (!"workspace".equals(normalized)
                && !"capabilities".equals(normalized)) {
            throw new IllegalArgumentException(
                    "namespace 只能是 workspace 或 capabilities"
            );
        }
        return normalized;
    }

    private void putOptionalText(
            ObjectNode target,
            String field,
            JsonNode value
    ) {
        if (value != null && !value.isNull() && !value.asText().isBlank()) {
            target.put(field, value.asText());
        }
    }

    private String nullableText(JsonNode value) {
        return value == null || value.isNull() ? null : value.asText();
    }

    private JsonNode inputSchema() {
        ObjectNode schema = WorkspaceFileToolSupport.objectSchema(objectMapper);
        ObjectNode properties = (ObjectNode) schema.path("properties");
        ObjectNode namespace = properties.putObject("namespace");
        namespace.put("type", "string");
        namespace.putArray("enum").add("workspace").add("capabilities");
        namespace.put("description",
                "搜索空间；默认 workspace，发现能力时使用 capabilities");
        properties.putObject("path").put("type", "string")
                .put("description",
                        "workspace 中为相对目录且默认 .；capabilities 中为绝对能力目录且默认 /");
        properties.putObject("query").put("type", "string")
                .put("description", "要搜索的文本或正则，最多 256 字符");
        properties.putObject("regex").put("type", "boolean")
                .put("description", "是否把 query 解释为受限 Java 正则；默认 false");
        properties.putObject("case_sensitive").put("type", "boolean")
                .put("description", "是否区分大小写；默认 false");
        properties.putObject("glob").put("type", "string")
                .put("description", "可选文件 glob，如 **/*.java");
        schema.putArray("required").add("query");
        return schema;
    }

    private JsonNode outputSchema() {
        ObjectNode schema = WorkspaceFileToolSupport.objectSchema(objectMapper);
        ObjectNode properties = (ObjectNode) schema.path("properties");
        properties.putObject("namespace").put("type", "string")
                .put("description", "实际搜索的逻辑空间");
        properties.putObject("path").put("type", "string")
                .put("description", "实际搜索的逻辑目录");
        ObjectNode matches = properties.putObject("matches");
        matches.put("type", "array");
        matches.put("description", "稳定路径顺序的首个逐行命中");
        ObjectNode item = matches.putObject("items");
        item.put("type", "object");
        ObjectNode itemProperties = item.putObject("properties");
        itemProperties.putObject("kind").put("type", "string");
        itemProperties.putObject("path").put("type", "string");
        itemProperties.putObject("line").put("type", "integer");
        itemProperties.putObject("column").put("type", "integer");
        itemProperties.putObject("preview").put("type", "string");
        itemProperties.putObject("name").put("type", "string");
        itemProperties.putObject("matchedField").put("type", "string");
        itemProperties.putObject("riskLevel").put("type", "string");
        itemProperties.putObject("availability").put("type", "string");
        itemProperties.putObject("availabilityReason").put("type", "string");
        itemProperties.putObject("lexicalScore").put("type", "number");
        itemProperties.putObject("semanticScore")
                .putArray("type").add("number").add("null");
        itemProperties.putObject("combinedScore").put("type", "number");
        itemProperties.putObject("exactAnchor").put("type", "boolean");
        itemProperties.putObject("retrievalStrategy").put("type", "string");
        properties.putObject("candidateFiles").put("type", "integer")
                .put("description", "通过路径和 glob 筛选的候选文件数");
        properties.putObject("searchedFiles").put("type", "integer")
                .put("description", "实际完成文本扫描的文件数");
        properties.putObject("skippedFiles").put("type", "integer")
                .put("description", "因隐藏、生成目录、大小或非文本跳过的数量");
        properties.putObject("scannedEntries").put("type", "integer")
                .put("description", "为完成搜索实际检查的目录条目数");
        properties.putObject("truncated").put("type", "boolean")
                .put("description", "是否因候选或命中预算提前结束");
        properties.putObject("guidance").put("type", "string")
                .put("description", "扫描证据与下一步收窄或核对建议");
        properties.putObject("totalMatches").put("type", "integer")
                .put("description", "能力搜索在截断前的总命中数；工作区搜索不返回");
        properties.putObject("retrievalStrategy").put("type", "string")
                .put("description", "能力目录实际采用的召回计划");
        properties.putObject("semanticModelIdentity")
                .put("description", "参与语义召回的向量模型身份；未启用或降级到关键词时为 null")
                .putArray("type").add("string").add("null");
        schema.putArray("required")
                .add("namespace").add("path").add("matches").add("candidateFiles")
                .add("searchedFiles").add("skippedFiles")
                .add("scannedEntries")
                .add("truncated").add("guidance");
        return schema;
    }
}
