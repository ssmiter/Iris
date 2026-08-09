package com.iris.agent.pipeline;

import com.fasterxml.jackson.databind.JsonNode;
import com.iris.agent.pipeline.PipelineCommandService.PipelineAcceptance;
import jakarta.validation.Valid;
import jakarta.validation.constraints.NotNull;
import org.springframework.http.HttpStatus;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.GetMapping;
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
    private final PipelineRunRepository runs;

    public PipelineController(
            PipelineCommandService commands,
            PipelineRunLauncher launcher,
            PipelineRunRepository runs
    ) {
        this.commands = commands;
        this.launcher = launcher;
        this.runs = runs;
    }

    @GetMapping("/pipeline-runs/{runId}")
    public Mono<PipelineRunView> view(@PathVariable String runId) {
        return Mono.fromCallable(() -> {
                    var run = runs.find(runId).orElseThrow(() ->
                            new IllegalArgumentException(
                                    "Pipeline Run not found"
                            )
                    );
                    var steps = runs.steps(runId);
                    JsonNode output = steps.isEmpty()
                            ? null
                            : steps.get(steps.size() - 1).output();
                    return new PipelineRunView(
                            run.runId(),
                            run.parentRunId(),
                            run.definitionId(),
                            run.definitionVersion(),
                            run.phase().name().toLowerCase(),
                            steps,
                            output
                    );
                })
                .subscribeOn(Schedulers.boundedElastic());
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

    public record PipelineRunView(
            String runId,
            String parentRunId,
            String definitionId,
            String definitionVersion,
            String phase,
            java.util.List<PipelineRunRepository.StepRun> steps,
            JsonNode output
    ) { }
}
