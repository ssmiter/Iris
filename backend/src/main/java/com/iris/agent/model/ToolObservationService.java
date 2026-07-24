package com.iris.agent.model;

import com.fasterxml.jackson.core.JsonProcessingException;
import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.node.ObjectNode;
import com.iris.agent.model.ModelAttemptRepository.ObservationSource;
import org.springframework.stereotype.Service;
import org.springframework.transaction.support.TransactionTemplate;

import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.security.NoSuchAlgorithmException;
import java.time.Clock;
import java.util.HexFormat;
import java.util.Set;
import java.util.UUID;

@Service
public class ToolObservationService {
    private static final Set<String> TERMINAL_PHASES = Set.of(
            "succeeded",
            "failed",
            "outcome_unknown",
            "rejected",
            "expired"
    );

    private final ModelAttemptRepository repository;
    private final TransactionTemplate transactions;
    private final ObjectMapper objectMapper;
    private final Clock clock = Clock.systemUTC();

    public ToolObservationService(
            ModelAttemptRepository repository,
            TransactionTemplate transactions,
            ObjectMapper objectMapper
    ) {
        this.repository = repository;
        this.transactions = transactions;
        this.objectMapper = objectMapper;
    }

    public ToolObservation capture(
            String toolCallId,
            String executionId
    ) {
        ToolObservation existing = repository.findObservation(toolCallId)
                .orElse(null);
        if (existing != null) {
            if (!existing.executionId().equals(executionId)) {
                throw new ModelProtocolException(
                        "tool_observation_execution_mismatch",
                        "ToolCall 已由另一条 execution 形成 observation"
                );
            }
            return existing;
        }

        ObservationSource source = repository.observationSource(
                toolCallId,
                executionId
        ).orElseThrow(() -> new ModelProtocolException(
                "tool_execution_pair_not_found",
                "找不到 ToolCall 与 ToolExecution 配对"
        ));
        if (!source.toolCallId().equals(source.executionToolCallId())) {
            throw new ModelProtocolException(
                    "tool_execution_pair_mismatch",
                    "ToolExecution 不属于该 ToolCall"
            );
        }
        if (!TERMINAL_PHASES.contains(source.phase())) {
            throw new ModelProtocolException(
                    "tool_execution_not_terminal",
                    "ToolExecution 尚未终止，不能形成 observation"
            );
        }

        ObjectNode content = objectMapper.createObjectNode();
        content.put(
                "toolCallId",
                source.providerCallId() == null
                        ? source.toolCallId()
                        : source.providerCallId()
        );
        content.put("toolName", source.toolName());
        content.put("status", source.phase());
        boolean error = !"succeeded".equals(source.phase());
        content.put("isError", error);
        if (!error && source.outputJson() != null) {
            content.set("output", read(source.outputJson()));
        } else {
            content.put(
                    "errorCode",
                    source.errorCode() == null
                            ? source.phase()
                            : source.errorCode()
            );
            content.put(
                    "message",
                    source.errorMessage() == null
                            ? defaultMessage(source.phase())
                            : source.errorMessage()
            );
            if ("outcome_unknown".equals(source.phase())) {
                content.put("retryAllowed", false);
                content.put(
                        "instruction",
                        "结果未知；先核验证据，不得自动重试同一写操作"
                );
            }
        }

        String contentHash = hash(write(content));
        ToolObservation observation = new ToolObservation(
                "observation_" + UUID.randomUUID()
                        .toString().replace("-", ""),
                toolCallId,
                executionId,
                source.outcomeKind() == null
                        ? source.phase()
                        : source.outcomeKind(),
                content,
                contentHash,
                clock.instant()
        );
        transactions.executeWithoutResult(status ->
                repository.linkExecutionAndInsertObservation(observation)
        );
        return observation;
    }

    private String defaultMessage(String phase) {
        return switch (phase) {
            case "rejected" -> "用户拒绝了这次操作";
            case "expired" -> "审批已过期，需要重新 prepare";
            case "outcome_unknown" -> "工具可能已经改变外部状态，但无法确认";
            default -> "工具执行失败";
        };
    }

    private JsonNode read(String json) {
        try {
            return objectMapper.readTree(json);
        } catch (JsonProcessingException exception) {
            throw new IllegalStateException(
                    "ToolExecution output 不是合法 JSON",
                    exception
            );
        }
    }

    private String write(Object value) {
        try {
            return objectMapper.writeValueAsString(value);
        } catch (JsonProcessingException exception) {
            throw new IllegalStateException(
                    "ToolObservation 无法序列化",
                    exception
            );
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
