package com.iris.conversation.api;

import com.iris.conversation.application.StopCommandService;
import com.iris.conversation.domain.StopCommands.StopTurnRequest;
import com.iris.conversation.domain.StopCommands.StopView;
import jakarta.validation.Valid;
import org.springframework.http.HttpStatus;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestHeader;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RestController;
import reactor.core.publisher.Mono;
import reactor.core.scheduler.Schedulers;

@RestController
@RequestMapping("/api/v1/turns/{turnId}/stop")
public class StopController {
    private final StopCommandService commands;

    public StopController(StopCommandService commands) {
        this.commands = commands;
    }

    @PostMapping
    public Mono<ResponseEntity<StopView>> stop(
            @PathVariable String turnId,
            @RequestHeader("Idempotency-Key") String idempotencyKey,
            @Valid @RequestBody StopTurnRequest request
    ) {
        return Mono.fromCallable(() ->
                        commands.request(turnId, idempotencyKey, request)
                )
                .subscribeOn(Schedulers.boundedElastic())
                .map(view -> ResponseEntity
                        .status(HttpStatus.ACCEPTED)
                        .body(view));
    }
}
