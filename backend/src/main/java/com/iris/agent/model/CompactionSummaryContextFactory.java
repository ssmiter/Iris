package com.iris.agent.model;

import com.fasterxml.jackson.core.JsonProcessingException;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.node.ObjectNode;
import com.iris.agent.model.CompactionRepository.CompactionRow;
import org.springframework.stereotype.Component;

import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.security.NoSuchAlgorithmException;
import java.util.ArrayList;
import java.util.HexFormat;
import java.util.List;
import java.util.Optional;

/**
 * Builds the compaction summary model context. The preferred shape reuses the
 * last routed request's prefix verbatim (system prompt, visible tool schemas,
 * history) and moves the summary instruction into a trailing user message, so
 * the provider cache prefix warmed by that request stays usable. When no
 * decodable routed prefix exists, or the reused prefix plus the source facts
 * would exceed the budget, the summary request falls back to the standalone
 * shape; correctness never depends on cache reuse.
 */
@Component
public final class CompactionSummaryContextFactory {
    static final String SYSTEM_INSTRUCTION = """
            你正在为 Iris 生成可持久化的 Context Frame。
            输入只包含上一条 Frame 水位线到新水位线之间的规范事实，不包含更早摘要。

            输出一份只概括这一段增量事实的中文上下文摘要，只输出摘要正文。
            必须保留：用户目标与约束、已经确认的决定、仍未解决的问题、重要实体和
            标识、工具产生的客观证据、文件或外部状态变化及其结果、失败与
            outcome_unknown。不得把推测写成事实，不得声称未发生的动作已经完成。
            对后续仍有价值的 task_、artifact://、tool-result://、execution_id、
            checkpoint_ 和 Evidence 引用必须原样保留，不能只改写成无法回溯的描述。
            删除寒暄、重复表述和不影响后续工作的过程噪声。
            """;
    static final int MAX_INPUT_TOKENS = 120_000;
    static final int RESERVED_OUTPUT_TOKENS = 8_192;
    static final String PROMPT_DEFINITION_ID = "iris.pipeline.compaction";
    static final int PROMPT_VERSION = 2;

    private final ObjectMapper objectMapper;
    private final ModelTokenEstimator tokens;
    private final ModelPromptPrefixService promptPrefixes;

    public CompactionSummaryContextFactory(
            ObjectMapper objectMapper,
            ModelTokenEstimator tokens,
            ModelPromptPrefixService promptPrefixes
    ) {
        this.objectMapper = objectMapper;
        this.tokens = tokens;
        this.promptPrefixes = promptPrefixes;
    }

    public SummaryContext build(
            CompactionRow row,
            Optional<RoutedRequestPrefix> routedPrefix
    ) {
        if (routedPrefix.isPresent()) {
            SummaryContext reused = tryPrefixReuse(row, routedPrefix.get());
            if (reused != null) {
                return reused;
            }
        }
        return standalone(row);
    }

    private SummaryContext tryPrefixReuse(
            CompactionRow row,
            RoutedRequestPrefix prefix
    ) {
        String directive = SYSTEM_INSTRUCTION + "\n\n" + row.sourcePayloadJson();
        int estimated = prefix.estimatedInputTokens()
                + tokens.estimateText(directive);
        if (estimated > MAX_INPUT_TOKENS - RESERVED_OUTPUT_TOKENS) {
            return null;
        }
        List<ModelInputItem> items = new ArrayList<>(prefix.items());
        items.add(new ModelInputItem.UserText(
                row.sourceSnapshotId(),
                directive
        ));
        ObjectNode payload = objectMapper.createObjectNode();
        payload.put("systemInstruction", prefix.systemInstruction());
        payload.put("sourceSnapshotId", row.sourceSnapshotId());
        payload.put("sourceContentHash", row.sourceContentHash());
        payload.put("reusedPrefixContextHash", prefix.contextHash());
        payload.set("items", objectMapper.valueToTree(items));
        payload.put("capabilityLeaseHash", prefix.capabilityLeaseHash());
        payload.put("estimatedInputTokens", estimated);
        String payloadJson = write(payload);
        return new SummaryContext(
                new ModelContext(
                        prefix.systemInstruction(),
                        items,
                        prefix.tools(),
                        prefix.promptPrefix(),
                        hash(payloadJson),
                        prefix.capabilityLeaseHash(),
                        estimated,
                        MAX_INPUT_TOKENS,
                        RESERVED_OUTPUT_TOKENS,
                        0
                ),
                payloadJson
        );
    }

    private SummaryContext standalone(CompactionRow row) {
        List<ModelInputItem> items = List.of(new ModelInputItem.UserText(
                row.sourceSnapshotId(),
                row.sourcePayloadJson()
        ));
        int estimated = tokens.estimateText(SYSTEM_INSTRUCTION)
                + row.estimatedTokens();
        if (estimated > MAX_INPUT_TOKENS - RESERVED_OUTPUT_TOKENS) {
            throw new PromptTooLargeException(
                    "Compaction source exceeds the model context budget"
            );
        }
        String leaseHash = hash("[]");
        ObjectNode payload = objectMapper.createObjectNode();
        payload.put("systemInstruction", SYSTEM_INSTRUCTION);
        payload.put("sourceSnapshotId", row.sourceSnapshotId());
        payload.put("sourceContentHash", row.sourceContentHash());
        payload.set("items", objectMapper.valueToTree(items));
        payload.put("capabilityLeaseHash", leaseHash);
        payload.put("estimatedInputTokens", estimated);
        String payloadJson = write(payload);
        ModelPromptPrefix promptPrefix = promptPrefixes.capture(
                PROMPT_DEFINITION_ID,
                PROMPT_VERSION,
                SYSTEM_INSTRUCTION,
                List.of()
        );
        return new SummaryContext(
                new ModelContext(
                        SYSTEM_INSTRUCTION,
                        items,
                        List.of(),
                        promptPrefix,
                        hash(payloadJson),
                        leaseHash,
                        estimated,
                        MAX_INPUT_TOKENS,
                        RESERVED_OUTPUT_TOKENS,
                        0
                ),
                payloadJson
        );
    }

    private String hash(String value) {
        try {
            return HexFormat.of().formatHex(
                    MessageDigest.getInstance("SHA-256").digest(
                            value.getBytes(StandardCharsets.UTF_8)
                    )
            );
        } catch (NoSuchAlgorithmException exception) {
            throw new IllegalStateException("SHA-256 unavailable", exception);
        }
    }

    private String write(Object value) {
        try {
            return objectMapper.writeValueAsString(value);
        } catch (JsonProcessingException exception) {
            throw new IllegalStateException(
                    "Cannot serialize compaction model context",
                    exception
            );
        }
    }

    public record SummaryContext(
            ModelContext context,
            String payloadJson
    ) {
    }
}
