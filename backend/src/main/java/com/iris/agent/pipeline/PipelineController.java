package com.iris.agent.pipeline;

import com.fasterxml.jackson.databind.JsonNode;
import com.iris.agent.pipeline.PipelineCommandService.PipelineAcceptance;
import jakarta.validation.Valid;
import jakarta.validation.constraints.NotNull;
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

/** Unified UI/button entry into the same versioned Pipeline runtime. */
@RestController
@RequestMapping("/api/v1")
public class PipelineController {
    private final PipelineCommandService commands;
    private final PipelineRunLauncher launcher;

    public PipelineController(
            PipelineCommandService commands,
            PipelineRunLauncher launcher
    ) {
        this.commands = commands;
        this.launcher = launcher;
    }

    @PostMapping("/runs/{parentRunId}/pipelines/{definitionId}")
    public Mono<ResponseEntity<PipelineAcceptance>> invoke(
            @PathVariable String parentRunId,
            @PathVariable String definitionId,
            @RequestHeader("Idempotency-Key") String idempotencyKey,
            @Valid @RequestBody PipelineInvocationRequest request
    ) {
        return Mono.fromCallable(() -> commands.createChild(
                        definitionId,
                        request.input(),
                        parentRunId,
                        "ui_action",
                        "ui:" + idempotencyKey,
                        "user"
                ))
                .subscribeOn(Schedulers.boundedElastic())
                .doOnNext(accepted -> launcher.launch(accepted.runId()))
                .map(accepted -> ResponseEntity
                        .status(HttpStatus.ACCEPTED)
                        .body(accepted));
    }

    public record PipelineInvocationRequest(
            @NotNull JsonNode input
    ) { }
}
