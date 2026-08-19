package com.iris.conversation.api;

import com.iris.conversation.application.RunCommandService;
import com.iris.conversation.domain.RunCommands.RunMessageView;
import com.iris.conversation.domain.RunCommands.SendRunMessageRequest;
import com.iris.conversation.domain.RunCommands.StopRunRequest;
import com.iris.conversation.domain.RunCommands.StopRunView;
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
@RequestMapping("/api/v1/runs/{runId}")
public class RunController {
    private final RunCommandService commands;

    public RunController(RunCommandService commands) {
        this.commands = commands;
    }

    @PostMapping("/messages")
    public Mono<ResponseEntity<RunMessageView>> sendMessage(
            @PathVariable String runId,
            @RequestHeader("Idempotency-Key") String idempotencyKey,
            @Valid @RequestBody SendRunMessageRequest request
    ) {
        return Mono.fromCallable(() ->
                        commands.sendMessage(runId, idempotencyKey, request)
                )
                .subscribeOn(Schedulers.boundedElastic())
                .map(view -> ResponseEntity
                        .status(HttpStatus.ACCEPTED)
                        .body(view));
    }

    @PostMapping("/stop")
    public Mono<ResponseEntity<StopRunView>> stop(
            @PathVariable String runId,
            @RequestHeader("Idempotency-Key") String idempotencyKey,
            @Valid @RequestBody StopRunRequest request
    ) {
        return Mono.fromCallable(() ->
                        commands.stopRun(runId, idempotencyKey, request)
                )
                .subscribeOn(Schedulers.boundedElastic())
                .map(view -> ResponseEntity
                        .status(HttpStatus.ACCEPTED)
                        .body(view));
    }
}
