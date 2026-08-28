package com.iris.agent.model;

import com.fasterxml.jackson.core.JsonProcessingException;
import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.node.ObjectNode;
import com.iris.agent.model.ModelAttemptRepository.ObservationSource;
import com.iris.agent.model.ModelAttemptRepository.RoundToolCall;
import com.iris.tools.core.ToolContext;
import com.iris.tools.core.ToolErrorRecoveryCatalog;
import com.iris.tools.core.ToolExecutionViews.RuntimeResult;
import com.iris.tools.core.ToolRegistry;
import com.iris.tools.core.ToolRuntimeException;
import com.iris.tools.core.ToolRuntimeRepository;
import org.springframework.stereotype.Service;
import org.springframework.transaction.support.TransactionTemplate;

import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.security.NoSuchAlgorithmException;
import java.time.Clock;
import java.time.Instant;
import java.util.HexFormat;
import java.util.List;
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
    private final ToolResultContextProjector contextProjector;
    private final ToolRuntimeRepository toolExecutions;
    private final ToolRegistry toolRegistry;
    private final Clock clock = Clock.systemUTC();

    public ToolObservationService(
            ModelAttemptRepository repository,
            TransactionTemplate transactions,
            ObjectMapper objectMapper,
            ToolResultContextProjector contextProjector,
            ToolRuntimeRepository toolExecutions,
            ToolRegistry toolRegistry
    ) {
        this.repository = repository;
        this.transactions = transactions;
        this.objectMapper = objectMapper;
        this.contextProjector = contextProjector;
        this.toolExecutions = toolExecutions;
        this.toolRegistry = toolRegistry;
    }

    public ToolObservation capture(
            String toolCallId,
            String executionId
    ) {
        return capture(toolCallId, executionId, false);
    }

    public ToolObservation capture(
            String toolCallId,
            String executionId,
            boolean referenceOnly
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
        if (source.resolvedToolName() != null
                && !source.resolvedToolName().equals(source.toolName())) {
            content.put("resolvedToolName", source.resolvedToolName());
        }
        content.put("status", source.phase());
        content.put("executionId", executionId);
        boolean error = !"succeeded".equals(source.phase());
        content.put("isError", error);
        if (!error && source.outputJson() != null) {
            content.put(
                    "resultRef",
                    "tool-result://" + executionId
            );
            if (referenceOnly) {
                String payloadHash = repository.payloadHash(executionId)
                        .orElse(null);
                // 先挂完整输出，投影器据此生成截断预览，再收敛为引用
                content.set("output", read(source.outputJson()));
                content.set(
                        "output",
                        contextProjector.toReference(
                                content,
                                source.toolName(),
                                source.resolvedToolName(),
                                executionId,
                                payloadHash
                        ).path("output")
                );
            } else {
                content.set("output", read(source.outputJson()));
            }
        } else {
            String errorCode = source.errorCode() == null
                    ? source.phase()
                    : source.errorCode();
            content.put(
                    "errorCode",
                    errorCode
            );
            content.put(
                    "message",
                    source.errorMessage() == null
                            ? defaultMessage(source.phase())
                            : source.errorMessage()
            );
            content.put(
                    "effect",
                    "outcome_unknown".equals(source.phase())
                            ? "may_have_changed"
                            : "none_confirmed"
            );
            if (source.outputJson() != null) {
                content.put(
                        "resultRef",
                        "tool-result://" + executionId
                );
                content.set("details", read(source.outputJson()));
            }
            ToolErrorRecoveryCatalog.Recovery recovery =
                    ToolErrorRecoveryCatalog.recoveryFor(
                            source.phase(),
                            errorCode,
                            source.resolvedToolName()
                    );
            ObjectNode recoveryNode = content.putObject("recovery");
            recoveryNode.put("action", recovery.action());
            recoveryNode.put(
                    "newToolCallRequired",
                    recovery.newToolCallRequired()
            );
            recoveryNode.put("instruction", recovery.instruction());
        }
        var evidence = content.putArray("evidence");
        repository.executionEvidence(executionId).forEach(item -> {
            ObjectNode evidenceItem = evidence.addObject();
            evidenceItem.put(
                    "evidenceRef",
                    "evidence://" + item.evidenceId()
            );
            evidenceItem.put("kind", item.kind());
            if (item.reference() == null) {
                evidenceItem.putNull("reference");
            } else {
                evidenceItem.put("reference", item.reference());
            }
            evidenceItem.put("summary", item.summary());
        });

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

    public ObservationSource observationSource(
            String toolCallId,
            String executionId
    ) {
        return repository.observationSource(toolCallId, executionId)
                .orElseThrow(() -> new ModelProtocolException(
                        "tool_execution_pair_not_found",
                        "找不到 ToolCall 与 ToolExecution 配对"
                ));
    }

    /**
     * 为尚未开始执行的 ToolCall 生成占位 observation。
     * 已处于执行/核验阶段的调用保持原状，由排空流程继续完成。
     */
    public int recordCancelledPendingCalls(
            String conversationId,
            String turnId,
            String runId,
            String roundId,
            Instant now
    ) {
        List<RoundToolCall> calls = repository.roundToolCalls(roundId);
        int recorded = 0;
        for (RoundToolCall call : calls) {
            String executionId = call.executionId();
            if (executionId == null) {
                ToolRegistry.ToolBinding binding = toolRegistry.find(call.toolName())
                        .orElse(null);
                String syntheticId = "execution_" + UUID.randomUUID()
                        .toString()
                        .replace("-", "");
                String inputHash = hash(write(call.arguments()));
                insertSyntheticTerminalExecution(
                        syntheticId,
                        call,
                        conversationId,
                        turnId,
                        runId,
                        roundId,
                        binding,
                        inputHash,
                        "failed",
                        "failed",
                        "run_stopped",
                        "运行已停止，该调用未执行。",
                        now
                );
                capture(call.toolCallId(), syntheticId);
                recorded++;
                continue;
            }
            RuntimeResult existing = toolExecutions.findByExecutionId(executionId)
                    .orElse(null);
            if (existing != null
                    && TERMINAL_PHASES.contains(existing.phase())) {
                capture(call.toolCallId(), executionId);
                recorded++;
            }
        }
        return recorded;
    }

    /**
     * 为注册类错误（tool_not_found、tool_binding_changed 等）合成 failed 终态
     * execution 与 observation。当前调用失败不应阻止同轮其余 ToolCall 继续处理。
     */
    public RuntimeResult recordSyntheticToolFailure(
            RoundToolCall call,
            ToolContext context,
            ToolRuntimeException exception
    ) {
        String syntheticId = "execution_" + UUID.randomUUID()
                .toString()
                .replace("-", "");
        String inputHash = hash(write(call.arguments()));
        ToolRegistry.ToolBinding binding = toolRegistry.find(call.toolName())
                .orElse(null);
        String message = exception.getMessage();
        if (message == null || message.isBlank()) {
            message = exception.code();
        }
        insertSyntheticTerminalExecution(
                syntheticId,
                call,
                context.conversationId(),
                context.turnId(),
                context.runId(),
                context.roundId(),
                binding,
                inputHash,
                "failed",
                "failed",
                exception.code(),
                message,
                clock.instant()
        );
        capture(call.toolCallId(), syntheticId);
        return toolExecutions.findByExecutionId(syntheticId)
                .orElseThrow(() -> new IllegalStateException(
                        "Synthetic execution disappeared after insert: " + syntheticId
                ));
    }

    private void insertSyntheticTerminalExecution(
            String executionId,
            RoundToolCall call,
            String conversationId,
            String turnId,
            String runId,
            String roundId,
            ToolRegistry.ToolBinding binding,
            String inputHash,
            String phase,
            String outcomeKind,
            String errorCode,
            String errorMessage,
            Instant now
    ) {
        if (binding != null) {
            toolExecutions.insertSyntheticTerminalExecution(
                    executionId,
                    call.toolCallId(),
                    conversationId,
                    turnId,
                    runId,
                    roundId,
                    binding,
                    inputHash,
                    phase,
                    outcomeKind,
                    errorCode,
                    errorMessage,
                    now
            );
        } else {
            toolExecutions.insertSyntheticTerminalExecution(
                    executionId,
                    call.toolCallId(),
                    conversationId,
                    turnId,
                    runId,
                    roundId,
                    call.toolName(),
                    inputHash,
                    phase,
                    outcomeKind,
                    errorCode,
                    errorMessage,
                    now
            );
        }
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
