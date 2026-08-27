package com.iris.agent.model;

import com.fasterxml.jackson.core.JsonProcessingException;
import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.node.ObjectNode;
import com.iris.agent.model.ModelAttemptRepository.ObservationSource;
import com.iris.agent.model.ModelAttemptRepository.RoundToolCall;
import com.iris.tools.core.ToolContext;
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
            Recovery recovery = recovery(
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

    private Recovery recovery(
            String phase,
            String errorCode,
            String toolName
    ) {
        if ("outcome_unknown".equals(phase)
                && "browser_action_still_unknown".equals(errorCode)) {
            return new Recovery(
                    "observe_and_reconcile",
                    true,
                    "原动作日志仍无法确认结果；重新观察当前页面并按页面事实核对，不要再次 inspect 或直接重放"
            );
        }
        if ("outcome_unknown".equals(phase)
                && "postcondition_unknown".equals(errorCode)
                && toolName != null
                && toolName.contains("browser")) {
            return new Recovery(
                    "observe_and_reconcile",
                    true,
                    "浏览器动作已执行但证据不足；重新观察当前页面并按页面事实核对，确认未生效前不得重放"
            );
        }
        if ("outcome_unknown".equals(phase)
                && errorCode.startsWith("browser_")) {
            return new Recovery(
                    "inspect_browser_action",
                    true,
                    "用当前 observation 中的 executionId 调用 inspect_browser_action；如果原动作仍未知，再重新观察页面并按当前事实核对，禁止直接重放动作"
            );
        }
        if ("outcome_unknown".equals(phase)) {
            return new Recovery(
                    "inspect_before_retry",
                    true,
                    "先读取目标的当前状态或调用 inspect_workspace_change；确认没有生效后，才能用新的工具调用重试"
            );
        }
        if (errorCode.endsWith("_not_applied")) {
            return new Recovery(
                    "observe_then_retry",
                    true,
                    "动作已确认没有生效；重新读取目标当前状态，根据最新事实调整参数，不要原样复用旧引用"
            );
        }
        if ("rejected".equals(phase)) {
            return new Recovery(
                    "stop",
                    true,
                    "停止这项操作；只有用户重新明确要求时，才发起新的工具调用"
            );
        }
        if ("expired".equals(phase)
                || "snapshot_expired".equals(errorCode)) {
            return new Recovery(
                    "prepare_again",
                    true,
                    "重新读取必要状态，并用新的工具调用重新准备操作"
            );
        }
        if ("capability_not_inspected".equals(errorCode)
                || "capability_definition_changed".equals(errorCode)
                || "pipeline_not_inspected".equals(errorCode)) {
            return new Recovery(
                    "read_definition_then_retry",
                    true,
                    "重新 read_capability，并把新返回的 path、manifestHash 与符合 inputSchema 的 arguments 交给新的 invoke_capability 调用"
            );
        }
        if ("resident_tool_requires_direct_call".equals(errorCode)) {
            return new Recovery(
                    "call_resident_tool_directly",
                    true,
                    "该工具已在 Provider tools 中；使用它自己的名称和 schema 发起新的直接调用"
            );
        }
        if (isCancellation(errorCode)) {
            return new Recovery(
                    "stop",
                    true,
                    "操作已在确认无副作用的边界停止；除非任务仍然需要，否则不要重试"
            );
        }
        if (isInvalidInput(errorCode)) {
            return new Recovery(
                    "correct_input",
                    true,
                    "根据 errorCode 和 message 修正参数，再发起新的工具调用"
            );
        }
        if (isStaleObservation(errorCode)) {
            return new Recovery(
                    "observe_then_retry",
                    true,
                    "目标状态已经变化；先重新读取相关资源，再基于新状态发起工具调用"
            );
        }
        if (errorCode.startsWith("tool_timeout")
                || errorCode.startsWith("process_timeout")) {
            return new Recovery(
                    "retry_if_still_needed",
                    true,
                    "本次执行已确认没有副作用；若任务仍需要，可缩小范围后发起新的工具调用"
            );
        }
        return new Recovery(
                "replan",
                true,
                "结合 errorCode 和 message 调整方案；不要原样重复失败的调用"
        );
    }

    private boolean isCancellation(String errorCode) {
        return "tool_cancelled".equals(errorCode)
                || "cancelled_before_commit".equals(errorCode)
                || "run_stopped".equals(errorCode)
                || "cancelled".equals(errorCode)
                || "process_cancelled".equals(errorCode);
    }

    private boolean isInvalidInput(String errorCode) {
        return errorCode.startsWith("invalid_")
                || errorCode.startsWith("unsafe_")
                || errorCode.startsWith("calculation_")
                || errorCode.startsWith("tool_result_")
                || errorCode.endsWith("_empty")
                || errorCode.endsWith("_too_long")
                || errorCode.endsWith("_too_large")
                || errorCode.contains("_same_path")
                || errorCode.contains("_line_out_of_range")
                || errorCode.contains("_text_not_found")
                || errorCode.contains("_not_unique")
                || errorCode.contains("_empty_match");
    }

    private boolean isStaleObservation(String errorCode) {
        return errorCode.startsWith("operation_snapshot_")
                || errorCode.endsWith("_version_changed")
                || errorCode.endsWith("_definition_changed")
                || errorCode.endsWith("_target_changed")
                || errorCode.endsWith("_destination_exists")
                || errorCode.endsWith("_parent_not_found")
                || errorCode.endsWith("_path_not_found")
                || errorCode.endsWith("_directory_exists");
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

    private record Recovery(
            String action,
            boolean newToolCallRequired,
            String instruction
    ) {
    }
}
