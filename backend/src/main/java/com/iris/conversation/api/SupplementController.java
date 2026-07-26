package com.iris.conversation.api;

import com.iris.conversation.application.SupplementCommandService;
import com.iris.conversation.domain.SupplementCommands.CreateSupplementRequest;
import com.iris.conversation.domain.SupplementCommands.SupplementView;
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
@RequestMapping("/api/v1/turns/{turnId}/supplements")
public class SupplementController {
    private final SupplementCommandService commands;

    public SupplementController(SupplementCommandService commands) {
        this.commands = commands;
    }

    @PostMapping
    public Mono<ResponseEntity<SupplementView>> create(
            @PathVariable String turnId,
            @RequestHeader("Idempotency-Key") String idempotencyKey,
            @Valid @RequestBody CreateSupplementRequest request
    ) {
        return Mono.fromCallable(() ->
                        commands.create(turnId, idempotencyKey, request)
                )
                .subscribeOn(Schedulers.boundedElastic())
                .map(view -> ResponseEntity
                        .status(HttpStatus.ACCEPTED)
                        .body(view));
    }

    @PostMapping("/{supplementId}/cancel")
    public Mono<SupplementView> cancel(
            @PathVariable String turnId,
            @PathVariable String supplementId,
            @RequestHeader("Idempotency-Key") String idempotencyKey
    ) {
        return Mono.fromCallable(() ->
                        commands.cancel(
                                turnId, supplementId, idempotencyKey
                        )
                )
                .subscribeOn(Schedulers.boundedElastic());
    }
}
