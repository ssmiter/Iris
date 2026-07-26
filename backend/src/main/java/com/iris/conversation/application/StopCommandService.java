package com.iris.conversation.application;

import com.fasterxml.jackson.core.JsonProcessingException;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.iris.agent.run.AgentRunLauncher;
import com.iris.conversation.domain.ApiProblemException;
import com.iris.conversation.domain.StopCommands.StopTurnRequest;
import com.iris.conversation.domain.StopCommands.StopView;
import com.iris.conversation.infrastructure.ConversationRepository;
import com.iris.conversation.infrastructure.SupplementRepository;
import com.iris.conversation.infrastructure.SupplementRepository.TurnContext;
import com.iris.conversation.infrastructure.TurnStopRepository;
import org.springframework.http.HttpStatus;
import org.springframework.stereotype.Service;
import org.springframework.transaction.support.TransactionTemplate;

import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.security.NoSuchAlgorithmException;
import java.time.Clock;
import java.time.Instant;
import java.util.HexFormat;
import java.util.UUID;

@Service
public class StopCommandService {
    private static final String ENDPOINT =
            "POST:/api/v1/turns/{turnId}/stop";

    private final TurnStopRepository stops;
    private final SupplementRepository supplements;
    private final ConversationRepository conversations;
    private final ConversationLocks locks;
    private final TransactionTemplate transactions;
    private final RunEventEmitter lifecycleEvents;
    private final AgentRunLauncher launcher;
    private final ObjectMapper objectMapper;
    private final Clock clock = Clock.systemUTC();

    public StopCommandService(
            TurnStopRepository stops,
            SupplementRepository supplements,
            ConversationRepository conversations,
            ConversationLocks locks,
            TransactionTemplate transactions,
            RunEventEmitter lifecycleEvents,
            AgentRunLauncher launcher,
            ObjectMapper objectMapper
    ) {
        this.stops = stops;
        this.supplements = supplements;
        this.conversations = conversations;
        this.locks = locks;
        this.transactions = transactions;
        this.lifecycleEvents = lifecycleEvents;
        this.launcher = launcher;
        this.objectMapper = objectMapper;
    }

    public StopView request(
            String turnId,
            String idempotencyKey,
            StopTurnRequest request
    ) {
        requireKey(idempotencyKey);
        TurnContext turn = supplements.turnContext(turnId).orElseThrow(() ->
                new ApiProblemException(
                        HttpStatus.NOT_FOUND, "turn_not_found", "not_found",
                        "找不到这个对话轮次。"
                )
        );
        String requestHash = hash(request);
        StopView view = locks.withLock(turn.conversationId(), () ->
                transactions.execute(status -> conversations
                        .findIdempotency(turnId, ENDPOINT, idempotencyKey)
                        .map(record -> replay(record, requestHash))
                        .orElseGet(() -> requestOnce(
                                turn,
                                idempotencyKey,
                                requestHash,
                                request.reason().trim()
                        )))
        );
        if (view == null) {
            throw new IllegalStateException(
                    "Stop transaction returned no result"
            );
        }
        lifecycleEvents.turnUpdated(turnId);
        launcher.requestStop(turn.rootRunId());
        return view;
    }

    private StopView requestOnce(
            TurnContext turn,
            String idempotencyKey,
            String requestHash,
            String reason
    ) {
        turn = supplements.turnContext(turn.turnId()).orElseThrow(() ->
                new ApiProblemException(
                        HttpStatus.NOT_FOUND, "turn_not_found", "not_found",
                        "找不到这个对话轮次。"
                )
        );
        StopView existing = stops.findByTurn(turn.turnId()).orElse(null);
        if (existing != null) {
            if (!existing.reason().equals(reason)) {
                throw new ApiProblemException(
                        HttpStatus.CONFLICT,
                        "stop_already_requested",
                        "precondition",
                        "这个轮次已经收到另一条停止请求。"
                );
            }
            persistIdempotency(
                    turn.turnId(), idempotencyKey,
                    requestHash, existing, clock.instant()
            );
            return existing;
        }
        if (!"active".equals(turn.phase()) && !"queued".equals(turn.phase())) {
            throw new ApiProblemException(
                    HttpStatus.CONFLICT,
                    "turn_not_active",
                    "precondition",
                    "这个轮次已经结束。"
            );
        }
        Instant now = clock.instant();
        stops.insert(id("stop"), turn, reason, now);
        conversations.incrementConversationVersion(
                turn.conversationId(), now
        );
        StopView created = stops.findByTurn(turn.turnId()).orElseThrow();
        persistIdempotency(
                turn.turnId(), idempotencyKey,
                requestHash, created, now
        );
        return created;
    }

    private void persistIdempotency(
            String turnId,
            String key,
            String requestHash,
            StopView view,
            Instant now
    ) {
        conversations.insertIdempotency(
                turnId, ENDPOINT, key, requestHash,
                HttpStatus.ACCEPTED.value(), write(view), now
        );
    }

    private StopView replay(
            ConversationRepository.IdempotencyRecord record,
            String requestHash
    ) {
        if (!record.requestHash().equals(requestHash)) {
            throw new ApiProblemException(
                    HttpStatus.CONFLICT,
                    "idempotency_key_reused",
                    "conflict",
                    "这个幂等键已经用于不同请求。"
            );
        }
        try {
            return objectMapper.readValue(
                    record.responseJson(), StopView.class
            );
        } catch (JsonProcessingException exception) {
            throw new IllegalStateException(
                    "Stored stop response is invalid", exception
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
            throw new IllegalStateException("SHA-256 is unavailable", exception);
        }
    }

    private String write(Object value) {
        try {
            return objectMapper.writeValueAsString(value);
        } catch (JsonProcessingException exception) {
            throw new IllegalArgumentException(
                    "Stop request cannot be serialized", exception
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
}
