package com.iris.agent.model;

import com.fasterxml.jackson.core.JsonProcessingException;
import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.node.ArrayNode;
import com.fasterxml.jackson.databind.node.ObjectNode;
import com.iris.agent.model.ModelAttemptRepository.AttemptRow;
import com.iris.agent.model.ModelRequestSnapshotRepository.PreviousSnapshot;
import com.iris.agent.model.provider.ModelProvider;
import com.iris.storage.SqliteBusyRetry;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.stereotype.Service;
import org.springframework.transaction.support.TransactionTemplate;

import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.security.NoSuchAlgorithmException;
import java.time.Clock;
import java.util.ArrayList;
import java.util.HexFormat;
import java.util.List;
import java.util.Map;
import java.util.Objects;
import java.util.Optional;
import java.util.TreeMap;
import java.util.TreeSet;

/**
 * docs/42 §5.2：每个模型请求的非历史 header 在装配完成、发送前一点采集为
 * 完整快照落库（完整快照而非 delta）。快照只覆盖 header——身份、渲染后
 * system、可见工具集、调用配置（maxOutputTokens / effort）；历史内容已由
 * model_attempt.context_hash 锚定，不重复进快照，否则 hash 每轮必变，
 * sameAsPrevious 失去意义。
 *
 * <p>采集点在 consume 段、provider.stream 订阅之前，保证「落库的即发出的」；
 * 重试的 successor attempt 各自落一行。hash 相对同一 Run 上一快照变化时记
 * 一条 INFO（含字段级差异概要），让「装配变动 → 命中率跌落」可归因。</p>
 */
@Service
public class ModelRequestSnapshotService {
    private static final Logger log =
            LoggerFactory.getLogger(ModelRequestSnapshotService.class);
    private static final int MAX_DIFF_ENTRIES = 8;
    private static final int ABBREVIATED_LENGTH = 16;

    private final ModelRequestSnapshotRepository snapshots;
    private final TransactionTemplate transactions;
    private final ObjectMapper objectMapper;
    private final Clock clock = Clock.systemUTC();

    public ModelRequestSnapshotService(
            ModelRequestSnapshotRepository snapshots,
            TransactionTemplate transactions,
            ObjectMapper objectMapper
    ) {
        this.snapshots = snapshots;
        this.transactions = transactions;
        this.objectMapper = objectMapper;
    }

    public void capture(
            ModelProvider provider,
            AttemptRow attempt,
            ModelRequest request
    ) {
        String snapshotJson = write(build(provider, request));
        String snapshotHash = hash(snapshotJson);
        Optional<PreviousSnapshot> previous = SqliteBusyRetry.execute(
                transactions,
                () -> {
                    Optional<PreviousSnapshot> earlier =
                            snapshots.previousInRun(attempt.attemptId());
                    snapshots.insert(
                            attempt.attemptId(),
                            snapshotHash,
                            earlier.map(snapshot ->
                                    snapshot.snapshotHash().equals(snapshotHash))
                                    .orElse(false),
                            snapshotJson,
                            clock.instant()
                    );
                    return earlier;
                }
        );
        if (previous.isPresent()
                && !previous.get().snapshotHash().equals(snapshotHash)) {
            log.info(
                    "模型请求 header 快照变更：attempt={}，hash {} -> {}，差异：{}",
                    attempt.attemptId(),
                    abbreviate(previous.get().snapshotHash()),
                    abbreviate(snapshotHash),
                    diffSummary(previous.get().snapshotJson(), snapshotJson)
            );
        }
    }

    private ObjectNode build(ModelProvider provider, ModelRequest request) {
        ObjectNode root = objectMapper.createObjectNode();
        ObjectNode identity = root.putObject("identity");
        identity.put("profileId", provider.profileId());
        identity.put("providerKind", provider.providerKind());
        identity.put("modelId", provider.modelId());

        ObjectNode system = root.putObject("system");
        String promptDefinitionId = request.metadata().get("promptDefinitionId");
        if (promptDefinitionId != null) {
            system.put("promptDefinitionId", promptDefinitionId);
        }
        String promptVersion = request.metadata().get("promptVersion");
        if (promptVersion != null) {
            try {
                system.put("promptVersion", Integer.parseInt(promptVersion));
            } catch (NumberFormatException notNumeric) {
                system.put("promptVersion", promptVersion);
            }
        }
        String systemInstruction = request.systemInstruction();
        system.put("renderedSha256", hash(systemInstruction));
        system.put("characters", systemInstruction.length());

        ObjectNode tools = root.putObject("tools");
        tools.put("count", request.tools().size());
        ArrayNode names = tools.putArray("names");
        StringBuilder schemaMaterial = new StringBuilder();
        for (ModelRequest.ToolDefinition tool : request.tools()) {
            names.add(tool.name());
            schemaMaterial.append(tool.name()).append('\n')
                    .append(Objects.toString(tool.description(), ""))
                    .append('\n')
                    .append(tool.inputSchema() == null
                            ? ""
                            : tool.inputSchema().toString())
                    .append('\n');
        }
        tools.put("schemasSha256", hash(schemaMaterial.toString()));

        ObjectNode config = root.putObject("config");
        config.put("maxOutputTokens", provider.maxOutputTokens());
        config.put("effort", provider.effort());
        return root;
    }

    /**
     * 字段级差异概要：把两份快照拍平成 path -> 值再比对，数组并成单行。
     * 只用于日志归因，不是协议语义。
     */
    private String diffSummary(String previousJson, String currentJson) {
        Map<String, String> before = flatten(read(previousJson));
        Map<String, String> after = flatten(read(currentJson));
        TreeSet<String> keys = new TreeSet<>();
        keys.addAll(before.keySet());
        keys.addAll(after.keySet());
        List<String> changes = new ArrayList<>();
        for (String key : keys) {
            String oldValue = before.get(key);
            String newValue = after.get(key);
            if (Objects.equals(oldValue, newValue)) {
                continue;
            }
            changes.add(key + ": "
                    + abbreviate(oldValue) + " -> " + abbreviate(newValue));
            if (changes.size() >= MAX_DIFF_ENTRIES) {
                changes.add("...");
                break;
            }
        }
        return changes.isEmpty() ? "(无字段差异)" : String.join("；", changes);
    }

    private Map<String, String> flatten(JsonNode node) {
        Map<String, String> out = new TreeMap<>();
        flattenInto(node, "", out);
        return out;
    }

    private void flattenInto(
            JsonNode node,
            String path,
            Map<String, String> out
    ) {
        if (node.isObject()) {
            node.fields().forEachRemaining(entry -> flattenInto(
                    entry.getValue(),
                    path.isEmpty() ? entry.getKey() : path + "." + entry.getKey(),
                    out
            ));
            return;
        }
        if (node.isArray()) {
            List<String> elements = new ArrayList<>();
            node.forEach(element -> elements.add(element.asText()));
            out.put(path, String.join(",", elements));
            return;
        }
        out.put(path, node.asText());
    }

    private String abbreviate(String value) {
        if (value == null) {
            return "(无)";
        }
        return value.length() <= ABBREVIATED_LENGTH
                ? value
                : value.substring(0, ABBREVIATED_LENGTH) + "…";
    }

    private JsonNode read(String json) {
        try {
            return objectMapper.readTree(json);
        } catch (JsonProcessingException exception) {
            throw new IllegalStateException("请求快照不是合法 JSON", exception);
        }
    }

    private String write(Object value) {
        try {
            return objectMapper.writeValueAsString(value);
        } catch (JsonProcessingException exception) {
            throw new IllegalStateException("请求快照无法序列化", exception);
        }
    }

    private String hash(String value) {
        try {
            return HexFormat.of().formatHex(
                    MessageDigest.getInstance("SHA-256")
                            .digest(value.getBytes(StandardCharsets.UTF_8))
            );
        } catch (NoSuchAlgorithmException exception) {
            throw new IllegalStateException("SHA-256 unavailable", exception);
        }
    }
}
