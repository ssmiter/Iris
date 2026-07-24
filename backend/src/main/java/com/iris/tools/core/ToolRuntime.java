package com.iris.tools.core;

import com.fasterxml.jackson.core.JsonProcessingException;
import com.fasterxml.jackson.core.type.TypeReference;
import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.node.ObjectNode;
import com.iris.tools.core.PreparedOperation.ResourceClaim;
import com.iris.tools.core.ToolExecutionViews.ApprovalDecision;
import com.iris.tools.core.ToolExecutionViews.Invocation;
import com.iris.tools.core.ToolExecutionViews.RuntimeResult;
import com.iris.tools.core.ToolManifest.SideEffect;
import com.iris.tools.core.ToolRegistry.ToolBinding;
import org.springframework.stereotype.Service;
import org.springframework.transaction.support.TransactionTemplate;

import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.security.NoSuchAlgorithmException;
import java.time.Clock;
import java.time.Duration;
import java.time.Instant;
import java.util.HexFormat;
import java.util.List;
import java.util.UUID;
import java.util.concurrent.locks.ReentrantLock;

/**
 * 所有 Tool invocation 的唯一入口。写能力从不在 invoke 阶段直接执行。
 */
@Service
public class ToolRuntime {
    private static final Duration DEFAULT_SNAPSHOT_TTL = Duration.ofMinutes(5);
    private static final int LOCK_COUNT = 64;

    private final ToolRegistry registry;
    private final ToolInputValidator validator;
    private final ToolRuntimeRepository repository;
    private final TransactionTemplate transactions;
    private final ObjectMapper objectMapper;
    private final Clock clock;
    private final ReentrantLock[] locks;

    public ToolRuntime(
            ToolRegistry registry,
            ToolInputValidator validator,
            ToolRuntimeRepository repository,
            TransactionTemplate transactions,
            ObjectMapper objectMapper
    ) {
        this.registry = registry;
        this.validator = validator;
        this.repository = repository;
        this.transactions = transactions;
        this.objectMapper = objectMapper;
        this.clock = Clock.systemUTC();
        this.locks = new ReentrantLock[LOCK_COUNT];
        for (int index = 0; index < LOCK_COUNT; index++) {
            locks[index] = new ReentrantLock();
        }
    }

    public RuntimeResult invoke(
            Invocation invocation,
            JsonNode input,
            ToolContext context
    ) {
        requireInvocation(invocation, context);
        return withLock(context.conversationId() + ":" + invocation.toolCallId(), () -> {
            ToolBinding binding = registry.find(invocation.toolName())
                    .orElseThrow(() -> new ToolRuntimeException(
                            "tool_not_found",
                            "找不到工具 " + invocation.toolName()
                                    + "；请先通过能力目录发现精确定义"
                    ));
            String inputHash = hash(write(input));
            RuntimeResult existing = repository.findByToolCall(
                    context.conversationId(),
                    invocation.toolCallId()
            ).orElse(null);
            if (existing != null) {
                return requireSameInvocation(existing, binding, inputHash);
            }

            validator.validate(binding.manifest().inputSchema(), input);
            String executionId = id("execution");
            Instant now = clock.instant();
            transactions.executeWithoutResult(status -> repository.insertClaim(
                    executionId,
                    invocation,
                    context,
                    binding,
                    inputHash,
                    now
            ));

            PreparedOperation prepared;
            try {
                prepared = binding.tool().prepare(input.deepCopy(), context);
                validatePrepared(binding, prepared);
            } catch (Exception exception) {
                completeFailure(
                        executionId,
                        ToolOutcome.Kind.FAILED,
                        "prepare_failed",
                        safeMessage(exception),
                        List.of()
                );
                return result(executionId);
            }

            Instant expiresAt = prepared.expiresAt() == null
                    ? now.plus(DEFAULT_SNAPSHOT_TTL)
                    : prepared.expiresAt();
            if (!expiresAt.isAfter(now)) {
                completeFailure(
                        executionId,
                        ToolOutcome.Kind.FAILED,
                        "snapshot_expired",
                        "工具操作快照在创建时已经过期",
                        List.of()
                );
                return result(executionId);
            }

            String snapshotId = id("snapshot");
            String normalizedInputJson = write(prepared.normalizedInput());
            String resourcesJson = write(prepared.resources());
            String snapshotHash = hash(
                    binding.manifestHash()
                            + normalizedInputJson
                            + prepared.impactStatement()
                            + resourcesJson
                            + expiresAt
            );
            transactions.executeWithoutResult(status -> {
                repository.insertSnapshot(
                        snapshotId,
                        executionId,
                        binding.manifestHash(),
                        normalizedInputJson,
                        prepared.impactStatement(),
                        resourcesJson,
                        snapshotHash,
                        expiresAt,
                        now
                );
                repository.markPrepared(executionId, snapshotId, now);
                if (requiresApproval(binding.manifest())) {
                    repository.insertApproval(
                            id("approval"),
                            executionId,
                            snapshotHash,
                            prepared.impactStatement(),
                            binding.manifest().riskLevel(),
                            expiresAt,
                            now
                    );
                }
            });

            if (requiresApproval(binding.manifest())) {
                return result(executionId);
            }
            return execute(executionId, binding, context);
        });
    }

    public RuntimeResult decideApproval(
            ApprovalDecision decision,
            ToolContext context
    ) {
        requireDecision(decision);
        return withLock(decision.approvalId(), () -> {
            Instant now = clock.instant();
            ToolRuntimeRepository.ApprovalRow approval = repository
                    .findApproval(decision.approvalId())
                    .orElseThrow(() -> new ToolRuntimeException(
                            "approval_not_found",
                            "找不到这条审批请求"
                    ));
            if (!approval.conversationId().equals(context.conversationId())) {
                throw new ToolRuntimeException(
                        "approval_not_in_conversation",
                        "审批请求不属于当前对话"
                );
            }
            if (approval.decisionKey() != null) {
                if (!approval.decisionKey().equals(decision.decisionKey())) {
                    throw new ToolRuntimeException(
                            "approval_already_resolved",
                            "审批已经由另一条决议处理"
                    );
                }
                return resumeResolvedApproval(approval, context);
            }
            if (!approval.expiresAt().isAfter(now)) {
                transactions.executeWithoutResult(status ->
                        repository.markExpired(
                                approval.approvalId(),
                                approval.executionId(),
                                now
                        )
                );
                return result(approval.executionId());
            }

            boolean resolved = transactions.execute(status ->
                    repository.resolveApproval(
                            approval.approvalId(),
                            decision.snapshotHash(),
                            decision.expectedVersion(),
                            decision.decisionKey(),
                            decision.decidedBy(),
                            decision.approved(),
                            now
                    )
            );
            if (!resolved) {
                throw new ToolRuntimeException(
                        "approval_precondition_failed",
                        "审批版本、快照或状态已经变化，请刷新后重试"
                );
            }
            if (!decision.approved()) {
                transactions.executeWithoutResult(status ->
                        repository.markRejected(approval.executionId(), now)
                );
                return result(approval.executionId());
            }
            ToolBinding binding = exactBinding(
                    approval.toolName(),
                    approval.executionId()
            );
            return execute(approval.executionId(), binding, context);
        });
    }

    public RuntimeResult get(
            String conversationId,
            String toolCallId
    ) {
        return repository.findByToolCall(conversationId, toolCallId)
                .orElseThrow(() -> new ToolRuntimeException(
                        "tool_execution_not_found",
                        "找不到这次工具执行"
                ));
    }

    private RuntimeResult resumeResolvedApproval(
            ToolRuntimeRepository.ApprovalRow approval,
            ToolContext context
    ) {
        if ("approved".equals(approval.status())) {
            RuntimeResult current = result(approval.executionId());
            if ("awaiting_approval".equals(current.phase())) {
                return execute(
                        approval.executionId(),
                        exactBinding(
                                approval.toolName(),
                                approval.executionId()
                        ),
                        context
                );
            }
            return current;
        }
        return result(approval.executionId());
    }

    private ToolBinding exactBinding(String toolName, String executionId) {
        ToolBinding binding = registry.find(toolName)
                .orElseThrow(() -> new ToolRuntimeException(
                        "tool_binding_unavailable",
                        "工具绑定当前不可用，历史执行仍保留"
                ));
        ToolRuntimeRepository.SnapshotRow snapshot =
                repository.snapshot(executionId);
        if (!binding.manifestHash().equals(snapshot.manifestHash())) {
            throw new ToolRuntimeException(
                    "tool_binding_changed",
                    "工具定义已变化，不能用新版本执行旧快照"
            );
        }
        return binding;
    }

    private RuntimeResult execute(
            String executionId,
            ToolBinding binding,
            ToolContext context
    ) {
        if (context.cancelled()) {
            completeFailure(
                    executionId,
                    ToolOutcome.Kind.FAILED,
                    "cancelled_before_execution",
                    "工具在改变外部状态前被取消",
                    List.of()
            );
            return result(executionId);
        }
        ToolRuntimeRepository.SnapshotRow snapshot =
                repository.snapshot(executionId);
        Instant now = clock.instant();
        if (!snapshot.expiresAt().isAfter(now)) {
            completeFailure(
                    executionId,
                    ToolOutcome.Kind.FAILED,
                    "snapshot_expired",
                    "操作快照已过期，需要重新 prepare",
                    List.of()
            );
            return result(executionId);
        }
        boolean claimed = transactions.execute(status ->
                repository.markExecuting(executionId, now)
        );
        if (!claimed) {
            return result(executionId);
        }

        CommittedOperation operation = new CommittedOperation(
                executionId,
                snapshot.snapshotId(),
                snapshot.snapshotHash(),
                readTree(snapshot.normalizedInputJson()),
                readResources(snapshot.resourcesJson())
        );
        ToolOutcome outcome;
        try {
            outcome = binding.tool().execute(operation, context);
            if (outcome == null) {
                throw new IllegalStateException("工具返回了空 outcome");
            }
        } catch (Exception exception) {
            boolean writeMayHaveHappened =
                    binding.manifest().sideEffect() != SideEffect.NONE;
            completeFailure(
                    executionId,
                    writeMayHaveHappened
                            ? ToolOutcome.Kind.OUTCOME_UNKNOWN
                            : ToolOutcome.Kind.FAILED,
                    "execution_interrupted",
                    safeMessage(exception),
                    List.of()
            );
            return result(executionId);
        }

        if (outcome.kind() != ToolOutcome.Kind.SUCCEEDED) {
            completeFailure(
                    executionId,
                    outcome.kind(),
                    outcome.errorCode(),
                    outcome.message(),
                    List.of()
            );
            return result(executionId);
        }

        transactions.executeWithoutResult(status ->
                repository.markVerifying(executionId, clock.instant())
        );
        VerificationResult verification;
        try {
            verification = binding.tool().verify(outcome, operation, context);
        } catch (Exception exception) {
            completeFailure(
                    executionId,
                    ToolOutcome.Kind.OUTCOME_UNKNOWN,
                    "verification_failed",
                    safeMessage(exception),
                    List.of()
            );
            return result(executionId);
        }

        String phase;
        ToolOutcome.Kind persistedKind;
        String errorCode = null;
        String message = verification.message();
        if (verification.status() == VerificationResult.Status.CONFIRMED) {
            phase = "succeeded";
            persistedKind = ToolOutcome.Kind.SUCCEEDED;
        } else if (verification.status() == VerificationResult.Status.FAILED
                && binding.manifest().sideEffect() == SideEffect.NONE) {
            phase = "failed";
            persistedKind = ToolOutcome.Kind.FAILED;
            errorCode = "postcondition_failed";
        } else {
            phase = "outcome_unknown";
            persistedKind = ToolOutcome.Kind.OUTCOME_UNKNOWN;
            errorCode = "postcondition_unknown";
        }
        String outputJson = persistedKind == ToolOutcome.Kind.SUCCEEDED
                ? boundedOutput(binding.manifest(), outcome.output())
                : null;
        Instant completedAt = clock.instant();
        String finalErrorCode = errorCode;
        transactions.executeWithoutResult(status -> repository.complete(
                executionId,
                phase,
                persistedKind,
                outputJson,
                finalErrorCode,
                message,
                verification.evidence(),
                completedAt
        ));
        return result(executionId);
    }

    private RuntimeResult requireSameInvocation(
            RuntimeResult existing,
            ToolBinding binding,
            String inputHash
    ) {
        if (!existing.toolName().equals(binding.manifest().name())) {
            throw new ToolRuntimeException(
                    "tool_call_id_reused",
                    "同一 toolCallId 已用于不同工具"
            );
        }
        if (!repository.inputHash(existing.executionId()).equals(inputHash)) {
            throw new ToolRuntimeException(
                    "tool_call_id_reused",
                    "同一 toolCallId 已用于不同输入"
            );
        }
        return existing;
    }

    private void validatePrepared(
            ToolBinding binding,
            PreparedOperation prepared
    ) {
        if (prepared == null || prepared.normalizedInput() == null) {
            throw new ToolRuntimeException(
                    "invalid_operation_snapshot",
                    "工具没有生成规范化输入"
            );
        }
        validator.validate(
                binding.manifest().inputSchema(),
                prepared.normalizedInput()
        );
        if (prepared.impactStatement() == null
                || prepared.impactStatement().isBlank()) {
            throw new ToolRuntimeException(
                    "invalid_operation_snapshot",
                    "工具没有生成可读的影响说明"
            );
        }
        if (requiresApproval(binding.manifest())
                && prepared.resources().isEmpty()) {
            throw new ToolRuntimeException(
                    "invalid_operation_snapshot",
                    "写操作没有声明受影响资源"
            );
        }
        for (ResourceClaim resource : prepared.resources()) {
            if (resource.kind() == null
                    || resource.kind().isBlank()
                    || resource.logicalPath() == null
                    || resource.logicalPath().isBlank()) {
                throw new ToolRuntimeException(
                        "invalid_operation_snapshot",
                        "资源声明不完整"
                );
            }
        }
    }

    private boolean requiresApproval(ToolManifest manifest) {
        return manifest.riskLevel() != RiskLevel.READ_ONLY
                || manifest.sideEffect() != SideEffect.NONE;
    }

    private void completeFailure(
            String executionId,
            ToolOutcome.Kind kind,
            String errorCode,
            String message,
            List<VerificationResult.Evidence> evidence
    ) {
        String phase = kind == ToolOutcome.Kind.OUTCOME_UNKNOWN
                ? "outcome_unknown"
                : "failed";
        transactions.executeWithoutResult(status -> repository.complete(
                executionId,
                phase,
                kind,
                null,
                errorCode,
                message,
                evidence,
                clock.instant()
        ));
    }

    private RuntimeResult result(String executionId) {
        return repository.findByExecutionId(executionId)
                .orElseThrow(() -> new IllegalStateException(
                        "Tool execution disappeared after commit"
                ));
    }

    private String boundedOutput(ToolManifest manifest, JsonNode output) {
        if (output == null) {
            return "null";
        }
        String json = write(output);
        if (json.length() <= manifest.resultCharacterLimit()) {
            return json;
        }
        ObjectNode truncated = objectMapper.createObjectNode();
        truncated.put("truncated", true);
        truncated.put("originalCharacters", json.length());
        truncated.put(
                "preview",
                json.substring(0, manifest.resultCharacterLimit())
        );
        return write(truncated);
    }

    private List<ResourceClaim> readResources(String json) {
        try {
            return objectMapper.readValue(
                    json,
                    new TypeReference<List<ResourceClaim>>() {
                    }
            );
        } catch (JsonProcessingException exception) {
            throw new IllegalStateException(
                    "持久化资源快照不是合法 JSON",
                    exception
            );
        }
    }

    private JsonNode readTree(String json) {
        try {
            return objectMapper.readTree(json);
        } catch (JsonProcessingException exception) {
            throw new IllegalStateException(
                    "持久化输入快照不是合法 JSON",
                    exception
            );
        }
    }

    private String write(Object value) {
        try {
            return objectMapper.writeValueAsString(value);
        } catch (JsonProcessingException exception) {
            throw new ToolRuntimeException(
                    "tool_input_not_serializable",
                    "工具数据无法序列化"
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

    private String safeMessage(Exception exception) {
        String message = exception.getMessage();
        return message == null || message.isBlank()
                ? exception.getClass().getSimpleName()
                : message;
    }

    private void requireInvocation(
            Invocation invocation,
            ToolContext context
    ) {
        if (invocation == null
                || invocation.toolCallId() == null
                || invocation.toolCallId().isBlank()
                || invocation.toolName() == null
                || invocation.toolName().isBlank()) {
            throw new ToolRuntimeException(
                    "invalid_tool_invocation",
                    "toolCallId 与 toolName 不能为空"
            );
        }
        if (context == null
                || context.conversationId() == null
                || context.turnId() == null
                || context.runId() == null
                || context.workspaceRoot() == null) {
            throw new ToolRuntimeException(
                    "invalid_tool_context",
                    "工具运行上下文不完整"
            );
        }
    }

    private void requireDecision(ApprovalDecision decision) {
        if (decision == null
                || decision.approvalId() == null
                || decision.approvalId().isBlank()
                || decision.decisionKey() == null
                || decision.decisionKey().isBlank()
                || decision.snapshotHash() == null
                || decision.snapshotHash().isBlank()
                || decision.decidedBy() == null
                || decision.decidedBy().isBlank()) {
            throw new ToolRuntimeException(
                    "invalid_approval_decision",
                    "审批决议缺少 identity、幂等键、快照或决议人"
            );
        }
    }

    private <T> T withLock(String key, java.util.concurrent.Callable<T> work) {
        ReentrantLock lock = locks[Math.floorMod(key.hashCode(), locks.length)];
        lock.lock();
        try {
            return work.call();
        } catch (ToolRuntimeException exception) {
            throw exception;
        } catch (Exception exception) {
            throw new IllegalStateException("Tool runtime failed", exception);
        } finally {
            lock.unlock();
        }
    }

    private String id(String prefix) {
        return prefix + "_" + UUID.randomUUID().toString().replace("-", "");
    }
}
