package com.iris.conversation.application;

import com.fasterxml.jackson.core.JsonProcessingException;
import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.node.ObjectNode;
import com.iris.agent.model.CompactionRepository;
import com.iris.agent.model.CompactionRepository.SourceSnapshot;
import com.iris.agent.model.CompactionService;
import com.iris.agent.model.CompactionService.CompactPlan;
import com.iris.conversation.domain.ApiProblemException;
import com.iris.conversation.domain.CompactionViews.CompactionView;
import com.iris.conversation.domain.CompactionViews.CreateCompactionRequest;
import com.iris.conversation.domain.CompactionViews.CreateCompactionResponse;
import com.iris.conversation.domain.ConversationEvent;
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
import java.util.Optional;
import java.util.UUID;

@Service
public final class CompactionCommandService {
    private static final String ENDPOINT =
            "POST:/api/v1/conversations/{id}/compactions";

    private final CompactionService compactions;
    private final CompactionRepository compactFacts;
    private final ConversationRepository conversations;
    private final ConversationEventHub eventHub;
    private final ConversationLocks locks;
    private final TransactionTemplate transactions;
    private final ObjectMapper objectMapper;
    private final Clock clock = Clock.systemUTC();

    public CompactionCommandService(
            CompactionService compactions,
            CompactionRepository compactFacts,
            ConversationRepository conversations,
            ConversationEventHub eventHub,
            ConversationLocks locks,
            TransactionTemplate transactions,
            ObjectMapper objectMapper
    ) {
        this.compactions = compactions;
        this.compactFacts = compactFacts;
        this.conversations = conversations;
        this.eventHub = eventHub;
        this.locks = locks;
        this.transactions = transactions;
        this.objectMapper = objectMapper;
    }

    public CreateCompactionResponse create(
            String conversationId,
            String idempotencyKey,
            CreateCompactionRequest request
    ) {
        requireIdempotencyKey(idempotencyKey);
        if (!"current_branch".equals(request.normalizedScope())) {
            throw problem(
                    HttpStatus.UNPROCESSABLE_ENTITY,
                    "invalid_compaction_scope",
                    "首版只支持压缩当前分支。"
            );
        }
        String requestHash = hash(request);
        CommandResult result = locks.withLock(conversationId, () ->
                transactions.execute(status -> conversations
                        .findIdempotency(
                                conversationId,
                                ENDPOINT,
                                idempotencyKey
                        )
                        .map(record -> new CommandResult(
                                replay(record, requestHash),
                                List.of()
                        ))
                        .orElseGet(() -> createOnce(
                                conversationId,
                                idempotencyKey,
                                requestHash,
                                request
                        )))
        );
        if (result == null) {
            throw new IllegalStateException(
                    "Compaction command transaction returned no result"
            );
        }
        eventHub.publish(result.events());
        return result.response();
    }

    public Optional<CreateCompactionResponse> createAuto(
            String conversationId,
            String branchId
    ) {
        CommandResult result = locks.withLock(conversationId, () ->
                transactions.execute(status -> createAutoOnce(
                        conversationId,
                        branchId
                ))
        );
        if (result == null) {
            return Optional.empty();
        }
        eventHub.publish(result.events());
        return Optional.of(result.response());
    }

    private CommandResult createOnce(
            String conversationId,
            String idempotencyKey,
            String requestHash,
            CreateCompactionRequest request
    ) {
        if (!conversations.branchBelongsToConversation(
                request.branchId(),
                conversationId
        )) {
            throw problem(
                    HttpStatus.NOT_FOUND,
                    "branch_not_found",
                    "找不到要整理的对话分支。"
            );
        }
        if (compactFacts.hasActive(conversationId, request.branchId())) {
            throw problem(
                    HttpStatus.CONFLICT,
                    "compaction_already_running",
                    "当前分支已经在整理上下文。"
            );
        }
        CompactPlan plan;
        try {
            plan = compactions.planManual(
                    conversationId,
                    request.branchId()
            );
        } catch (IllegalStateException exception) {
            throw problem(
                    HttpStatus.CONFLICT,
                    "compaction_not_ready",
                    exception.getMessage()
            );
        }
        CommandResult result = createRun(
                conversationId,
                request.branchId(),
                plan,
                "manual"
        );
        conversations.insertIdempotency(
                conversationId,
                ENDPOINT,
                idempotencyKey,
                requestHash,
                HttpStatus.ACCEPTED.value(),
                write(result.response()),
                clock.instant()
        );
        return result;
    }

    private CommandResult createAutoOnce(
            String conversationId,
            String branchId
    ) {
        if (!conversations.branchBelongsToConversation(
                branchId,
                conversationId
        ) || compactFacts.hasActive(conversationId, branchId)) {
            return null;
        }
        CompactPlan plan;
        try {
            plan = compactions.planManual(conversationId, branchId);
        } catch (IllegalStateException exception) {
            return null;
        }
        return createRun(conversationId, branchId, plan, "auto");
    }

    private CommandResult createRun(
            String conversationId,
            String branchId,
            CompactPlan plan,
            String trigger
    ) {
        SourceSnapshot source = compactFacts.buildSource(plan);
        String runId = id("run");
        String roundId = id("round");
        Instant now = clock.instant();
        compactFacts.insertAccepted(
                runId,
                roundId,
                plan,
                source,
                trigger,
                now
        );
        CompactionView view = compactFacts.view(runId).orElseThrow();
        long sequence = conversations.nextEventSequence(conversationId);
        String eventId = id("evt");
        ConversationEvent event = new ConversationEvent(
                1,
                eventId,
                "compaction.started",
                conversationId,
                branchId,
                plan.operationAnchorTurnId(),
                runId,
                null,
                sequence,
                new ConversationEvent.AggregateRef(
                        "compaction",
                        runId,
                        view.version()
                ),
                eventId,
                runId,
                now,
                payload(view, null)
        );
        conversations.insertEvent(event);
        conversations.incrementConversationVersion(conversationId, now);
        CreateCompactionResponse response =
                new CreateCompactionResponse(runId, eventId);
        return new CommandResult(response, List.of(event));
    }

    private ObjectNode payload(CompactionView view, JsonNode boundary) {
        ObjectNode payload = objectMapper.createObjectNode();
        payload.set("compaction", objectMapper.valueToTree(view));
        if (boundary == null) {
            payload.putNull("boundary");
        } else {
            payload.set("boundary", boundary);
        }
        return payload;
    }

    private CreateCompactionResponse replay(
            ConversationRepository.IdempotencyRecord record,
            String requestHash
    ) {
        if (!record.requestHash().equals(requestHash)) {
            throw problem(
                    HttpStatus.CONFLICT,
                    "idempotency_key_reused",
                    "这个幂等键已经用于不同的请求。"
            );
        }
        try {
            return objectMapper.readValue(
                    record.responseJson(),
                    CreateCompactionResponse.class
            );
        } catch (JsonProcessingException exception) {
            throw new IllegalStateException(
                    "Stored compaction response cannot be read",
                    exception
            );
        }
    }

    private ApiProblemException problem(
            HttpStatus status,
            String code,
            String message
    ) {
        return new ApiProblemException(
                status,
                code,
                status.is4xxClientError() ? "precondition" : "internal",
                message
        );
    }

    private void requireIdempotencyKey(String key) {
        if (key == null || key.isBlank() || key.length() > 200) {
            throw problem(
                    HttpStatus.BAD_REQUEST,
                    "invalid_request",
                    "缺少合法的 Idempotency-Key。"
            );
        }
    }

    private String hash(Object value) {
        try {
            return HexFormat.of().formatHex(
                    MessageDigest.getInstance("SHA-256").digest(
                            write(value).getBytes(StandardCharsets.UTF_8)
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
            throw new IllegalArgumentException(
                    "Compaction command cannot be serialized",
                    exception
            );
        }
    }

    private String id(String prefix) {
        return prefix + "_" + UUID.randomUUID().toString().replace("-", "");
    }

    private record CommandResult(
            CreateCompactionResponse response,
            List<ConversationEvent> events
    ) {
    }
}
