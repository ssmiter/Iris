package com.iris.conversation.application;

import com.fasterxml.jackson.core.JsonProcessingException;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.node.ObjectNode;
import com.iris.artifact.ArtifactService;
import com.iris.conversation.domain.ApiProblemException;
import com.iris.conversation.domain.ConversationEvent;
import com.iris.conversation.domain.SupplementCommands.CreateSupplementRequest;
import com.iris.conversation.domain.SupplementCommands.SupplementView;
import com.iris.conversation.infrastructure.ConversationEventHub;
import com.iris.conversation.infrastructure.ConversationRepository;
import com.iris.conversation.infrastructure.SupplementRepository;
import com.iris.conversation.infrastructure.SupplementRepository.SupplementRow;
import com.iris.conversation.infrastructure.SupplementRepository.TurnContext;
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
public class SupplementCommandService {
    private static final String CREATE_ENDPOINT =
            "POST:/api/v1/turns/{turnId}/supplements";
    private static final String CANCEL_ENDPOINT =
            "POST:/api/v1/turns/{turnId}/supplements/{supplementId}/cancel";

    private final SupplementRepository supplements;
    private final ConversationRepository conversations;
    private final ConversationEventHub eventHub;
    private final ConversationLocks locks;
    private final TransactionTemplate transactions;
    private final ObjectMapper objectMapper;
    private final ArtifactService artifacts;
    private final Clock clock = Clock.systemUTC();

    public SupplementCommandService(
            SupplementRepository supplements,
            ConversationRepository conversations,
            ConversationEventHub eventHub,
            ConversationLocks locks,
            TransactionTemplate transactions,
            ObjectMapper objectMapper,
            ArtifactService artifacts
    ) {
        this.supplements = supplements;
        this.conversations = conversations;
        this.eventHub = eventHub;
        this.locks = locks;
        this.transactions = transactions;
        this.objectMapper = objectMapper;
        this.artifacts = artifacts;
    }

    public SupplementView create(
            String turnId,
            String idempotencyKey,
            CreateSupplementRequest request
    ) {
        requireKey(idempotencyKey);
        String requestHash = hash(request);
        TurnContext turn = requireTurn(turnId);
        requireAttachments(
                turn.conversationId(),
                request.attachmentRefs()
        );
        CommandResult result = locks.withLock(turn.conversationId(), () ->
                transactions.execute(status -> conversations
                        .findIdempotency(turnId, CREATE_ENDPOINT, idempotencyKey)
                        .map(record -> new CommandResult(
                                replay(record, requestHash),
                                null
                        ))
                        .orElseGet(() -> createOnce(
                                turn, idempotencyKey, requestHash, request
                        )))
        );
        return publish(result);
    }

    public SupplementView cancel(
            String turnId,
            String supplementId,
            String idempotencyKey
    ) {
        requireKey(idempotencyKey);
        String requestHash = hash(turnId + ":" + supplementId);
        SupplementRow located = supplements.find(supplementId).orElseThrow(() ->
                new ApiProblemException(
                        HttpStatus.NOT_FOUND, "supplement_not_found", "not_found",
                        "找不到这条补充内容。"
                )
        );
        CommandResult result = locks.withLock(located.conversationId(), () ->
                transactions.execute(status -> conversations
                        .findIdempotency(
                                supplementId, CANCEL_ENDPOINT, idempotencyKey
                        )
                        .map(record -> new CommandResult(
                                replay(record, requestHash),
                                null
                        ))
                        .orElseGet(() -> cancelOnce(
                                turnId, supplementId,
                                idempotencyKey, requestHash
                        )))
        );
        return publish(result);
    }

    private CommandResult createOnce(
            TurnContext turn,
            String idempotencyKey,
            String requestHash,
            CreateSupplementRequest request
    ) {
        TurnContext current = requireTurn(turn.turnId());
        if (!"active".equals(current.phase())
                && !"queued".equals(current.phase())) {
            throw new ApiProblemException(
                    HttpStatus.CONFLICT, "turn_not_active", "precondition",
                    "这个轮次已经结束，不能再排入补充内容。"
            );
        }
        Instant now = clock.instant();
        String supplementId = id("supplement");
        supplements.insertPending(
                supplementId,
                current,
                request.text().trim(),
                request.attachmentRefs(),
                now
        );
        SupplementView view = supplements.find(supplementId).orElseThrow().view();
        ConversationEvent event = event(current, view, now);
        conversations.insertEvent(event);
        conversations.incrementConversationVersion(
                current.conversationId(),
                now
        );
        conversations.insertIdempotency(
                turn.turnId(), CREATE_ENDPOINT, idempotencyKey, requestHash,
                HttpStatus.ACCEPTED.value(), write(view), now
        );
        return new CommandResult(view, event);
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
                    "每条补充最多附加 16 个不重复的文件。"
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

    private CommandResult cancelOnce(
            String turnId,
            String supplementId,
            String idempotencyKey,
            String requestHash
    ) {
        SupplementRow current = supplements.find(supplementId).orElseThrow(() ->
                new ApiProblemException(
                        HttpStatus.NOT_FOUND, "supplement_not_found", "not_found",
                        "找不到这条补充内容。"
                )
        );
        if (!turnId.equals(current.turnId())) {
            throw new ApiProblemException(
                    HttpStatus.NOT_FOUND, "supplement_not_found", "not_found",
                    "找不到这条补充内容。"
            );
        }
        if ("injected".equals(current.phase())) {
            throw new ApiProblemException(
                    HttpStatus.CONFLICT,
                    "supplement_already_injected",
                    "precondition",
                    "这条补充已经进入模型上下文，不能撤回。"
            );
        }
        Instant now = clock.instant();
        if ("pending".equals(current.phase())
                && !supplements.cancel(
                        supplementId, current.version(), now
                )) {
            throw new ApiProblemException(
                    HttpStatus.CONFLICT, "stale_version", "conflict",
                    "补充状态已经变化，请刷新后重试。"
            );
        }
        SupplementRow updated = supplements.find(supplementId).orElseThrow();
        TurnContext turn = supplements.turnContext(turnId).orElseThrow();
        SupplementView view = updated.view();
        ConversationEvent event = event(turn, view, now);
        conversations.insertEvent(event);
        conversations.incrementConversationVersion(turn.conversationId(), now);
        conversations.insertIdempotency(
                supplementId, CANCEL_ENDPOINT, idempotencyKey, requestHash,
                HttpStatus.OK.value(), write(view), now
        );
        return new CommandResult(view, event);
    }

    private ConversationEvent event(
            TurnContext turn,
            SupplementView view,
            Instant now
    ) {
        ObjectNode payload = objectMapper.createObjectNode();
        payload.set("supplement", objectMapper.valueToTree(view));
        return new ConversationEvent(
                1, id("evt"), "supplement.updated",
                turn.conversationId(), turn.branchId(), turn.turnId(),
                turn.rootRunId(), null,
                conversations.nextEventSequence(turn.conversationId()),
                new ConversationEvent.AggregateRef(
                        "supplement", view.supplementId(), view.version()
                ),
                null, view.supplementId(), now, payload
        );
    }

    private SupplementView publish(CommandResult result) {
        if (result == null) {
            throw new IllegalStateException(
                    "Supplement transaction returned no result"
            );
        }
        if (result.event() != null) {
            eventHub.publish(List.of(result.event()));
        }
        return result.view();
    }

    private TurnContext requireTurn(String turnId) {
        return supplements.turnContext(turnId).orElseThrow(() ->
                new ApiProblemException(
                        HttpStatus.NOT_FOUND, "turn_not_found", "not_found",
                        "找不到这个对话轮次。"
                )
        );
    }

    private SupplementView replay(
            ConversationRepository.IdempotencyRecord record,
            String requestHash
    ) {
        if (!record.requestHash().equals(requestHash)) {
            throw new ApiProblemException(
                    HttpStatus.CONFLICT, "idempotency_key_reused", "conflict",
                    "这个幂等键已经用于不同请求。"
            );
        }
        try {
            return objectMapper.readValue(
                    record.responseJson(), SupplementView.class
            );
        } catch (JsonProcessingException exception) {
            throw new IllegalStateException(
                    "Stored supplement response is invalid", exception
            );
        }
    }

    private String hash(Object value) {
        try {
            byte[] digest = MessageDigest.getInstance("SHA-256").digest(
                    write(value).getBytes(StandardCharsets.UTF_8)
            );
            return HexFormat.of().formatHex(digest);
        } catch (NoSuchAlgorithmException exception) {
            throw new IllegalStateException("SHA-256 is unavailable", exception);
        }
    }

    private String write(Object value) {
        try {
            return objectMapper.writeValueAsString(value);
        } catch (JsonProcessingException exception) {
            throw new IllegalArgumentException(
                    "Supplement request cannot be serialized", exception
            );
        }
    }

    private void requireKey(String key) {
        if (key == null || key.isBlank() || key.length() > 200) {
            throw new ApiProblemException(
                    HttpStatus.BAD_REQUEST, "invalid_request", "validation",
                    "缺少有效的 Idempotency-Key。"
            );
        }
    }

    private String id(String prefix) {
        return prefix + "_" + UUID.randomUUID().toString().replace("-", "");
    }

    private record CommandResult(
            SupplementView view,
            ConversationEvent event
    ) {
    }
}
