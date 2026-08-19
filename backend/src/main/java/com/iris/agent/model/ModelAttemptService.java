package com.iris.agent.model;

import com.fasterxml.jackson.core.JsonProcessingException;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.iris.agent.model.ModelAttemptRepository.AttemptRow;
import com.iris.agent.model.ModelAttemptResult.ContentBlock;
import com.iris.agent.model.provider.ModelProviderException;
import com.iris.agent.run.RoundPhase;
import com.iris.agent.run.RunRoundRepository;
import com.iris.agent.run.RunRoundRepository.RoundRow;
import com.iris.agent.run.RunRoundRepository.RunRow;
import com.iris.agent.run.RunStateMachine;
import org.springframework.stereotype.Service;
import org.springframework.transaction.support.TransactionTemplate;

import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.security.NoSuchAlgorithmException;
import java.time.Clock;
import java.time.Instant;
import java.util.HashMap;
import java.util.List;
import java.util.HexFormat;
import java.util.Map;
import java.util.UUID;
import java.util.concurrent.locks.ReentrantLock;

@Service
public class ModelAttemptService {
    private static final int LOCK_COUNT = 64;

    private final ModelAttemptRepository attempts;
    private final RunRoundRepository runs;
    private final TransactionTemplate transactions;
    private final ObjectMapper objectMapper;
    private final Clock clock = Clock.systemUTC();
    private final ReentrantLock[] locks = new ReentrantLock[LOCK_COUNT];

    public ModelAttemptService(
            ModelAttemptRepository attempts,
            RunRoundRepository runs,
            TransactionTemplate transactions,
            ObjectMapper objectMapper
    ) {
        this.attempts = attempts;
        this.runs = runs;
        this.transactions = transactions;
        this.objectMapper = objectMapper;
        for (int index = 0; index < LOCK_COUNT; index++) {
            locks[index] = new ReentrantLock();
        }
    }

    public AttemptRow begin(
            String roundId,
            long expectedRoundVersion,
            String providerProfile,
            String modelId,
            String contextHash,
            String capabilityLeaseHash
    ) {
        requireText(providerProfile, "providerProfile");
        requireText(modelId, "modelId");
        requireHash(contextHash, "contextHash");
        requireHash(capabilityLeaseHash, "capabilityLeaseHash");
        return withLock(roundId, () -> transactions.execute(status -> {
            RoundRow round = runs.findRound(roundId).orElseThrow(
                    () -> new IllegalStateException("找不到 Round")
            );
            if (round.version() != expectedRoundVersion) {
                throw new IllegalStateException("Round version 已变化");
            }
            RunStateMachine.requireTransition(
                    round.phase(),
                    RoundPhase.MODEL_STREAMING
            );
            RunRow run = runs.findRun(round.runId()).orElseThrow();
            String attemptId = id("attempt");
            attempts.insertAttempt(
                    attemptId,
                    run.conversationId(),
                    run.turnId(),
                    run.runId(),
                    roundId,
                    attempts.nextAttemptIndex(roundId),
                    providerProfile,
                    modelId,
                    contextHash,
                    capabilityLeaseHash,
                    clock.instant()
            );
            if (!attempts.transitionRound(
                    roundId,
                    round.phase(),
                    RoundPhase.MODEL_STREAMING,
                    expectedRoundVersion,
                    clock.instant()
            )) {
                throw new IllegalStateException("Round begin 发生并发冲突");
            }
            return attempts.findAttempt(attemptId).orElseThrow();
        }));
    }

    public RoundRow commit(
            String attemptId,
            long expectedAttemptVersion,
            ModelAttemptResult result
    ) {
        validateResult(result);
        AttemptRow initial = attempts.findAttempt(attemptId).orElseThrow(
                () -> new IllegalStateException("找不到 ModelAttempt")
        );
        return withLock(initial.roundId(), () -> transactions.execute(status -> {
            AttemptRow attempt = attempts.findAttempt(attemptId).orElseThrow();
            if (!"streaming".equals(attempt.phase())
                    || attempt.version() != expectedAttemptVersion) {
                throw new IllegalStateException(
                        "ModelAttempt phase 或 version 已变化"
                );
            }
            if (!attempt.modelId().equals(result.modelId())) {
                throw new ModelProtocolException(
                        "model_identity_mismatch",
                        "Provider response model does not match the active attempt"
                );
            }
            RoundRow round = runs.findRound(attempt.roundId()).orElseThrow();
            if (round.phase() != RoundPhase.MODEL_STREAMING) {
                throw new IllegalStateException(
                        "Round 不在 model_streaming"
                );
            }

            Map<Integer, String> blockIds = new HashMap<>();
            for (ContentBlock block : result.blocks()) {
                String blockId = id("block");
                blockIds.put(block.index(), blockId);
                attempts.insertBlock(
                        attemptId,
                        blockId,
                        block,
                        hash(write(block)),
                        clock.instant()
                );
            }
            List<ContentBlock> toolBlocks = result.blocks().stream()
                    .filter(block -> block.kind()
                            == ModelStreamEvent.BlockKind.TOOL_CALL)
                    .sorted(java.util.Comparator.comparingInt(
                            ContentBlock::index
                    ))
                    .toList();
            for (ModelAttemptResult.ToolCall call : result.toolCalls()) {
                if (call.ordinal() < 0
                        || call.ordinal() >= toolBlocks.size()) {
                    throw new ModelProtocolException(
                            "tool_call_block_mismatch",
                            "ToolCall ordinal 与 tool block 不匹配"
                    );
                }
                String blockId = blockIds.get(
                        toolBlocks.get(call.ordinal()).index()
                );
                attempts.insertToolCall(
                        attemptId,
                        blockId,
                        call,
                        hash(write(call.arguments())),
                        clock.instant()
                );
            }
            if (!attempts.completeAttempt(
                    attemptId,
                    expectedAttemptVersion,
                    result,
                    clock.instant()
            )) {
                throw new IllegalStateException(
                        "ModelAttempt commit 发生并发冲突"
                );
            }
            if (!attempts.transitionRound(
                    round.roundId(),
                    RoundPhase.MODEL_STREAMING,
                    RoundPhase.MODEL_COMPLETED,
                    round.version(),
                    clock.instant()
            )) {
                throw new IllegalStateException(
                        "Round model completion 发生并发冲突"
                );
            }
            RoundRow completedModel = runs.findRound(round.roundId())
                    .orElseThrow();
            RoundPhase target = result.toolCalls().isEmpty()
                    ? RoundPhase.COMPLETED
                    : RoundPhase.AWAITING_TOOLS;
            RunStateMachine.requireTransition(
                    completedModel.phase(),
                    target
            );
            if (!attempts.transitionRound(
                    round.roundId(),
                    completedModel.phase(),
                    target,
                    completedModel.version(),
                    clock.instant()
            )) {
                throw new IllegalStateException(
                        "Round post-model transition 发生并发冲突"
                );
            }
            return runs.findRound(round.roundId()).orElseThrow();
        }));
    }

    public void fail(
            String attemptId,
            String category,
            FailureDiagnostic diagnostic
    ) {
        requireText(category, "category");
        AttemptRow initial = attempts.findAttempt(attemptId).orElseThrow();
        withLock(initial.roundId(), () -> {
            transactions.executeWithoutResult(status -> {
                AttemptRow attempt = attempts.findAttempt(attemptId)
                        .orElseThrow();
                RoundRow round = runs.findRound(attempt.roundId())
                        .orElseThrow();
                Instant now = clock.instant();
                if (!attempts.failAttempt(
                        attemptId,
                        attempt.version(),
                        category,
                        now
                )) {
                    throw new IllegalStateException(
                            "ModelAttempt failure 发生并发冲突"
                    );
                }
                persistFailureDetail(
                        attemptId,
                        category,
                        diagnostic,
                        now
                );
                if (round.phase() == RoundPhase.MODEL_STREAMING) {
                    if (!attempts.transitionRound(
                            round.roundId(),
                            round.phase(),
                            RoundPhase.FAILED,
                            round.version(),
                            now
                    )) {
                        throw new IllegalStateException(
                                "Round failure 发生并发冲突"
                        );
                    }
                }
            });
            return null;
        });
    }

    /**
     * Atomically closes a retryable attempt and opens its isolated successor
     * in the same Round. Context and capability exposure remain exact.
     */
    public AttemptRow retry(
            String attemptId,
            long expectedAttemptVersion,
            String category,
            FailureDiagnostic diagnostic
    ) {
        requireText(category, "category");
        AttemptRow initial = attempts.findAttempt(attemptId).orElseThrow();
        return withLock(initial.roundId(), () ->
                transactions.execute(status -> {
                    AttemptRow attempt = attempts.findAttempt(attemptId)
                            .orElseThrow();
                    if (!"streaming".equals(attempt.phase())
                            || attempt.version() != expectedAttemptVersion) {
                        throw new IllegalStateException(
                                "ModelAttempt retry precondition changed"
                        );
                    }
                    RoundRow round = runs.findRound(attempt.roundId())
                            .orElseThrow();
                    if (round.phase() != RoundPhase.MODEL_STREAMING) {
                        throw new IllegalStateException(
                                "Round is not retrying a model stream"
                        );
                    }
                    Instant now = clock.instant();
                    if (!attempts.failAttempt(
                            attemptId,
                            expectedAttemptVersion,
                            category,
                            now
                    )) {
                        throw new IllegalStateException(
                                "ModelAttempt retry close 发生并发冲突"
                        );
                    }
                    persistFailureDetail(
                            attemptId,
                            category,
                            diagnostic,
                            now
                    );
                    RunStateMachine.requireTransition(
                            RoundPhase.MODEL_STREAMING,
                            RoundPhase.ACCEPTED
                    );
                    if (!attempts.transitionRound(
                            round.roundId(),
                            RoundPhase.MODEL_STREAMING,
                            RoundPhase.ACCEPTED,
                            round.version(),
                            now
                    )) {
                        throw new IllegalStateException(
                                "Round retry reset 发生并发冲突"
                        );
                    }

                    RoundRow accepted = runs.findRound(round.roundId())
                            .orElseThrow();
                    String successorId = id("attempt");
                    attempts.insertAttempt(
                            successorId,
                            attempt.conversationId(),
                            attempt.turnId(),
                            attempt.runId(),
                            attempt.roundId(),
                            attempts.nextAttemptIndex(attempt.roundId()),
                            attempt.providerProfile(),
                            attempt.modelId(),
                            attempt.contextHash(),
                            attempt.capabilityLeaseHash(),
                            now
                    );
                    RunStateMachine.requireTransition(
                            RoundPhase.ACCEPTED,
                            RoundPhase.MODEL_STREAMING
                    );
                    if (!attempts.transitionRound(
                            round.roundId(),
                            RoundPhase.ACCEPTED,
                            RoundPhase.MODEL_STREAMING,
                            accepted.version(),
                            now
                    )) {
                        throw new IllegalStateException(
                                "Round retry begin 发生并发冲突"
                        );
                    }
                    return attempts.findAttempt(successorId).orElseThrow();
                })
        );
    }

    /**
     * Closes a streaming attempt as failed and returns the Round to ACCEPTED
     * so the caller can re-assemble context (for example with a tighter
     * budget) and begin a fresh attempt.
     */
    public RoundRow failAndResetForOverflow(
            String attemptId,
            String category,
            FailureDiagnostic diagnostic
    ) {
        requireText(category, "category");
        AttemptRow initial = attempts.findAttempt(attemptId).orElseThrow();
        return withLock(initial.roundId(), () ->
                transactions.execute(status -> {
                    AttemptRow attempt = attempts.findAttempt(attemptId)
                            .orElseThrow();
                    if (!"streaming".equals(attempt.phase())) {
                        throw new IllegalStateException(
                                "Attempt is not streaming"
                        );
                    }
                    RoundRow round = runs.findRound(attempt.roundId())
                            .orElseThrow();
                    if (round.phase() != RoundPhase.MODEL_STREAMING) {
                        throw new IllegalStateException(
                                "Round is not in model_streaming"
                        );
                    }
                    Instant now = clock.instant();
                    if (!attempts.failAttempt(
                            attemptId,
                            attempt.version(),
                            category,
                            now
                    )) {
                        throw new IllegalStateException(
                                "Context overflow reset close conflicted"
                        );
                    }
                    persistFailureDetail(
                            attemptId,
                            category,
                            diagnostic,
                            now
                    );
                    RunStateMachine.requireTransition(
                            RoundPhase.MODEL_STREAMING,
                            RoundPhase.ACCEPTED
                    );
                    if (!attempts.transitionRound(
                            round.roundId(),
                            RoundPhase.MODEL_STREAMING,
                            RoundPhase.ACCEPTED,
                            round.version(),
                            now
                    )) {
                        throw new IllegalStateException(
                                "Context overflow reset transition conflicted"
                        );
                    }
                    return runs.findRound(round.roundId()).orElseThrow();
                })
        );
    }

    public RoundRow cancel(String attemptId) {
        AttemptRow initial = attempts.findAttempt(attemptId).orElseThrow();
        return withLock(initial.roundId(), () ->
                transactions.execute(status -> {
                    AttemptRow attempt = attempts.findAttempt(attemptId)
                            .orElseThrow();
                    RoundRow round = runs.findRound(attempt.roundId())
                            .orElseThrow();
                    if (!attempts.failAttempt(
                            attemptId,
                            attempt.version(),
                            "user_cancelled",
                            clock.instant()
                    )) {
                        throw new IllegalStateException(
                                "ModelAttempt cancellation 发生并发冲突"
                        );
                    }
                    if (round.phase() == RoundPhase.MODEL_STREAMING
                            && !attempts.transitionRound(
                                    round.roundId(),
                                    round.phase(),
                                    RoundPhase.STOPPED,
                                    round.version(),
                                    clock.instant()
                            )) {
                        throw new IllegalStateException(
                                "Round cancellation 发生并发冲突"
                        );
                    }
                    return runs.findRound(round.roundId()).orElseThrow();
                })
        );
    }

    private void validateResult(ModelAttemptResult result) {
        if (result == null
                || result.modelId() == null
                || result.modelId().isBlank()
                || result.stopReason() == null
                || result.stopReason().isBlank()
                || result.usage() == null) {
            throw new ModelProtocolException(
                    "incomplete_model_result",
                    "ModelAttempt result 不完整"
            );
        }
        if (result.blocks().stream()
                .map(ContentBlock::index)
                .distinct()
                .count() != result.blocks().size()) {
            throw new ModelProtocolException(
                    "duplicate_block_index",
                    "ModelAttempt result 含重复 block index"
            );
        }
        if (!result.toolCalls().isEmpty()
                && !"tool_use".equals(result.stopReason())
                && !"tool_calls".equals(result.stopReason())) {
            throw new ModelProtocolException(
                    "tool_call_stop_reason_mismatch",
                    "模型返回工具调用，但 stop reason 不是 tool_use/tool_calls"
            );
        }
        boolean toolStop = "tool_use".equals(result.stopReason())
                || "tool_calls".equals(result.stopReason());
        if (result.toolCalls().isEmpty() && toolStop) {
            throw new ModelProtocolException(
                    "tool_call_stop_reason_mismatch",
                    "Provider reported a tool stop without a complete ToolCall"
            );
        }
        if (result.toolCalls().isEmpty()
                && !"end_turn".equals(result.stopReason())
                && !"max_tokens".equals(result.stopReason())) {
            throw new ModelProtocolException(
                    "unsupported_model_stop_reason",
                    "Provider ended a text response with unsupported stop reason: "
                            + result.stopReason()
            );
        }
        long toolBlockCount = result.blocks().stream()
                .filter(block -> block.kind()
                        == ModelStreamEvent.BlockKind.TOOL_CALL)
                .count();
        if (toolBlockCount != result.toolCalls().size()) {
            throw new ModelProtocolException(
                    "tool_call_block_mismatch",
                    "ToolCall facts do not match completed tool blocks"
            );
        }
        if (result.toolCalls().stream()
                .map(ModelAttemptResult.ToolCall::ordinal)
                .distinct()
                .count() != result.toolCalls().size()) {
            throw new ModelProtocolException(
                    "duplicate_tool_call_ordinal",
                    "ModelAttempt result contains duplicate ToolCall ordinals"
            );
        }
    }

    private String write(Object value) {
        try {
            return objectMapper.writeValueAsString(value);
        } catch (JsonProcessingException exception) {
            throw new IllegalStateException("模型事实无法序列化", exception);
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

    private void requireText(String value, String field) {
        if (value == null || value.isBlank()) {
            throw new IllegalArgumentException(field + " 不能为空");
        }
    }

    private void persistFailureDetail(
            String attemptId,
            String category,
            FailureDiagnostic diagnostic,
            Instant now
    ) {
        if (diagnostic == null) {
            return;
        }
        attempts.insertFailureDetail(
                attemptId,
                category,
                diagnostic.providerStatus(),
                diagnostic.providerCode(),
                diagnostic.providerType(),
                diagnostic.message(),
                now
        );
    }

    public record FailureDiagnostic(
            Integer providerStatus,
            String providerCode,
            String providerType,
            String message
    ) {
        public static FailureDiagnostic from(Throwable error) {
            Throwable current = error;
            while (current.getCause() != null
                    && current != current.getCause()) {
                current = current.getCause();
            }
            if (current instanceof ModelProviderException provider) {
                return new FailureDiagnostic(
                        provider.httpStatus(),
                        provider.providerCode(),
                        provider.providerType(),
                        provider.diagnosticMessage()
                );
            }
            if (current instanceof ModelProtocolException protocol) {
                return new FailureDiagnostic(
                        null,
                        protocol.code(),
                        "model_protocol",
                        protocol.getMessage()
                );
            }
            return new FailureDiagnostic(
                    null,
                    null,
                    current.getClass().getSimpleName(),
                    current.getMessage()
            );
        }
    }

    private void requireHash(String value, String field) {
        requireText(value, field);
        if (value.length() < 16) {
            throw new IllegalArgumentException(field + " 不是有效 hash");
        }
    }

    private <T> T withLock(String key, java.util.concurrent.Callable<T> work) {
        ReentrantLock lock = locks[Math.floorMod(key.hashCode(), locks.length)];
        lock.lock();
        try {
            return work.call();
        } catch (RuntimeException exception) {
            throw exception;
        } catch (Exception exception) {
            throw new IllegalStateException(
                    "ModelAttempt operation failed",
                    exception
            );
        } finally {
            lock.unlock();
        }
    }

    private String id(String prefix) {
        return prefix + "_" + UUID.randomUUID().toString().replace("-", "");
    }
}
