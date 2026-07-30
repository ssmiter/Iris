package com.iris.conversation.application;

import com.fasterxml.jackson.core.JsonProcessingException;
import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.node.ObjectNode;
import com.iris.artifact.ArtifactService;
import com.iris.conversation.domain.ApiProblemException;
import com.iris.conversation.domain.ConversationCommands.CreateConversationRequest;
import com.iris.conversation.domain.ConversationCommands.CreateConversationResponse;
import com.iris.conversation.domain.ConversationCommands.CreateBranchRequest;
import com.iris.conversation.domain.ConversationCommands.CreateBranchResponse;
import com.iris.conversation.domain.ConversationCommands.CreateTurnRequest;
import com.iris.conversation.domain.ConversationCommands.TurnAcceptance;
import com.iris.conversation.domain.ConversationEvent;
import com.iris.conversation.domain.ConversationViews.RequestView;
import com.iris.conversation.domain.ConversationViews.BranchSummary;
import com.iris.conversation.domain.ConversationViews.ForkAnchor;
import com.iris.conversation.domain.ConversationViews.RunBudget;
import com.iris.conversation.domain.ConversationViews.RunDefinition;
import com.iris.conversation.domain.ConversationViews.RunView;
import com.iris.conversation.domain.ConversationViews.RenameConversationRequest;
import com.iris.conversation.domain.ConversationViews.RenameConversationResponse;
import com.iris.conversation.domain.ConversationViews.TurnStats;
import com.iris.conversation.domain.ConversationViews.TurnView;
import com.iris.conversation.infrastructure.ConversationEventHub;
import com.iris.conversation.infrastructure.ConversationRepository;
import org.springframework.http.HttpStatus;
import org.springframework.stereotype.Service;
import org.springframework.transaction.support.TransactionTemplate;

import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.security.NoSuchAlgorithmException;
import java.time.Clock;
import java.time.Instant;
import java.util.HexFormat;
import java.util.List;
import java.util.HashSet;
import java.util.UUID;

@Service
public final class ConversationCommandService {
    private static final String CREATE_ENDPOINT = "POST:/api/v1/conversations";
    private static final String TURN_ENDPOINT = "POST:/api/v1/conversations/{id}/turns";
    private static final String BRANCH_ENDPOINT =
            "POST:/api/v1/conversations/{id}/branches";
    private static final String RENAME_ENDPOINT = "PATCH:/api/v1/conversations/{id}";

    private final ConversationRepository repository;
    private final ConversationEventHub eventHub;
    private final ConversationLocks locks;
    private final TransactionTemplate transactions;
    private final ObjectMapper objectMapper;
    private final ArtifactService artifacts;
    private final Clock clock;

    public ConversationCommandService(
            ConversationRepository repository,
            ConversationEventHub eventHub,
            ConversationLocks locks,
            TransactionTemplate transactions,
            ObjectMapper objectMapper,
            ArtifactService artifacts
    ) {
        this.repository = repository;
        this.eventHub = eventHub;
        this.locks = locks;
        this.transactions = transactions;
        this.objectMapper = objectMapper;
        this.artifacts = artifacts;
        this.clock = Clock.systemUTC();
    }

    public CreateConversationResponse createConversation(
            String idempotencyKey,
            CreateConversationRequest request
    ) {
        requireIdempotencyKey(idempotencyKey);
        String requestHash = hash(request);
        return locks.withLock("create-conversation", () ->
                transactions.execute(status -> repository
                        .findIdempotency("global", CREATE_ENDPOINT, idempotencyKey)
                        .map(record -> replay(
                                record,
                                requestHash,
                                CreateConversationResponse.class
                        ))
                        .orElseGet(() -> createConversationOnce(
                                idempotencyKey,
                                requestHash,
                                request
                        )))
        );
    }

    public TurnAcceptance acceptTurn(
            String conversationId,
            String idempotencyKey,
            CreateTurnRequest request
    ) {
        requireIdempotencyKey(idempotencyKey);
        requireAttachments(
                conversationId,
                request.input().attachmentRefs()
        );
        if (!"agentic".equals(request.entrypoint() == null
                ? "agentic"
                : request.entrypoint().normalizedKind())) {
            throw new ApiProblemException(
                    HttpStatus.UNPROCESSABLE_ENTITY,
                    "invalid_request",
                    "validation",
                    "节点 2.1 只接受自然语言 Agentic 入口。"
            );
        }

        String requestHash = hash(request);
        CommandResult result = locks.withLock(conversationId, () ->
                transactions.execute(status -> repository
                        .findIdempotency(conversationId, TURN_ENDPOINT, idempotencyKey)
                        .map(record -> new CommandResult(
                                replay(record, requestHash, TurnAcceptance.class),
                                List.of()
                        ))
                        .orElseGet(() -> acceptTurnOnce(
                                conversationId,
                                idempotencyKey,
                                requestHash,
                                request
                        )))
        );
        if (result == null) {
            throw new IllegalStateException("Turn transaction returned no result");
        }
        eventHub.publish(result.events());
        return result.acceptance();
    }

    public CreateBranchResponse createBranch(
            String conversationId,
            String idempotencyKey,
            CreateBranchRequest request
    ) {
        requireIdempotencyKey(idempotencyKey);
        requireAttachments(
                conversationId,
                request.replacement().attachmentRefs()
        );
        if (request.expectedConversationVersion() < 1) {
            throw new ApiProblemException(
                    HttpStatus.BAD_REQUEST,
                    "invalid_request",
                    "validation",
                    "expectedConversationVersion 必须为正数。"
            );
        }
        String requestHash = hash(request);
        BranchResult result = locks.withLock(conversationId, () ->
                transactions.execute(status -> repository
                        .findIdempotency(
                                conversationId,
                                BRANCH_ENDPOINT,
                                idempotencyKey
                        )
                        .map(record -> new BranchResult(
                                replay(
                                        record,
                                        requestHash,
                                        CreateBranchResponse.class
                                ),
                                List.of()
                        ))
                        .orElseGet(() -> createBranchOnce(
                                conversationId,
                                idempotencyKey,
                                requestHash,
                                request
                        )))
        );
        if (result == null) {
            throw new IllegalStateException(
                    "Branch transaction returned no result"
            );
        }
        eventHub.publish(result.events());
        return result.response();
    }

    public RenameConversationResponse renameConversation(
            String conversationId,
            String idempotencyKey,
            RenameConversationRequest request
    ) {
        requireIdempotencyKey(idempotencyKey);
        String title = normalizeRequiredTitle(request.title());
        String requestHash = hash(request);
        RenameResult result = locks.withLock(conversationId, () ->
                transactions.execute(status -> repository
                        .findIdempotency(
                                conversationId,
                                RENAME_ENDPOINT,
                                idempotencyKey
                        )
                        .map(record -> new RenameResult(
                                replay(
                                        record,
                                        requestHash,
                                        RenameConversationResponse.class
                                ),
                                List.of()
                        ))
                        .orElseGet(() -> renameConversationOnce(
                                conversationId,
                                idempotencyKey,
                                requestHash,
                                request.expectedVersion(),
                                title
                        )))
        );
        if (result == null) {
            throw new IllegalStateException("Rename transaction returned no result");
        }
        eventHub.publish(result.events());
        return result.response();
    }

    private CreateConversationResponse createConversationOnce(
            String idempotencyKey,
            String requestHash,
            CreateConversationRequest request
    ) {
        Instant now = clock.instant();
        String conversationId = id("conv");
        String rootBranchId = id("branch");
        repository.insertConversation(
                conversationId,
                rootBranchId,
                normalizeTitle(request.title()),
                now
        );
        CreateConversationResponse response =
                new CreateConversationResponse(conversationId, rootBranchId, 1);
        repository.insertIdempotency(
                "global",
                CREATE_ENDPOINT,
                idempotencyKey,
                requestHash,
                HttpStatus.CREATED.value(),
                write(response),
                now
        );
        return response;
    }

    private CommandResult acceptTurnOnce(
            String conversationId,
            String idempotencyKey,
            String requestHash,
            CreateTurnRequest request
    ) {
        if (!repository.conversationExists(conversationId)) {
            throw new ApiProblemException(
                    HttpStatus.NOT_FOUND,
                    "conversation_not_found",
                    "not_found",
                    "找不到这个对话。"
            );
        }
        if (!repository.branchBelongsToConversation(
                request.branchId(),
                conversationId
        )) {
            throw new ApiProblemException(
                    HttpStatus.CONFLICT,
                    "branch_not_in_conversation",
                    "precondition",
                    "选择的分支不属于这个对话。"
            );
        }

        Instant now = clock.instant();
        String commandId = id("cmd");
        String turnId = id("turn");
        String messageId = id("msg");
        String runId = id("run");

        repository.insertMessage(
                messageId,
                conversationId,
                request.branchId(),
                turnId,
                request.input().text().trim(),
                request.clientRequestId(),
                request.input().attachmentRefs(),
                now
        );
        repository.insertTurn(
                turnId,
                conversationId,
                request.branchId(),
                messageId,
                runId,
                now
        );
        repository.insertRootRun(
                runId,
                conversationId,
                request.branchId(),
                turnId,
                request.input().text().trim(),
                hash("iris.agentic.default:1"),
                hash(request.input()),
                now
        );
        repository.incrementConversationVersion(conversationId, now);

        TurnView turnView = new TurnView(
                turnId,
                request.branchId(),
                messageId,
                new RequestView(
                        request.input().text().trim(),
                        request.input().attachmentRefs()
                ),
                "active",
                List.of(runId),
                runId,
                List.of(),
                List.of(),
                null,
                null,
                List.of(),
                new TurnStats(0, 0, 0, now, null),
                1
        );
        RunView runView = new RunView(
                runId,
                turnId,
                null,
                runId,
                null,
                "agentic",
                new RunDefinition(
                        "iris.agentic.default",
                        "1",
                        hash("iris.agentic.default:1"),
                        hash(request.input()),
                        null
                ),
                request.input().text().trim(),
                "running",
                null,
                List.of(),
                List.of(),
                List.of(),
                new RunBudget(0, 30, 0, 600_000),
                null,
                List.of(),
                null,
                1,
                now,
                null
        );

        long firstSequence = repository.nextEventSequence(conversationId);
        ConversationEvent turnEvent = event(
                id("evt"),
                "turn.accepted",
                conversationId,
                request.branchId(),
                turnId,
                runId,
                firstSequence,
                "turn",
                turnId,
                commandId,
                runId,
                now,
                payload("turn", turnView)
        );
        ConversationEvent runEvent = event(
                id("evt"),
                "run.started",
                conversationId,
                request.branchId(),
                turnId,
                runId,
                firstSequence + 1,
                "run",
                runId,
                turnEvent.eventId(),
                runId,
                now,
                payload("run", runView)
        );
        repository.insertEvent(turnEvent);
        repository.insertEvent(runEvent);

        TurnAcceptance acceptance = new TurnAcceptance(
                conversationId,
                request.branchId(),
                turnId,
                messageId,
                runId,
                now,
                turnEvent.eventId()
        );
        repository.insertIdempotency(
                conversationId,
                TURN_ENDPOINT,
                idempotencyKey,
                requestHash,
                HttpStatus.ACCEPTED.value(),
                write(acceptance),
                now
        );
        return new CommandResult(acceptance, List.of(turnEvent, runEvent));
    }

    private RenameResult renameConversationOnce(
            String conversationId,
            String idempotencyKey,
            String requestHash,
            long expectedVersion,
            String title
    ) {
        ConversationRepository.ConversationMetadata metadata =
                repository.findConversationMetadata(conversationId)
                        .orElseThrow(() -> new ApiProblemException(
                                HttpStatus.NOT_FOUND,
                                "conversation_not_found",
                                "not_found",
                                "找不到这个对话。"
                        ));
        if (metadata.version() != expectedVersion) {
            throw new ApiProblemException(
                    HttpStatus.CONFLICT,
                    "stale_version",
                    "conflict",
                    "对话已经发生变化，请刷新后重试。",
                    java.util.Map.of("currentVersion", metadata.version())
            );
        }

        Instant now = clock.instant();
        long version = repository.updateConversationTitle(
                conversationId,
                expectedVersion,
                title,
                now
        );
        if (version < 0) {
            throw new ApiProblemException(
                    HttpStatus.CONFLICT,
                    "stale_version",
                    "conflict",
                    "对话已经发生变化，请刷新后重试。"
            );
        }

        String commandId = id("cmd");
        long sequence = repository.nextEventSequence(conversationId);
        ObjectNode conversation = objectMapper.createObjectNode();
        conversation.put("conversationId", conversationId);
        conversation.put("title", title);
        conversation.put("updatedAt", now.toString());
        conversation.put("version", version);
        ConversationEvent event = event(
                id("evt"),
                "conversation.updated",
                conversationId,
                null,
                null,
                null,
                sequence,
                "conversation",
                conversationId,
                commandId,
                commandId,
                now,
                payload("conversation", conversation)
        );
        repository.insertEvent(event);

        RenameConversationResponse response =
                new RenameConversationResponse(
                        conversationId,
                        title,
                        version,
                        now,
                        event.eventId()
                );
        repository.insertIdempotency(
                conversationId,
                RENAME_ENDPOINT,
                idempotencyKey,
                requestHash,
                HttpStatus.OK.value(),
                write(response),
                now
        );
        return new RenameResult(response, List.of(event));
    }

    private BranchResult createBranchOnce(
            String conversationId,
            String idempotencyKey,
            String requestHash,
            CreateBranchRequest request
    ) {
        ConversationRepository.ConversationMetadata metadata =
                repository.findConversationMetadata(conversationId)
                        .orElseThrow(() -> new ApiProblemException(
                                HttpStatus.NOT_FOUND,
                                "conversation_not_found",
                                "not_found",
                                "找不到这个对话。"
                        ));
        if (metadata.version() != request.expectedConversationVersion()) {
            throw new ApiProblemException(
                    HttpStatus.CONFLICT,
                    "stale_version",
                    "conflict",
                    "对话已经发生变化，请刷新后再创建分支。",
                    java.util.Map.of(
                            "currentVersion",
                            metadata.version()
                    )
            );
        }
        if (!repository.branchBelongsToConversation(
                request.sourceBranchId(),
                conversationId
        )) {
            throw new ApiProblemException(
                    HttpStatus.CONFLICT,
                    "branch_not_in_conversation",
                    "precondition",
                    "源分支不属于这个对话。"
            );
        }
        if (repository.hasActiveTurn(
                conversationId,
                request.sourceBranchId()
        )) {
            throw new ApiProblemException(
                    HttpStatus.CONFLICT,
                    "branch_source_active",
                    "precondition",
                    "源分支仍有任务在运行，请先停止或等待它结束。"
            );
        }
        ConversationRepository.BranchAnchor anchor = repository
                .findBranchAnchor(
                        conversationId,
                        request.sourceBranchId(),
                        request.anchorMessageId()
                )
                .orElseThrow(() -> new ApiProblemException(
                        HttpStatus.NOT_FOUND,
                        "branch_anchor_not_found",
                        "not_found",
                        "找不到源分支上的用户消息锚点。"
                ));

        Instant now = clock.instant();
        String commandId = id("cmd");
        String branchId = id("branch");
        String turnId = id("turn");
        String messageId = id("msg");
        String runId = id("run");
        ConversationRepository.ContextFrame baseFrame =
                repository.eligibleContextFrame(
                        conversationId,
                        request.sourceBranchId(),
                        anchor.sourceEventSequence()
                );
        repository.insertBranch(
                branchId,
                conversationId,
                request.sourceBranchId(),
                request.anchorMessageId(),
                anchor.sourceTurnId(),
                anchor.sourceEventSequence(),
                baseFrame.frameId(),
                now
        );
        repository.insertMessage(
                messageId,
                conversationId,
                branchId,
                turnId,
                request.replacement().text().trim(),
                "branch-replacement:" + commandId,
                request.replacement().attachmentRefs(),
                now
        );
        repository.insertTurn(
                turnId,
                conversationId,
                branchId,
                messageId,
                runId,
                now
        );
        repository.insertRootRun(
                runId,
                conversationId,
                branchId,
                turnId,
                request.replacement().text().trim(),
                hash("iris.agentic.default:1"),
                hash(request.replacement()),
                now
        );
        repository.incrementConversationVersion(conversationId, now);

        BranchSummary branch = new BranchSummary(
                branchId,
                request.sourceBranchId(),
                new ForkAnchor(
                        "replace_user_message",
                        request.anchorMessageId(),
                        anchor.sourceTurnId(),
                        anchor.sourceEventSequence(),
                        baseFrame.frameId(),
                        baseFrame.waterlineSequence()
                ),
                turnId,
                "active",
                1
        );
        TurnView turn = new TurnView(
                turnId,
                branchId,
                messageId,
                new RequestView(
                        request.replacement().text().trim(),
                        request.replacement().attachmentRefs()
                ),
                "active",
                List.of(runId),
                runId,
                List.of(),
                List.of(),
                null,
                null,
                List.of(),
                new TurnStats(0, 0, 0, now, null),
                1
        );
        RunView run = new RunView(
                runId,
                turnId,
                null,
                runId,
                null,
                "agentic",
                new RunDefinition(
                        "iris.agentic.default",
                        "1",
                        hash("iris.agentic.default:1"),
                        hash(request.replacement()),
                        null
                ),
                request.replacement().text().trim(),
                "running",
                null,
                List.of(),
                List.of(),
                List.of(),
                new RunBudget(0, 30, 0, 600_000),
                null,
                List.of(),
                null,
                1,
                now,
                null
        );

        long sequence = repository.nextEventSequence(conversationId);
        ConversationEvent branchEvent = event(
                id("evt"),
                "branch.created",
                conversationId,
                branchId,
                turnId,
                runId,
                sequence,
                "branch",
                branchId,
                commandId,
                runId,
                now,
                payload("branch", branch)
        );
        ConversationEvent turnEvent = event(
                id("evt"),
                "turn.accepted",
                conversationId,
                branchId,
                turnId,
                runId,
                sequence + 1,
                "turn",
                turnId,
                branchEvent.eventId(),
                runId,
                now,
                payload("turn", turn)
        );
        ConversationEvent runEvent = event(
                id("evt"),
                "run.started",
                conversationId,
                branchId,
                turnId,
                runId,
                sequence + 2,
                "run",
                runId,
                turnEvent.eventId(),
                runId,
                now,
                payload("run", run)
        );
        repository.insertEvent(branchEvent);
        repository.insertEvent(turnEvent);
        repository.insertEvent(runEvent);

        CreateBranchResponse response = new CreateBranchResponse(
                branchId,
                request.sourceBranchId(),
                request.anchorMessageId(),
                messageId,
                turnId,
                runId,
                now,
                branchEvent.eventId()
        );
        repository.insertIdempotency(
                conversationId,
                BRANCH_ENDPOINT,
                idempotencyKey,
                requestHash,
                HttpStatus.CREATED.value(),
                write(response),
                now
        );
        return new BranchResult(
                response,
                List.of(branchEvent, turnEvent, runEvent)
        );
    }

    private ConversationEvent event(
            String eventId,
            String type,
            String conversationId,
            String branchId,
            String turnId,
            String runId,
            long sequence,
            String aggregateKind,
            String aggregateId,
            String causationId,
            String correlationId,
            Instant occurredAt,
            JsonNode payload
    ) {
        return new ConversationEvent(
                1,
                eventId,
                type,
                conversationId,
                branchId,
                turnId,
                runId,
                null,
                sequence,
                new ConversationEvent.AggregateRef(
                        aggregateKind,
                        aggregateId,
                        1
                ),
                causationId,
                correlationId,
                occurredAt,
                payload
        );
    }

    private ObjectNode payload(String field, Object value) {
        ObjectNode payload = objectMapper.createObjectNode();
        payload.set(field, objectMapper.valueToTree(value));
        return payload;
    }

    private <T> T replay(
            ConversationRepository.IdempotencyRecord record,
            String requestHash,
            Class<T> responseType
    ) {
        if (!record.requestHash().equals(requestHash)) {
            throw new ApiProblemException(
                    HttpStatus.CONFLICT,
                    "idempotency_key_reused",
                    "conflict",
                    "这个幂等键已经用于不同的请求，请生成新的键。"
            );
        }
        try {
            return objectMapper.readValue(record.responseJson(), responseType);
        } catch (JsonProcessingException exception) {
            throw new IllegalStateException(
                    "Stored idempotent response cannot be read",
                    exception
            );
        }
    }

    private String hash(Object value) {
        return hash(write(value));
    }

    private String hash(String value) {
        try {
            byte[] digest = MessageDigest.getInstance("SHA-256")
                    .digest(value.getBytes(StandardCharsets.UTF_8));
            return HexFormat.of().formatHex(digest);
        } catch (NoSuchAlgorithmException exception) {
            throw new IllegalStateException("SHA-256 is unavailable", exception);
        }
    }

    private String write(Object value) {
        try {
            return objectMapper.writeValueAsString(value);
        } catch (JsonProcessingException exception) {
            throw new IllegalArgumentException("Request cannot be serialized", exception);
        }
    }

    private void requireIdempotencyKey(String key) {
        if (key == null || key.isBlank()) {
            throw new ApiProblemException(
                    HttpStatus.BAD_REQUEST,
                    "invalid_request",
                    "validation",
                    "缺少 Idempotency-Key。"
            );
        }
        if (key.length() > 200) {
            throw new ApiProblemException(
                    HttpStatus.BAD_REQUEST,
                    "invalid_request",
                    "validation",
                    "Idempotency-Key 过长。"
            );
        }
    }

    private void requireAttachments(
            String conversationId,
            List<String> references
    ) {
        if (references.size() > 16
                || new HashSet<>(references).size() != references.size()) {
            throw new ApiProblemException(
                    HttpStatus.BAD_REQUEST,
                    "invalid_attachments",
                    "validation",
                    "每条消息最多附加 16 个不重复的文件。"
            );
        }
        try {
            references.forEach(reference ->
                    artifacts.require(reference, conversationId));
        } catch (RuntimeException exception) {
            throw new ApiProblemException(
                    HttpStatus.UNPROCESSABLE_ENTITY,
                    "attachment_unavailable",
                    "precondition",
                    "附件不属于当前对话，或其精确版本已不可用。"
            );
        }
    }

    private String normalizeTitle(String title) {
        if (title == null || title.isBlank()) {
            return null;
        }
        String normalized = title.trim();
        if (normalized.length() > 200) {
            throw new ApiProblemException(
                    HttpStatus.BAD_REQUEST,
                    "invalid_request",
                    "validation",
                    "对话标题不能超过 200 个字符。"
            );
        }
        return normalized;
    }

    private String normalizeRequiredTitle(String title) {
        String normalized = normalizeTitle(title);
        if (normalized == null) {
            throw new ApiProblemException(
                    HttpStatus.BAD_REQUEST,
                    "invalid_request",
                    "validation",
                    "对话标题不能为空。"
            );
        }
        return normalized;
    }

    private String id(String prefix) {
        return prefix + "_" + UUID.randomUUID().toString().replace("-", "");
    }

    private record CommandResult(
            TurnAcceptance acceptance,
            List<ConversationEvent> events
    ) {
    }

    private record RenameResult(
            RenameConversationResponse response,
            List<ConversationEvent> events
    ) {
    }

    private record BranchResult(
            CreateBranchResponse response,
            List<ConversationEvent> events
    ) {
    }
}
