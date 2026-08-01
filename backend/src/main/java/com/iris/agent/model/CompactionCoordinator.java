package com.iris.agent.model;

import com.fasterxml.jackson.core.JsonProcessingException;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.node.ObjectNode;
import com.iris.agent.model.CompactionRepository.CompactionRow;
import com.iris.agent.model.CompactionService.CompactBoundary;
import com.iris.agent.model.CompactionService.CompactPlan;
import com.iris.agent.model.ModelAttemptRepository.AttemptRow;
import com.iris.agent.model.ModelAttemptService.FailureDiagnostic;
import com.iris.agent.model.ModelAttemptResult.ContentBlock;
import com.iris.agent.model.ModelStreamEvent.BlockKind;
import com.iris.agent.model.provider.ModelProvider;
import com.iris.agent.model.provider.ModelProviderException;
import com.iris.agent.model.provider.ModelProviderRegistry;
import com.iris.agent.run.RoundPhase;
import com.iris.agent.run.RunPhase;
import com.iris.agent.run.RunRoundRepository;
import org.springframework.stereotype.Service;
import org.springframework.transaction.support.TransactionTemplate;
import reactor.core.publisher.Mono;
import reactor.core.scheduler.Schedulers;

import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.security.NoSuchAlgorithmException;
import java.time.Clock;
import java.time.Instant;
import java.util.HexFormat;
import java.util.List;
import java.util.Map;

@Service
public final class CompactionCoordinator {
    private static final int MAX_ATTEMPTS = 3;
    private static final String SYSTEM_INSTRUCTION = """
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
    private static final int MAX_INPUT_TOKENS = 120_000;
    private static final int RESERVED_OUTPUT_TOKENS = 8_192;
    private static final String PROMPT_DEFINITION_ID = "iris.pipeline.compaction";
    private static final int PROMPT_VERSION = 2;

    private final CompactionRepository compactions;
    private final CompactionService frames;
    private final ModelProviderRegistry providers;
    private final ModelAttemptService attempts;
    private final ModelContextSnapshotRepository snapshots;
    private final ModelTokenEstimator tokens;
    private final RunRoundRepository runs;
    private final TransactionTemplate transactions;
    private final ObjectMapper objectMapper;
    private final Clock clock = Clock.systemUTC();
    private final ModelPromptPrefixService promptPrefixes;

    public CompactionCoordinator(
            CompactionRepository compactions,
            CompactionService frames,
            ModelProviderRegistry providers,
            ModelAttemptService attempts,
            ModelContextSnapshotRepository snapshots,
            ModelTokenEstimator tokens,
            RunRoundRepository runs,
            TransactionTemplate transactions,
            ObjectMapper objectMapper,
            ModelPromptPrefixService promptPrefixes
    ) {
        this.compactions = compactions;
        this.frames = frames;
        this.providers = providers;
        this.attempts = attempts;
        this.snapshots = snapshots;
        this.tokens = tokens;
        this.runs = runs;
        this.transactions = transactions;
        this.objectMapper = objectMapper;
        this.promptPrefixes = promptPrefixes;
    }

    public Mono<CompactBoundary> advance(
            String runId,
            String providerProfile
    ) {
        return Mono.fromCallable(() -> prepare(runId, providerProfile))
                .subscribeOn(Schedulers.boundedElastic())
                .flatMap(prepared -> {
                    if (prepared.completedSummary() != null) {
                        return finalizeFrame(
                                prepared.compaction(),
                                prepared.completedSummary()
                        );
                    }
                    return consume(prepared);
                })
                .onErrorResume(error -> Mono.fromRunnable(() ->
                                fail(runId, error))
                        .subscribeOn(Schedulers.boundedElastic())
                        .then(Mono.error(error)));
    }

    private Mono<CompactBoundary> consume(Prepared prepared) {
        ModelStreamAssembler assembler = new ModelStreamAssembler(
                prepared.attempt().attemptId(),
                objectMapper
        );
        return prepared.provider()
                .stream(prepared.request())
                .timeout(prepared.provider().timeout())
                .doOnNext(assembler::accept)
                .then(Mono.fromCallable(assembler::finish))
                .flatMap(result -> commitAndFinalize(prepared, result))
                .onErrorResume(error -> {
                    Throwable cause = unwrap(error);
                    if (!retryable(cause)
                            || prepared.attempt().attemptIndex() + 1
                            >= MAX_ATTEMPTS) {
                        return Mono.error(cause);
                    }
                    return Mono.fromCallable(() -> {
                                AttemptRow successor = attempts.retry(
                                        prepared.attempt().attemptId(),
                                        prepared.attempt().version(),
                                        failureCode(cause),
                                        FailureDiagnostic.from(cause)
                                );
                                return new Prepared(
                                        prepared.compaction(),
                                        prepared.provider(),
                                        successor,
                                        withAttemptId(
                                                prepared.request(),
                                                successor.attemptId()
                                        ),
                                        null
                                );
                            })
                            .subscribeOn(Schedulers.boundedElastic())
                            .flatMap(this::consume);
                });
    }

    private ModelRequest withAttemptId(
            ModelRequest request,
            String attemptId
    ) {
        return new ModelRequest(
                attemptId,
                request.conversationId(),
                request.runId(),
                request.roundId(),
                request.modelId(),
                request.systemInstruction(),
                request.items(),
                request.tools(),
                request.metadata()
        );
    }

    private boolean retryable(Throwable error) {
        if (error instanceof ModelProviderException provider) {
            return provider.retryable();
        }
        return error instanceof java.util.concurrent.TimeoutException;
    }

    private Throwable unwrap(Throwable error) {
        Throwable current = reactor.core.Exceptions.unwrap(error);
        while (current.getCause() != null && current != current.getCause()) {
            current = current.getCause();
        }
        return current;
    }

    private Prepared prepare(String runId, String providerProfile) {
        CompactionRow row = compactions.find(runId).orElseThrow(
                () -> new IllegalArgumentException(
                        "Compaction Run does not exist"
                )
        );
        if ("completed".equals(row.phase())) {
            throw new IllegalStateException("Compaction is already completed");
        }
        if ("failed".equals(row.phase()) || "cancelled".equals(row.phase())) {
            throw new IllegalStateException("Compaction is already terminal");
        }
        if ("accepted".equals(row.phase())
                && !compactions.markRunning(
                        row.runId(),
                        row.version(),
                        clock.instant()
                )) {
            throw new IllegalStateException(
                    "Compaction start changed concurrently"
            );
        }
        RoundPhase roundPhase = runs.findRound(row.roundId())
                .orElseThrow()
                .phase();
        if (roundPhase == RoundPhase.COMPLETED) {
            String summary = compactions.completedSummary(row.roundId())
                    .orElseThrow(() -> new IllegalStateException(
                            "Completed compaction attempt has no text summary"
                    ));
            return new Prepared(row, null, null, null, summary);
        }
        if (roundPhase != RoundPhase.ACCEPTED) {
            throw new IllegalStateException(
                    "Compaction model step cannot resume from " + roundPhase
            );
        }

        ModelProvider provider = providers.require(providerProfile);
        ModelContext context = context(row);
        AttemptRow attempt = attempts.begin(
                row.roundId(),
                runs.findRound(row.roundId()).orElseThrow().version(),
                provider.profileId(),
                provider.modelId(),
                context.contextHash(),
                context.capabilityLeaseHash()
        );
        ModelRequest request = new ModelRequest(
                attempt.attemptId(),
                row.conversationId(),
                row.runId(),
                row.roundId(),
                provider.modelId(),
                context.systemInstruction(),
                context.items(),
                List.of(),
                Map.of(
                        "providerProfile", provider.profileId(),
                        "pipeline", "compact_context",
                        "promptDefinitionId",
                        context.promptPrefix().promptDefinitionId(),
                        "promptVersion",
                        Integer.toString(
                                context.promptPrefix().promptVersion()
                        ),
                        "prefixHash", context.promptPrefix().prefixHash(),
                        "sourceSnapshotId", row.sourceSnapshotId(),
                        "sourceContentHash", row.sourceContentHash()
                )
        );
        return new Prepared(row, provider, attempt, request, null);
    }

    private ModelContext context(CompactionRow row) {
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
        ModelContext context = new ModelContext(
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
        );
        snapshots.save(
                context,
                row.conversationId(),
                row.branchId(),
                row.runId(),
                row.roundId(),
                payloadJson,
                clock.instant()
        );
        return context;
    }

    private Mono<CompactBoundary> commitAndFinalize(
            Prepared prepared,
            ModelAttemptResult result
    ) {
        return Mono.fromCallable(() -> {
                    attempts.commit(
                            prepared.attempt().attemptId(),
                            prepared.attempt().version(),
                            result
                    );
                    String summary = result.blocks().stream()
                            .filter(block -> block.kind() == BlockKind.TEXT)
                            .map(ContentBlock::text)
                            .filter(text -> text != null && !text.isBlank())
                            .reduce((left, right) -> left + "\n" + right)
                            .orElseThrow(() -> new ModelProtocolException(
                                    "compaction_summary_missing",
                                    "Compaction model returned no text summary"
                            ));
                    return summary.trim();
                })
                .subscribeOn(Schedulers.boundedElastic())
                .flatMap(summary ->
                        finalizeFrame(prepared.compaction(), summary));
    }

    private Mono<CompactBoundary> finalizeFrame(
            CompactionRow row,
            String summary
    ) {
        return Mono.fromCallable(() -> transactions.execute(status -> {
                    var run = runs.findRun(row.runId()).orElseThrow();
                    if (run.phase() == RunPhase.RUNNING
                            && !runs.transitionRun(
                                    run.runId(),
                                    RunPhase.RUNNING,
                                    RunPhase.VERIFYING,
                                    run.version(),
                                    clock.instant()
                            )) {
                        throw new IllegalStateException(
                                "Compaction Run verification transition conflicted"
                        );
                    }
                    CompactPlan plan = new CompactPlan(
                            row.conversationId(),
                            row.branchId(),
                            row.parentFrameId(),
                            row.sourceStartSequence(),
                            row.beforeTurnId(),
                            row.waterlineSequence(),
                            null,
                            row.sourceFactCount(),
                            0
                    );
                    CompactBoundary boundary =
                            frames.record(plan, row.trigger(), summary);
                    compactions.complete(
                            row.runId(),
                            boundary.boundaryId(),
                            clock.instant()
                    );
                    return boundary;
                }))
                .subscribeOn(Schedulers.boundedElastic())
                .map(boundary -> {
                    if (boundary == null) {
                        throw new IllegalStateException(
                                "Compaction finalization returned no boundary"
                        );
                    }
                    return boundary;
                });
    }

    private void fail(String runId, Throwable error) {
        CompactionRow row = compactions.find(runId).orElse(null);
        if (row == null
                || "completed".equals(row.phase())
                || "failed".equals(row.phase())
                || "cancelled".equals(row.phase())) {
            return;
        }
        ObjectNode failure = objectMapper.createObjectNode();
        failure.put("code", failureCode(error));
        failure.put(
                "userMessage",
                "这次上下文整理没有完成，原始对话历史没有受到影响。"
        );
        failure.put("source", "compaction_pipeline");
        compactions.streamingAttemptId(runId).ifPresent(attemptId -> {
            try {
                attempts.fail(
                        attemptId,
                        failureCode(error),
                        FailureDiagnostic.from(error)
                );
            } catch (RuntimeException ignored) {
                // The durable failure projection below remains authoritative.
            }
        });
        compactions.fail(runId, write(failure), clock.instant());
    }

    private String failureCode(Throwable error) {
        Throwable current = error;
        while (current.getCause() != null && current != current.getCause()) {
            current = current.getCause();
        }
        if (current instanceof PromptTooLargeException) {
            return "compaction_source_too_large";
        }
        if (current instanceof ModelProtocolException protocol) {
            return protocol.code();
        }
        return "compaction_failed";
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

    private record Prepared(
            CompactionRow compaction,
            ModelProvider provider,
            AttemptRow attempt,
            ModelRequest request,
            String completedSummary
    ) {
    }
}
