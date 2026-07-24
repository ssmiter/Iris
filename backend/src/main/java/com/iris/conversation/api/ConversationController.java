package com.iris.conversation.api;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.iris.conversation.application.ConversationCommandService;
import com.iris.conversation.application.ConversationEventStreamService;
import com.iris.conversation.application.ConversationQueryService;
import com.iris.conversation.domain.ConversationCommands.CreateConversationRequest;
import com.iris.conversation.domain.ConversationCommands.CreateConversationResponse;
import com.iris.conversation.domain.ConversationCommands.CreateTurnRequest;
import com.iris.conversation.domain.ConversationCommands.TurnAcceptance;
import com.iris.conversation.domain.ConversationViews.ConversationPage;
import com.iris.conversation.domain.ConversationViews.ConversationView;
import com.iris.conversation.domain.ConversationViews.RenameConversationRequest;
import com.iris.conversation.domain.ConversationViews.RenameConversationResponse;
import com.iris.agent.run.AgentRunLauncher;
import jakarta.validation.Valid;
import org.springframework.http.CacheControl;
import org.springframework.http.HttpHeaders;
import org.springframework.http.HttpStatus;
import org.springframework.http.MediaType;
import org.springframework.http.ResponseEntity;
import org.springframework.http.codec.ServerSentEvent;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.PatchMapping;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestHeader;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RequestParam;
import org.springframework.web.bind.annotation.RestController;
import reactor.core.publisher.Flux;
import reactor.core.publisher.Mono;
import reactor.core.scheduler.Schedulers;

import java.time.Duration;

@RestController
@RequestMapping("/api/v1")
public class ConversationController {
    private final ConversationCommandService commands;
    private final ConversationEventStreamService eventStream;
    private final ConversationQueryService queries;
    private final ObjectMapper objectMapper;
    private final AgentRunLauncher agentRuns;

    public ConversationController(
            ConversationCommandService commands,
            ConversationEventStreamService eventStream,
            ConversationQueryService queries,
            ObjectMapper objectMapper,
            AgentRunLauncher agentRuns
    ) {
        this.commands = commands;
        this.eventStream = eventStream;
        this.queries = queries;
        this.objectMapper = objectMapper;
        this.agentRuns = agentRuns;
    }

    @GetMapping("/conversations")
    public Mono<ConversationPage> listConversations(
            @RequestParam(value = "cursor", required = false) String cursor,
            @RequestParam(value = "limit", defaultValue = "30") int limit
    ) {
        return queries.list(cursor, limit);
    }

    @GetMapping("/conversations/{conversationId}/view")
    public Mono<ConversationView> conversationView(
            @PathVariable String conversationId,
            @RequestParam(value = "branchId", required = false) String branchId,
            @RequestParam(value = "beforeTurnId", required = false)
            String beforeTurnId,
            @RequestParam(value = "limit", defaultValue = "50") int limit
    ) {
        return queries.view(conversationId, branchId, beforeTurnId, limit);
    }

    @PatchMapping("/conversations/{conversationId}")
    public Mono<RenameConversationResponse> renameConversation(
            @PathVariable String conversationId,
            @RequestHeader("Idempotency-Key") String idempotencyKey,
            @RequestBody RenameConversationRequest request
    ) {
        return Mono.fromCallable(() -> commands.renameConversation(
                        conversationId,
                        idempotencyKey,
                        request
                ))
                .subscribeOn(Schedulers.boundedElastic());
    }

    @PostMapping("/conversations")
    public Mono<ResponseEntity<CreateConversationResponse>> createConversation(
            @RequestHeader("Idempotency-Key") String idempotencyKey,
            @RequestBody(required = false) CreateConversationRequest request
    ) {
        CreateConversationRequest safeRequest =
                request == null ? new CreateConversationRequest(null) : request;
        return Mono.fromCallable(() ->
                        commands.createConversation(idempotencyKey, safeRequest)
                )
                .subscribeOn(Schedulers.boundedElastic())
                .map(response -> ResponseEntity
                        .status(HttpStatus.CREATED)
                        .body(response));
    }

    @PostMapping("/conversations/{conversationId}/turns")
    public Mono<ResponseEntity<TurnAcceptance>> createTurn(
            @PathVariable String conversationId,
            @RequestHeader("Idempotency-Key") String idempotencyKey,
            @Valid @RequestBody CreateTurnRequest request
    ) {
        return Mono.fromCallable(() ->
                        commands.acceptTurn(conversationId, idempotencyKey, request)
                )
                .subscribeOn(Schedulers.boundedElastic())
                .doOnNext(response ->
                        agentRuns.launch(response.rootRunId()))
                .map(response -> ResponseEntity
                        .status(HttpStatus.ACCEPTED)
                        .body(response));
    }

    @GetMapping(
            value = "/conversations/{conversationId}/events",
            produces = MediaType.TEXT_EVENT_STREAM_VALUE
    )
    public Mono<ResponseEntity<Flux<ServerSentEvent<JsonNode>>>> events(
            @PathVariable String conversationId,
            @RequestHeader(value = "Last-Event-ID", required = false)
            String lastEventId,
            @RequestParam(value = "after", required = false) String after
    ) {
        String cursor = lastEventId == null || lastEventId.isBlank()
                ? after
                : lastEventId;
        return eventStream.resolveStart(conversationId, cursor)
                .map(start -> {
                    Flux<ServerSentEvent<JsonNode>> businessEvents =
                            eventStream.stream(conversationId, start)
                                    .map(event -> ServerSentEvent
                                            .<JsonNode>builder()
                                            .id(event.eventId())
                                            .event(event.eventType())
                                            .data(objectMapper.valueToTree(
                                                    event.envelope()
                                            ))
                                            .build());
                    Flux<ServerSentEvent<JsonNode>> heartbeat =
                            Flux.interval(Duration.ofSeconds(15))
                                    .map(ignored -> ServerSentEvent
                                            .<JsonNode>builder()
                                            .comment("keepalive")
                                            .build());
                    return ResponseEntity.ok()
                            .contentType(MediaType.TEXT_EVENT_STREAM)
                            .cacheControl(CacheControl.noStore())
                            .header("X-Content-Type-Options", "nosniff")
                            .body(Flux.merge(businessEvents, heartbeat));
                });
    }
}
