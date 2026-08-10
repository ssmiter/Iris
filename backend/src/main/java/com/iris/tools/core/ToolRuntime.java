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
import com.iris.tools.core.ToolExecutionViews.UserInputDecision;
import com.iris.tools.core.ToolManifest.SideEffect;
import com.iris.tools.core.ToolManifest.ConcurrencySemantics;
import com.iris.tools.core.ToolOutputPayloadService.PendingPayload;
import com.iris.tools.core.ToolRegistry.ToolBinding;
import com.iris.tools.core.UserInputTool.Option;
import com.iris.tools.core.UserInputTool.UserInputAnswer;
import com.iris.tools.core.UserInputTool.UserInputPrompt;
import org.springframework.beans.factory.annotation.Value;
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
    private final CapabilityAvailabilityService availability;
    private final ToolInputValidator validator;
    private final ToolRuntimeRepository repository;
    private final ToolOutputPayloadService outputPayloads;
    private final TransactionTemplate transactions;
    private final ObjectMapper objectMapper;
    private final Clock clock;
    private final ReentrantLock[] locks;
    private final ApprovalMode approvalMode;

    public ToolRuntime(
            ToolRegistry registry,
            CapabilityAvailabilityService availability,
            ToolInputValidator validator,
            ToolRuntimeRepository repository,
            ToolOutputPayloadService outputPayloads,
            TransactionTemplate transactions,
            ObjectMapper objectMapper,
            @Value("${iris.tools.approval-mode:required}")
            String approvalMode
    ) {
        this.registry = registry;
        this.availability = availability;
        this.validator = validator;
        this.repository = repository;
        this.outputPayloads = outputPayloads;
        this.transactions = transactions;
        this.objectMapper = objectMapper;
        this.clock = Clock.systemUTC();
        this.approvalMode = ApprovalMode.parse(approvalMode);
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
        return invokeAuthorized(invocation, input, context, null);
    }

    /**
     * Executes a binding frozen by trusted host orchestration (for example a
     * Pipeline Definition). It skips model exposure only; every runtime policy,
     * snapshot, approval, commit gate, verification and payload rule remains.
     */
    public RuntimeResult invokeHost(
            Invocation invocation,
            JsonNode input,
            ToolContext context,
            String capabilityPath,
            String manifestHash
    ) {
        if (capabilityPath == null || capabilityPath.isBlank()
                || manifestHash == null || manifestHash.isBlank()) {
            throw new ToolRuntimeException(
                    "invalid_host_tool_binding",
                    "Host invocation must freeze capabilityPath and manifestHash"
            );
        }
        return invokeAuthorized(
                invocation,
                input,
                context,
                new HostBinding(capabilityPath, manifestHash)
        );
    }

    private RuntimeResult invokeAuthorized(
            Invocation invocation,
            JsonNode input,
            ToolContext context,
            HostBinding hostBinding
    ) {
        requireInvocation(invocation, context);
        return withLock(context.conversationId() + ":" + invocation.toolCallId(), () -> {
            ToolBinding visibleBinding = registry.find(invocation.toolName())
                    .orElseThrow(() -> new ToolRuntimeException(
                            "tool_not_found",
                            "找不到工具 " + invocation.toolName()
                                    + "；请先通过能力目录发现精确定义"
                    ));
            if (hostBinding == null) {
                requireExactModelExposure(invocation, visibleBinding);
            } else {
                requireExactHostBinding(visibleBinding, hostBinding);
            }
            String inputHash = hash(write(input));
            RuntimeResult existing = repository.findByToolCall(
                    context.conversationId(),
                    invocation.toolCallId()
            ).orElse(null);
            if (existing != null) {
                return requireSameInvocation(existing, inputHash);
            }

            try {
                validator.validate(
                        visibleBinding.manifest().inputSchema(),
                        input
                );
            } catch (Exception exception) {
                return rejectBeforeResolution(
                        invocation,
                        inputHash,
                        context,
                        visibleBinding,
                        errorCode(exception, "invalid_tool_input"),
                        safeMessage(exception)
                );
            }

            ResolvedInvocation resolved;
            try {
                resolved = resolveInvocation(
                        visibleBinding,
                        input,
                        context
                );
            } catch (Exception exception) {
                return rejectBeforeResolution(
                        invocation,
                        inputHash,
                        context,
                        visibleBinding,
                        errorCode(
                                exception,
                                "tool_resolution_failed"
                        ),
                        safeMessage(exception)
                );
            }
            ToolBinding binding = resolved.binding();
            JsonNode effectiveInput = resolved.input();
            ToolCallResolver.ResolvedToolCall resolution =
                    resolved.resolution();

            ToolContext boundedContext = withDeadline(
                    context,
                    binding.manifest()
            );
            String executionId = id("execution");
            Instant now = clock.instant();
            ToolBinding effectiveBinding = binding;
            ToolCallResolver.ResolvedToolCall effectiveResolution = resolution;
            JsonNode operationInput = effectiveInput;
            transactions.executeWithoutResult(status -> {
                repository.insertClaim(
                        executionId,
                        invocation,
                        context,
                        effectiveBinding,
                        inputHash,
                        now
                );
                if (effectiveResolution != null) {
                    String argumentsJson = write(operationInput);
                    repository.insertResolution(
                            invocation.toolCallId(),
                            visibleBinding.manifest().name(),
                            effectiveResolution,
                            argumentsJson,
                            hash(argumentsJson),
                            now
                    );
                }
            });
            if (resolution != null) {
                try {
                    validator.validate(
                            binding.manifest().inputSchema(),
                            effectiveInput
                    );
                } catch (Exception exception) {
                    completeFailure(
                            executionId,
                            ToolOutcome.Kind.FAILED,
                            errorCode(exception, "invalid_tool_input"),
                            safeMessage(exception),
                            List.of()
                    );
                    return result(executionId);
                }
            }
            if (!boundedContext.externalWritesAllowed()
                    && binding.manifest().sideEffect() != SideEffect.NONE) {
                completeFailure(
                        executionId,
                        ToolOutcome.Kind.FAILED,
                        "agent_work_mode_read_only",
                        "这个隔离子任务以 observe 模式运行，不能改变工作区、Iris 控制状态或外部系统",
                        List.of()
                );
                return result(executionId);
            }
            CapabilityAvailability currentAvailability =
                    availability.current(binding);
            if (!currentAvailability.executable()) {
                completeFailure(
                        executionId,
                        ToolOutcome.Kind.FAILED,
                        "capability_unavailable",
                        "能力 " + binding.manifest().name()
                                + " 当前不可用："
                                + currentAvailability.reason(),
                        List.of()
                );
                return result(executionId);
            }
            if (boundedContext.cancelled()) {
                completeCancellation(
                        executionId,
                        boundedContext,
                        "prepare"
                );
                return result(executionId);
            }

            PreparedOperation prepared;
            try {
                prepared = binding.tool().prepare(
                        effectiveInput.deepCopy(),
                        boundedContext
                );
                validatePrepared(binding, prepared);
            } catch (Exception exception) {
                boolean timedOut = boundedContext.deadlineExceeded();
                completeFailure(
                        executionId,
                        ToolOutcome.Kind.FAILED,
                        timedOut
                                ? "tool_timeout_during_prepare"
                                : errorCode(exception, "prepare_failed"),
                        timedOut
                                ? "工具准备阶段超过声明的运行时间，尚未改变外部状态"
                                : safeMessage(exception),
                        List.of()
                );
                return result(executionId);
            }
            if (boundedContext.cancelled()) {
                completeCancellation(
                        executionId,
                        boundedContext,
                        "prepare"
                );
                return result(executionId);
            }

            UserInputPrompt inputPrompt = null;
            if (binding.tool() instanceof UserInputTool userInputTool) {
                try {
                    inputPrompt = userInputTool.prompt(
                            prepared,
                            boundedContext
                    );
                    validateUserInputPrompt(binding, inputPrompt);
                } catch (Exception exception) {
                    completeFailure(
                            executionId,
                            ToolOutcome.Kind.FAILED,
                            errorCode(exception, "invalid_user_input_prompt"),
                            safeMessage(exception),
                            List.of()
                    );
                    return result(executionId);
                }
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
                    effectiveBinding.manifestHash()
                            + normalizedInputJson
                            + prepared.impactStatement()
                            + resourcesJson
                            + expiresAt
            );
            UserInputPrompt effectiveInputPrompt = inputPrompt;
            transactions.executeWithoutResult(status -> {
                repository.insertSnapshot(
                        snapshotId,
                        executionId,
                        effectiveBinding.manifestHash(),
                        normalizedInputJson,
                        prepared.impactStatement(),
                        resourcesJson,
                        snapshotHash,
                        expiresAt,
                        now
                );
                repository.markPrepared(executionId, snapshotId, now);
                if (requiresApproval(effectiveBinding.manifest())) {
                    repository.insertApproval(
                            id("approval"),
                            executionId,
                            snapshotHash,
                            prepared.impactStatement(),
                            effectiveBinding.manifest().riskLevel(),
                            expiresAt,
                            now
                    );
                } else if (effectiveInputPrompt != null) {
                    repository.insertUserInputRequest(
                            id("input_request"),
                            executionId,
                            effectiveInputPrompt.question(),
                            write(effectiveInputPrompt.options()),
                            effectiveInputPrompt.recommendedOptionId(),
                            expiresAt,
                            now
                    );
                }
            });

            if (requiresApproval(binding.manifest())
                    || inputPrompt != null) {
                return result(executionId);
            }
            return execute(executionId, binding, boundedContext);
        });
    }

    private void requireExactHostBinding(
            ToolBinding binding,
            HostBinding expected
    ) {
        if (!binding.capabilityPath().equals(expected.capabilityPath())
                || !binding.manifestHash().equals(expected.manifestHash())) {
            throw new ToolRuntimeException(
                    "host_tool_binding_changed",
                    "The Tool binding frozen by the host definition has changed"
            );
        }
        if (binding.tool() instanceof ToolCallResolver) {
            throw new ToolRuntimeException(
                    "host_proxy_tool_not_allowed",
                    "Host orchestration must freeze the final Tool, not a resolver"
            );
        }
    }

    private record HostBinding(String capabilityPath, String manifestHash) {
    }

    /**
     * Resolves only enough immutable Definition metadata for host scheduling.
     * Any uncertainty remains serial; invoke() performs the authoritative
     * resolution and all policy checks again.
     */
    public ConcurrencySemantics schedulingConcurrency(
            Invocation invocation,
            JsonNode input,
            ToolContext context
    ) {
        try {
            requireInvocation(invocation, context);
            ToolBinding visibleBinding = registry.find(invocation.toolName())
                    .orElseThrow();
            requireExactModelExposure(invocation, visibleBinding);
            validator.validate(
                    visibleBinding.manifest().inputSchema(),
                    input
            );
            ResolvedInvocation resolved = resolveInvocation(
                    visibleBinding,
                    input,
                    context
            );
            validator.validate(
                    resolved.binding().manifest().inputSchema(),
                    resolved.input()
            );
            return resolved.binding().manifest().concurrency();
        } catch (Exception ignored) {
            return ConcurrencySemantics.SERIAL;
        }
    }

    private ResolvedInvocation resolveInvocation(
            ToolBinding visibleBinding,
            JsonNode input,
            ToolContext context
    ) {
        if (!(visibleBinding.tool() instanceof ToolCallResolver resolver)) {
            return new ResolvedInvocation(
                    visibleBinding,
                    input,
                    null
            );
        }
        ToolCallResolver.ResolvedToolCall resolution = resolver.resolve(
                input.deepCopy(),
                context
        );
        ToolBinding target = registry.find(resolution.targetToolName())
                .orElseThrow(() -> new ToolRuntimeException(
                        "resolved_tool_not_found",
                        "解析后的真实工具不存在"
                ));
        if (!target.capabilityPath().equals(
                resolution.targetCapabilityPath()
        ) || !target.manifestHash().equals(
                resolution.targetManifestHash()
        )) {
            throw new ToolRuntimeException(
                    "resolved_tool_binding_changed",
                    "解析后的真实工具定义已经变化"
            );
        }
        return new ResolvedInvocation(
                target,
                resolution.arguments(),
                resolution
        );
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
            return execute(
                    approval.executionId(),
                    binding,
                    withDeadline(context, binding.manifest())
            );
        });
    }

    public RuntimeResult decideUserInput(
            UserInputDecision decision,
            ToolContext context
    ) {
        requireUserInputDecision(decision);
        return withLock(decision.inputRequestId(), () -> {
            Instant now = clock.instant();
            ToolRuntimeRepository.UserInputRow request = repository
                    .findUserInput(decision.inputRequestId())
                    .orElseThrow(() -> new ToolRuntimeException(
                            "user_input_not_found",
                            "找不到这条用户输入请求"
                    ));
            if (!request.conversationId().equals(context.conversationId())) {
                throw new ToolRuntimeException(
                        "user_input_not_in_conversation",
                        "用户输入请求不属于当前对话"
                );
            }
            if (request.decisionKey() != null) {
                if (!request.decisionKey().equals(decision.decisionKey())) {
                    throw new ToolRuntimeException(
                            "user_input_already_resolved",
                            "这条问题已经由另一条响应处理"
                    );
                }
                return result(request.executionId());
            }
            if (!request.expiresAt().isAfter(now)) {
                transactions.executeWithoutResult(status ->
                        repository.markUserInputExpired(
                                request.inputRequestId(),
                                request.executionId(),
                                now
                        )
                );
                return result(request.executionId());
            }

            ToolBinding binding = exactBinding(
                    request.toolName(),
                    request.executionId()
            );
            if (!(binding.tool() instanceof UserInputTool userInputTool)) {
                throw new ToolRuntimeException(
                        "user_input_binding_changed",
                        "当前工具不再支持用户输入恢复"
                );
            }
            ToolRuntimeRepository.SnapshotRow snapshot = repository.snapshot(
                    request.executionId()
            );
            if (!snapshot.expiresAt().isAfter(now)) {
                transactions.executeWithoutResult(status ->
                        repository.markUserInputExpired(
                                request.inputRequestId(),
                                request.executionId(),
                                now
                        )
                );
                return result(request.executionId());
            }
            ResolvedUserAnswer answer = resolveUserAnswer(
                    request,
                    decision.answer()
            );
            CommittedOperation operation = new CommittedOperation(
                    request.executionId(),
                    snapshot.snapshotId(),
                    snapshot.snapshotHash(),
                    readTree(snapshot.normalizedInputJson()),
                    readResources(snapshot.resourcesJson())
            );

            ToolOutcome outcome;
            VerificationResult verification;
            try {
                outcome = userInputTool.resolve(
                        operation,
                        new UserInputAnswer(
                                request.inputRequestId(),
                                answer.optionId(),
                                answer.value()
                        ),
                        context
                );
                if (outcome == null) {
                    throw new IllegalStateException(
                            "用户输入工具返回了空 outcome"
                    );
                }
                verification = outcome.kind() == ToolOutcome.Kind.SUCCEEDED
                        ? userInputTool.verify(outcome, operation, context)
                        : new VerificationResult(
                                VerificationResult.Status.FAILED,
                                List.of(),
                                outcome.message()
                        );
            } catch (Exception exception) {
                throw new ToolRuntimeException(
                        errorCode(exception, "user_input_resolution_failed"),
                        safeMessage(exception)
                );
            }
            return completeUserInput(
                    decision,
                    request,
                    binding,
                    answer,
                    outcome,
                    verification,
                    now
            );
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

    public boolean hasCommittedActivity(String runId) {
        return repository.hasCommittedActivity(runId);
    }

    public int cancelBeforeExecution(String runId) {
        Integer cancelled = transactions.execute(status ->
                repository.cancelBeforeExecution(runId, clock.instant())
        );
        return cancelled == null ? 0 : cancelled;
    }

    private RuntimeResult resumeResolvedApproval(
            ToolRuntimeRepository.ApprovalRow approval,
            ToolContext context
    ) {
        if ("approved".equals(approval.status())) {
            RuntimeResult current = result(approval.executionId());
            if ("awaiting_approval".equals(current.phase())) {
                ToolBinding binding = exactBinding(
                        approval.toolName(),
                        approval.executionId()
                );
                return execute(
                        approval.executionId(),
                        binding,
                        withDeadline(context, binding.manifest())
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
            completeCancellation(executionId, context, "execution");
            return result(executionId);
        }
        CapabilityAvailability currentAvailability =
                availability.current(binding);
        if (!currentAvailability.executable()) {
            completeFailure(
                    executionId,
                    ToolOutcome.Kind.FAILED,
                    "capability_unavailable",
                    "能力 " + binding.manifest().name()
                            + " 当前不可用："
                            + currentAvailability.reason(),
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
        CommittedOperation operation = new CommittedOperation(
                executionId,
                snapshot.snapshotId(),
                snapshot.snapshotHash(),
                readTree(snapshot.normalizedInputJson()),
                readResources(snapshot.resourcesJson())
        );
        if (binding.manifest().sideEffect() != SideEffect.NONE
                && !passesCommitGate(
                executionId,
                binding,
                operation,
                context
        )) {
            return result(executionId);
        }
        if (context.cancelled()) {
            completeCancellation(executionId, context, "execution");
            return result(executionId);
        }
        if (!snapshot.expiresAt().isAfter(clock.instant())) {
            completeFailure(
                    executionId,
                    ToolOutcome.Kind.FAILED,
                    "snapshot_expired",
                    "操作快照在提交前核对期间过期；Iris 尚未改变外部状态",
                    List.of()
            );
            return result(executionId);
        }
        boolean claimed = transactions.execute(status ->
                repository.markExecuting(executionId, clock.instant())
        );
        if (!claimed) {
            return result(executionId);
        }
        ToolOutcome outcome;
        try {
            outcome = binding.tool().execute(operation, context);
            if (outcome == null) {
                throw new IllegalStateException("工具返回了空 outcome");
            }
        } catch (Exception exception) {
            boolean writeMayHaveHappened =
                    binding.manifest().sideEffect() != SideEffect.NONE
                            && !noOperationEffect(exception);
            boolean timedOutWithoutEffect = context.deadlineExceeded()
                    && !writeMayHaveHappened;
            completeFailure(
                    executionId,
                    writeMayHaveHappened
                            ? ToolOutcome.Kind.OUTCOME_UNKNOWN
                            : ToolOutcome.Kind.FAILED,
                    timedOutWithoutEffect
                            ? "tool_timeout"
                            : errorCode(exception, "execution_interrupted"),
                    timedOutWithoutEffect
                            ? "工具超过声明的运行时间，已在提交边界前停止"
                            : safeMessage(exception),
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
            boolean timedOut = context.deadlineExceeded();
            completeFailure(
                    executionId,
                    ToolOutcome.Kind.OUTCOME_UNKNOWN,
                    timedOut
                            ? "tool_timeout_during_verification"
                            : errorCode(exception, "verification_failed"),
                    timedOut
                            ? "工具验证阶段超过声明的运行时间，外部结果需要核对"
                            : safeMessage(exception),
                    List.of()
            );
            return result(executionId);
        }

        String phase;
        ToolOutcome.Kind persistedKind;
        String errorCode = null;
        String message = verification.message();
        if ((message == null || message.isBlank())
                && !verification.evidence().isEmpty()) {
            message = verification.evidence().getFirst().summary();
        }
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
        String canonicalOutputJson = persistedKind == ToolOutcome.Kind.SUCCEEDED
                ? write(outcome.output())
                : null;
        PendingPayload pendingPayload = null;
        if (canonicalOutputJson != null) {
            try {
                pendingPayload = outputPayloads.writeJson(canonicalOutputJson);
            } catch (Exception exception) {
                completeFailure(
                        executionId,
                        binding.manifest().sideEffect() == SideEffect.NONE
                                ? ToolOutcome.Kind.FAILED
                                : ToolOutcome.Kind.OUTCOME_UNKNOWN,
                        "tool_output_persistence_failed",
                        "工具结果无法持久化；Iris 没有把不完整历史宣布为成功",
                        verification.evidence()
                );
                return result(executionId);
            }
        }
        String outputJson = canonicalOutputJson == null
                ? null
                : boundedOutput(
                        binding.manifest(),
                        canonicalOutputJson,
                        executionId
                );
        Instant completedAt = clock.instant();
        String finalErrorCode = errorCode;
        String finalMessage = message;
        PendingPayload finalPayload = pendingPayload;
        transactions.executeWithoutResult(status -> {
            if (finalPayload != null) {
                outputPayloads.attach(
                        executionId,
                        finalPayload,
                        completedAt
                );
            }
            repository.complete(
                    executionId,
                    phase,
                    persistedKind,
                    outputJson,
                    finalErrorCode,
                    finalMessage,
                    verification.evidence(),
                    completedAt
            );
        });
        return result(executionId);
    }

    private RuntimeResult completeUserInput(
            UserInputDecision decision,
            ToolRuntimeRepository.UserInputRow request,
            ToolBinding binding,
            ResolvedUserAnswer answer,
            ToolOutcome outcome,
            VerificationResult verification,
            Instant now
    ) {
        String phase;
        ToolOutcome.Kind persistedKind;
        String failureCode = null;
        String message = verification.message();
        if (outcome.kind() != ToolOutcome.Kind.SUCCEEDED) {
            phase = outcome.kind() == ToolOutcome.Kind.OUTCOME_UNKNOWN
                    ? "outcome_unknown"
                    : "failed";
            persistedKind = outcome.kind();
            failureCode = outcome.errorCode();
            message = outcome.message();
        } else if (verification.status()
                == VerificationResult.Status.CONFIRMED) {
            phase = "succeeded";
            persistedKind = ToolOutcome.Kind.SUCCEEDED;
        } else {
            phase = "failed";
            persistedKind = ToolOutcome.Kind.FAILED;
            failureCode = "user_input_postcondition_failed";
        }
        if ((message == null || message.isBlank())
                && !verification.evidence().isEmpty()) {
            message = verification.evidence().getFirst().summary();
        }

        String canonicalOutput = persistedKind == ToolOutcome.Kind.SUCCEEDED
                ? write(outcome.output())
                : null;
        PendingPayload pendingPayload = null;
        if (canonicalOutput != null) {
            try {
                pendingPayload = outputPayloads.writeJson(canonicalOutput);
            } catch (Exception exception) {
                throw new ToolRuntimeException(
                        "tool_output_persistence_failed",
                        "用户响应结果无法持久化，问题仍保持待回答"
                );
            }
        }
        String bounded = canonicalOutput == null
                ? null
                : boundedOutput(
                        binding.manifest(),
                        canonicalOutput,
                        request.executionId()
                );
        String finalFailureCode = failureCode;
        String finalMessage = message;
        PendingPayload finalPayload = pendingPayload;
        Boolean completed = transactions.execute(status -> {
            boolean resolved = repository.resolveUserInput(
                    request.inputRequestId(),
                    decision.expectedVersion(),
                    decision.decisionKey(),
                    answer.optionId(),
                    answer.value(),
                    now
            );
            if (!resolved) {
                status.setRollbackOnly();
                return false;
            }
            if (finalPayload != null) {
                outputPayloads.attach(
                        request.executionId(),
                        finalPayload,
                        now
                );
            }
            repository.complete(
                    request.executionId(),
                    phase,
                    persistedKind,
                    bounded,
                    finalFailureCode,
                    finalMessage,
                    verification.evidence(),
                    now
            );
            return true;
        });
        if (!Boolean.TRUE.equals(completed)) {
            throw new ToolRuntimeException(
                    "user_input_precondition_failed",
                    "问题版本或状态已经变化，请刷新后重试"
            );
        }
        return result(request.executionId());
    }

    private ResolvedUserAnswer resolveUserAnswer(
            ToolRuntimeRepository.UserInputRow request,
            String rawAnswer
    ) {
        String answer = rawAnswer == null ? "" : rawAnswer.trim();
        if (answer.isBlank() || answer.length() > 2_000) {
            throw new ToolRuntimeException(
                    "invalid_user_input_answer",
                    "回答必须是 1 到 2000 个字符"
            );
        }
        List<Option> options;
        try {
            options = objectMapper.readValue(
                    request.optionsJson(),
                    new TypeReference<List<Option>>() {
                    }
            );
        } catch (JsonProcessingException exception) {
            throw new IllegalStateException(
                    "持久化的用户选项不是合法 JSON",
                    exception
            );
        }
        for (Option option : options) {
            if (option.id().equals(answer)) {
                return new ResolvedUserAnswer(
                        option.id(),
                        option.label()
                );
            }
        }
        return new ResolvedUserAnswer(null, answer);
    }

    private boolean passesCommitGate(
            String executionId,
            ToolBinding binding,
            CommittedOperation committed,
            ToolContext context
    ) {
        try {
            PreparedOperation refreshed = binding.tool().prepare(
                    committed.normalizedInput().deepCopy(),
                    context
            );
            validatePrepared(binding, refreshed);
            if (!refreshed.normalizedInput().equals(
                    committed.normalizedInput()
            )) {
                throw new ToolRuntimeException(
                        "operation_snapshot_input_changed",
                        "操作的规范化输入已经变化；Iris 尚未写入，请重新发起"
                );
            }
            if (!refreshed.resources().equals(committed.resources())) {
                throw new ToolRuntimeException(
                        "operation_snapshot_resources_changed",
                        "目标资源在准备后发生变化；Iris 尚未写入，请基于当前状态重新发起"
                );
            }
            return true;
        } catch (Exception exception) {
            boolean timedOut = context.deadlineExceeded();
            completeFailure(
                    executionId,
                    ToolOutcome.Kind.FAILED,
                    timedOut
                            ? "tool_timeout_during_commit_gate"
                            : errorCode(exception, "commit_gate_failed"),
                    timedOut
                            ? "提交前核对超过声明的运行时间，尚未改变外部状态"
                            : safeMessage(exception),
                    List.of()
            );
            return false;
        }
    }

    private RuntimeResult requireSameInvocation(
            RuntimeResult existing,
            String inputHash
    ) {
        if (!repository.inputHash(existing.executionId()).equals(inputHash)) {
            throw new ToolRuntimeException(
                    "tool_call_id_reused",
                    "同一 toolCallId 已用于不同输入"
            );
        }
        return existing;
    }

    private RuntimeResult rejectBeforeResolution(
            Invocation invocation,
            String inputHash,
            ToolContext context,
            ToolBinding visibleBinding,
            String errorCode,
            String message
    ) {
        String executionId = id("execution");
        Instant now = clock.instant();
        transactions.executeWithoutResult(status -> repository.insertClaim(
                executionId,
                invocation,
                context,
                visibleBinding,
                inputHash,
                now
        ));
        completeFailure(
                executionId,
                ToolOutcome.Kind.FAILED,
                errorCode,
                message,
                List.of()
        );
        return result(executionId);
    }

    private void requireExactModelExposure(
            Invocation invocation,
            ToolBinding binding
    ) {
        repository.modelExposure(invocation.toolCallId())
                .ifPresent(exposure -> {
                    if (!exposure.toolName().equals(
                            binding.manifest().name()
                    )) {
                        throw new ToolRuntimeException(
                                "tool_exposure_name_mismatch",
                                "ToolCall 绑定的能力名称与当前调用不一致"
                        );
                    }
                    if (!exposure.manifestHash().equals(
                            binding.manifestHash()
                    )) {
                        throw new ToolRuntimeException(
                                "tool_binding_changed",
                                "模型看到的工具定义已经变化，不能用新版本执行旧 ToolCall"
                        );
                    }
                });
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
        if (hasSideEffect(binding.manifest())
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

    private void validateUserInputPrompt(
            ToolBinding binding,
            UserInputPrompt prompt
    ) {
        if (binding.manifest().sideEffect() != SideEffect.INTERNAL_STATE
                || binding.manifest().riskLevel() != RiskLevel.STANDARD) {
            throw new ToolRuntimeException(
                    "invalid_user_input_manifest",
                    "用户输入工具只能声明为标准级 Iris 内部状态"
            );
        }
        if (prompt == null
                || prompt.question() == null
                || prompt.question().isBlank()
                || prompt.options().size() < 2
                || prompt.options().size() > 5) {
            throw new ToolRuntimeException(
                    "invalid_user_input_prompt",
                    "用户输入请求必须包含一个问题和 2 到 5 个选项"
            );
        }
        java.util.Set<String> ids = new java.util.HashSet<>();
        for (Option option : prompt.options()) {
            if (option.id() == null || option.id().isBlank()
                    || option.label() == null || option.label().isBlank()
                    || !ids.add(option.id())) {
                throw new ToolRuntimeException(
                        "invalid_user_input_prompt",
                        "用户输入选项必须有唯一 ID 和可读标签"
                );
            }
        }
        if (prompt.recommendedOptionId() != null
                && !ids.contains(prompt.recommendedOptionId())) {
            throw new ToolRuntimeException(
                    "invalid_user_input_prompt",
                    "推荐项必须引用现有选项"
            );
        }
    }

    private boolean requiresApproval(ToolManifest manifest) {
        return approvalMode == ApprovalMode.REQUIRED
                && manifest.sideEffect() != SideEffect.NONE
                && manifest.sideEffect() != SideEffect.INTERNAL_STATE;
    }

    private boolean hasSideEffect(ToolManifest manifest) {
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

    private enum ApprovalMode {
        REQUIRED,
        AUTO;

        private static ApprovalMode parse(String raw) {
            if (raw == null || raw.isBlank()) {
                return REQUIRED;
            }
            try {
                return valueOf(raw.trim().toUpperCase(
                        java.util.Locale.ROOT
                ));
            } catch (IllegalArgumentException exception) {
                throw new IllegalStateException(
                        "iris.tools.approval-mode 只能是 required 或 auto"
                );
            }
        }
    }

    private void completeCancellation(
            String executionId,
            ToolContext context,
            String stage
    ) {
        boolean timedOut = context.deadlineExceeded();
        completeFailure(
                executionId,
                ToolOutcome.Kind.FAILED,
                timedOut
                        ? "tool_timeout_before_" + stage
                        : "cancelled_before_" + stage,
                timedOut
                        ? "工具超过声明的运行时间，尚未改变外部状态"
                        : "用户已停止当前任务，工具尚未改变外部状态",
                List.of()
        );
    }

    private RuntimeResult result(String executionId) {
        return repository.findByExecutionId(executionId)
                .orElseThrow(() -> new IllegalStateException(
                        "Tool execution disappeared after commit"
                ));
    }

    private String boundedOutput(
            ToolManifest manifest,
            String json,
            String executionId
    ) {
        if (json.length() <= manifest.resultCharacterLimit()) {
            return json;
        }
        ObjectNode truncated = objectMapper.createObjectNode();
        truncated.put("truncated", true);
        truncated.put("originalCharacters", json.length());
        truncated.put("resultReference", "tool-result://" + executionId);
        int previewLimit = Math.max(
                0,
                manifest.resultCharacterLimit() - 1_000
        );
        truncated.put(
                "preview",
                json.substring(0, previewLimit)
        );
        truncated.put(
                "guidance",
                "完整结果仍已保存；使用 read_tool_result 按字符窗口读取。"
                        + "如工具尚未加载，先读取能力 "
                        + "/system/context/read_tool_result"
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

    private String errorCode(Exception exception, String fallback) {
        return exception instanceof ToolRuntimeException runtimeException
                ? runtimeException.code()
                : fallback;
    }

    private boolean noOperationEffect(Exception exception) {
        return exception instanceof ToolRuntimeException runtimeException
                && runtimeException.noOperationEffect();
    }

    private ToolContext withDeadline(
            ToolContext context,
            ToolManifest manifest
    ) {
        return new DeadlineToolContext(
                context,
                clock.instant().plusSeconds(manifest.timeoutSeconds()),
                clock
        );
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

    private void requireUserInputDecision(UserInputDecision decision) {
        if (decision == null
                || decision.inputRequestId() == null
                || decision.inputRequestId().isBlank()
                || decision.decisionKey() == null
                || decision.decisionKey().isBlank()
                || decision.expectedVersion() < 1
                || decision.answer() == null
                || decision.answer().isBlank()) {
            throw new ToolRuntimeException(
                    "invalid_user_input_decision",
                    "用户输入响应缺少 request、版本、幂等键或答案"
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

    private record ResolvedInvocation(
            ToolBinding binding,
            JsonNode input,
            ToolCallResolver.ResolvedToolCall resolution
    ) {
    }

    private record ResolvedUserAnswer(String optionId, String value) {
    }

    private record DeadlineToolContext(
            ToolContext delegate,
            Instant deadline,
            Clock clock
    ) implements ToolContext {
        @Override
        public String conversationId() {
            return delegate.conversationId();
        }

        @Override
        public String turnId() {
            return delegate.turnId();
        }

        @Override
        public String runId() {
            return delegate.runId();
        }

        @Override
        public String roundId() {
            return delegate.roundId();
        }

        @Override
        public java.nio.file.Path workspaceRoot() {
            return delegate.workspaceRoot();
        }

        @Override
        public boolean cancelled() {
            return delegate.cancelled() || deadlineExceeded();
        }

        @Override
        public boolean deadlineExceeded() {
            return !clock.instant().isBefore(deadline);
        }

        @Override
        public boolean externalWritesAllowed() {
            return delegate.externalWritesAllowed();
        }
    }
}
