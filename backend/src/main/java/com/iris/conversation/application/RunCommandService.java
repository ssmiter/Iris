package com.iris.conversation.application;

import com.fasterxml.jackson.core.JsonProcessingException;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.iris.agent.run.AgentRunContextRepository;
import com.iris.agent.run.AgentRunLauncher;
import com.iris.agent.run.RunMailboxEventEmitter;
import com.iris.agent.run.RunMailboxRepository;
import com.iris.agent.run.RunRoundRepository;
import com.iris.conversation.domain.ApiProblemException;
import com.iris.conversation.domain.RunCommands.RunMessageView;
import com.iris.conversation.domain.RunCommands.SendRunMessageRequest;
import com.iris.conversation.domain.RunCommands.StopRunRequest;
import com.iris.conversation.domain.RunCommands.StopRunView;
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

/**
 * 子 Run 级命令服务：向运行中的子 Agent 补充消息、请求停止子 Run。
 * 复用 AgentRunLauncher/RunMailboxRepository 的既有生命周期，不引入第二套状态机。
 */
@Service
public class RunCommandService {
    private static final String MESSAGE_ENDPOINT =
            "POST:/api/v1/runs/{runId}/messages";
    private static final String STOP_ENDPOINT =
            "POST:/api/v1/runs/{runId}/stop";

    private final RunRoundRepository runs;
    private final AgentRunContextRepository contexts;
    private final RunMailboxRepository mailbox;
    private final RunMailboxEventEmitter mailboxEvents;
    private final AgentRunLauncher launcher;
    private final ConversationRepository conversations;
    private final ConversationLocks locks;
    private final RunEventEmitter lifecycleEvents;
    private final TransactionTemplate transactions;
    private final ObjectMapper objectMapper;
    private final Clock clock = Clock.systemUTC();

    public RunCommandService(
            RunRoundRepository runs,
            AgentRunContextRepository contexts,
            RunMailboxRepository mailbox,
            RunMailboxEventEmitter mailboxEvents,
            AgentRunLauncher launcher,
            ConversationRepository conversations,
            ConversationLocks locks,
            RunEventEmitter lifecycleEvents,
            TransactionTemplate transactions,
            ObjectMapper objectMapper
    ) {
        this.runs = runs;
        this.contexts = contexts;
        this.mailbox = mailbox;
        this.mailboxEvents = mailboxEvents;
        this.launcher = launcher;
        this.conversations = conversations;
        this.locks = locks;
        this.lifecycleEvents = lifecycleEvents;
        this.transactions = transactions;
        this.objectMapper = objectMapper;
    }

    public RunMessageView sendMessage(
            String runId,
            String idempotencyKey,
            SendRunMessageRequest request
    ) {
        requireKey(idempotencyKey);
        var run = requireRun(runId);
        if (run.phase().terminal()) {
            throw new ApiProblemException(
                    HttpStatus.CONFLICT,
                    "run_already_terminal",
                    "precondition",
                    "目标 Run 已经结束，不能继续补充消息。"
            );
        }
        if (contexts.find(runId).isEmpty()) {
            throw new ApiProblemException(
                    HttpStatus.NOT_FOUND,
                    "run_not_found",
                    "not_found",
                    "找不到这个隔离子 Agent Run。"
            );
        }
        String requestHash = hash(request);
        return locks.withLock(run.conversationId(), () ->
                transactions.execute(status -> conversations
                        .findIdempotency(runId, MESSAGE_ENDPOINT, idempotencyKey)
                        .map(record -> replayMessage(record, requestHash))
                        .orElseGet(() -> sendMessageOnce(
                                runId, request, idempotencyKey, requestHash
                        )))
        );
    }

    public StopRunView stopRun(
            String runId,
            String idempotencyKey,
            StopRunRequest request
    ) {
        requireKey(idempotencyKey);
        var run = requireRun(runId);
        String requestHash = hash(request);
        return locks.withLock(run.conversationId(), () ->
                transactions.execute(status -> conversations
                        .findIdempotency(runId, STOP_ENDPOINT, idempotencyKey)
                        .map(record -> replayStop(record, requestHash))
                        .orElseGet(() -> stopRunOnce(
                                runId, request, idempotencyKey, requestHash
                        )))
        );
    }

    private RunMessageView sendMessageOnce(
            String runId,
            SendRunMessageRequest request,
            String idempotencyKey,
            String requestHash
    ) {
        var run = requireRun(runId);
        if (run.phase().terminal()) {
            throw new ApiProblemException(
                    HttpStatus.CONFLICT,
                    "run_already_terminal",
                    "precondition",
                    "目标 Run 已经结束，不能继续补充消息。"
            );
        }
        Instant now = clock.instant();
        var message = mailbox.enqueue(
                runId,
                null,
                "instruction",
                request.text().trim(),
                objectMapper.createObjectNode(),
                now
        );
        mailboxEvents.queued(message);
        launcher.launch(runId);
        RunMessageView view = new RunMessageView(
                message.messageId(),
                runId,
                message.phase(),
                message.content()
        );
        conversations.incrementConversationVersion(
                run.conversationId(), now
        );
        conversations.insertIdempotency(
                runId, MESSAGE_ENDPOINT, idempotencyKey, requestHash,
                HttpStatus.ACCEPTED.value(), write(view), now
        );
        return view;
    }

    private StopRunView stopRunOnce(
            String runId,
            StopRunRequest request,
            String idempotencyKey,
            String requestHash
    ) {
        var run = requireRun(runId);
        if (run.phase().terminal()) {
            return new StopRunView(
                    runId,
                    run.phase().name().toLowerCase(),
                    false,
                    "目标 Run 已经结束，没有重复发送停止信号。"
            );
        }
        boolean accepted = launcher.requestStop(runId);
        String phase = accepted ? "cancellation_requested"
                : run.phase().name().toLowerCase();
        String message = accepted
                ? "停止信号已写入运行时；最终状态和部分结果会随后通知。"
                : "停止信号未能下发，运行可能已经结束。";
        StopRunView view = new StopRunView(runId, phase, accepted, message);
        Instant now = clock.instant();
        conversations.incrementConversationVersion(
                run.conversationId(), now
        );
        conversations.insertIdempotency(
                runId, STOP_ENDPOINT, idempotencyKey, requestHash,
                HttpStatus.ACCEPTED.value(), write(view), now
        );
        lifecycleEvents.runUpdated(runId);
        return view;
    }

    private RunRoundRepository.RunRow requireRun(String runId) {
        return runs.findRun(runId).orElseThrow(() ->
                new ApiProblemException(
                        HttpStatus.NOT_FOUND,
                        "run_not_found",
                        "not_found",
                        "找不到这个 Run。"
                )
        );
    }

    private RunMessageView replayMessage(
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
                    record.responseJson(), RunMessageView.class
            );
        } catch (JsonProcessingException exception) {
            throw new IllegalStateException(
                    "Stored run message response is invalid", exception
            );
        }
    }

    private StopRunView replayStop(
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
                    record.responseJson(), StopRunView.class
            );
        } catch (JsonProcessingException exception) {
            throw new IllegalStateException(
                    "Stored run stop response is invalid", exception
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
                    "Run command cannot be serialized", exception
            );
        }
    }

    private void requireKey(String key) {
        if (key == null || key.isBlank() || key.length() > 200) {
            throw new ApiProblemException(
                    HttpStatus.BAD_REQUEST,
                    "invalid_request",
                    "validation",
                    "缺少有效的 Idempotency-Key。"
            );
        }
    }
}
