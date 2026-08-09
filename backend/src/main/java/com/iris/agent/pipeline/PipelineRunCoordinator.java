package com.iris.agent.pipeline;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.node.ObjectNode;
import com.iris.agent.pipeline.PipelineDefinition.ChildAgentStep;
import com.iris.agent.pipeline.PipelineDefinition.ModelTransformStep;
import com.iris.agent.pipeline.PipelineDefinition.PublishConversationTitleStep;
import com.iris.agent.pipeline.PipelineRunRepository.PipelineRun;
import com.iris.agent.pipeline.PipelineRunRepository.StepRun;
import com.iris.agent.run.AgentRunLauncher;
import com.iris.agent.run.AgentRunResultRepository;
import com.iris.agent.run.ChildAgentRunService;
import com.iris.agent.run.RunPhase;
import com.iris.agent.run.RunRoundRepository;
import com.iris.agent.run.RunRoundService;
import com.iris.conversation.domain.ConversationViews.FailureView;
import com.iris.conversation.application.GeneratedConversationTitleService;
import com.iris.tools.core.ToolInputValidator;
import org.springframework.stereotype.Service;
import reactor.core.publisher.Mono;
import reactor.core.scheduler.Schedulers;

import java.time.Clock;
import java.util.UUID;

/** Advances code-defined serial Pipelines to a child wait or terminal fact. */
@Service
public class PipelineRunCoordinator {
    private static final int MAX_HANDOFF_CHARS = 12_000;
    private final PipelineRunRepository pipelines;
    private final PipelineDefinitionRegistry definitions;
    private final ChildAgentRunService childAgents;
    private final AgentRunLauncher agentRuns;
    private final RunRoundRepository runFacts;
    private final AgentRunResultRepository childResults;
    private final RunRoundService runStates;
    private final ObjectMapper objectMapper;
    private final ToolInputValidator schemaValidator;
    private final PipelineValueResolver values;
    private final GeneratedConversationTitleService generatedTitles;
    private final Clock clock = Clock.systemUTC();

    public PipelineRunCoordinator(
            PipelineRunRepository pipelines,
            PipelineDefinitionRegistry definitions,
            ChildAgentRunService childAgents,
            AgentRunLauncher agentRuns,
            RunRoundRepository runFacts,
            AgentRunResultRepository childResults,
            RunRoundService runStates,
            ObjectMapper objectMapper,
            ToolInputValidator schemaValidator,
            PipelineValueResolver values,
            GeneratedConversationTitleService generatedTitles
    ) {
        this.pipelines = pipelines;
        this.definitions = definitions;
        this.childAgents = childAgents;
        this.agentRuns = agentRuns;
        this.runFacts = runFacts;
        this.childResults = childResults;
        this.runStates = runStates;
        this.objectMapper = objectMapper;
        this.schemaValidator = schemaValidator;
        this.values = values;
        this.generatedTitles = generatedTitles;
    }

    public Mono<PipelineAdvance> advance(String runId) {
        return Mono.fromCallable(() -> advanceDurable(runId))
                .subscribeOn(Schedulers.boundedElastic());
    }

    private PipelineAdvance advanceDurable(String runId) {
        PipelineRun run = pipelines.find(runId).orElseThrow(() ->
                new IllegalArgumentException("Pipeline Run not found")
        );
        if (run.phase().terminal()) {
            return view(run.runId(), run.phase(), null);
        }
        var binding = definitions.find(run.definitionId()).orElse(null);
        if (binding == null
                || !binding.definition().version().equals(
                        run.definitionVersion()
                )
                || !binding.snapshotHash().equals(run.snapshotHash())) {
            return fail(run, null, "pipeline_definition_unavailable");
        }

        StepRun step = pipelines.nextOpenStep(runId).orElse(null);
        if (step == null) {
            java.util.List<StepRun> completed = pipelines.steps(runId);
            JsonNode finalOutput = completed.isEmpty()
                    ? null : completed.get(completed.size() - 1).output();
            if (finalOutput == null) {
                return fail(run, null, "pipeline_output_missing");
            }
            try {
                schemaValidator.validate(
                        binding.definition().outputSchema(),
                        finalOutput
                );
            } catch (RuntimeException invalidOutput) {
                return fail(
                        run,
                        completed.get(completed.size() - 1),
                        "pipeline_output_contract_invalid"
                );
            }
            var succeeded = runStates.completePipelineRun(
                    run.runId(),
                    run.version()
            ).run();
            return view(succeeded.runId(), succeeded.phase(), null);
        }
        if ("failed".equals(step.phase())) {
            return fail(run, step, step.failureCode());
        }

        PipelineDefinition.Step definitionStep = binding.definition()
                .steps().get(step.stepIndex());
        if (!definitionStep.stepId().equals(step.stepId())
                || !definitionStep.kind().equals(step.kind())) {
            return fail(run, step, "pipeline_step_snapshot_mismatch");
        }
        if (definitionStep instanceof ChildAgentStep childStep) {
            return advanceChild(run, step, childStep);
        }
        if (definitionStep instanceof ModelTransformStep transformStep) {
            return advanceModelTransform(run, step, transformStep);
        }
        if (definitionStep instanceof PublishConversationTitleStep publishStep) {
            return advanceConversationTitle(run, step, publishStep);
        }
        return fail(run, step, "pipeline_step_kind_unsupported");
    }

    private PipelineAdvance advanceConversationTitle(
            PipelineRun run,
            StepRun step,
            PublishConversationTitleStep definition
    ) {
        if (!"accepted".equals(step.phase())) {
            return fail(run, step, "invalid_pipeline_publish_phase");
        }
        String candidate = values.resolve(
                run,
                step,
                definition.titleSelector()
        ).asText("");
        var published = generatedTitles.publish(
                run.conversationId(),
                run.runId(),
                candidate
        );
        ObjectNode output = objectMapper.createObjectNode();
        output.put("title", published.title());
        output.put("published", published.published());
        output.put(
                "summary",
                published.published()
                        ? "会话标题已更新为：“" + published.title() + "”。"
                        : "保留现有会话标题，未覆盖用户命名。"
        );
        output.put("reason", published.reason());
        if (!pipelines.completeImmediateStep(
                step.stepRunId(),
                step.version(),
                output,
                clock.instant()
        )) {
            throw new IllegalStateException(
                    "Pipeline publish step changed concurrently"
            );
        }
        return advanceDurable(run.runId());
    }

    private PipelineAdvance advanceChild(
            PipelineRun run,
            StepRun step,
            ChildAgentStep definition
    ) {
        return advanceAgentStep(
                run,
                step,
                () -> childAgents.create(
                        run,
                        step.stepRunId(),
                        definition,
                        values.resolve(
                                run,
                                step,
                                definition.taskInputPointer()
                        ).asText("").trim()
                )
        );
    }

    private PipelineAdvance advanceModelTransform(
            PipelineRun run,
            StepRun step,
            ModelTransformStep definition
    ) {
        return advanceAgentStep(
                run,
                step,
                () -> childAgents.createModelTransform(
                        run,
                        step.stepRunId(),
                        definition,
                        values.resolve(
                                run,
                                step,
                                definition.sourceInputPointer()
                        ).asText("").trim()
                )
        );
    }

    private PipelineAdvance advanceAgentStep(
            PipelineRun run,
            StepRun step,
            java.util.function.Supplier<String> childFactory
    ) {
        if ("accepted".equals(step.phase())) {
            String childRunId = childFactory.get();
            if (!pipelines.markWaitingChild(
                    step.stepRunId(),
                    step.version(),
                    childRunId,
                    clock.instant()
            )) {
                throw new IllegalStateException(
                        "Pipeline step changed while attaching child Run"
                );
            }
            agentRuns.launch(childRunId);
            return view(run.runId(), run.phase(), step.stepRunId());
        }
        if (!"waiting_child".equals(step.phase())) {
            return fail(run, step, "invalid_pipeline_step_phase");
        }
        var child = runFacts.findRun(step.childRunId()).orElse(null);
        if (child == null) {
            return fail(run, step, "pipeline_child_run_missing");
        }
        if (!child.phase().terminal()) {
            agentRuns.launch(child.runId());
            return view(run.runId(), run.phase(), step.stepRunId());
        }
        if (child.phase() != RunPhase.SUCCEEDED) {
            pipelines.failStep(
                    step.stepRunId(),
                    step.version(),
                    "pipeline_child_" + child.phase().name().toLowerCase(),
                    clock.instant()
            );
            return fail(
                    run,
                    step,
                    "pipeline_child_" + child.phase().name().toLowerCase()
            );
        }
        String summary = childResults.find(child.runId())
                .map(AgentRunResultRepository.RunResult::summary)
                .orElseGet(() -> childResults.latestAssistantText(
                        child.runId()
                ));
        if (summary.length() > MAX_HANDOFF_CHARS) {
            summary = summary.substring(0, MAX_HANDOFF_CHARS)
                    + "\n\n[结果较长，完整正文保留在 child Run "
                    + child.runId() + "]";
        }
        ObjectNode output = objectMapper.createObjectNode();
        output.put("runId", child.runId());
        output.put("summary", summary);
        if (!pipelines.completeStep(
                step.stepRunId(),
                step.version(),
                output,
                clock.instant()
        )) {
            throw new IllegalStateException(
                    "Pipeline step changed while completing child Run"
            );
        }
        return advanceDurable(run.runId());
    }

    private PipelineAdvance fail(
            PipelineRun run,
            StepRun step,
            String code
    ) {
        if (run.phase().terminal()) {
            return view(run.runId(), run.phase(),
                    step == null ? null : step.stepRunId());
        }
        FailureView failure = new FailureView(
                code == null ? "pipeline_failed" : code,
                "pipeline",
                "这个固定流程没有安全完成；已有步骤、子运行和结果都已保留。",
                "trace_" + UUID.randomUUID().toString().replace("-", ""),
                "pipeline_runtime",
                "none",
                "n/a",
                null
        );
        var failed = runStates.failRun(
                run.runId(),
                run.version(),
                failure
        );
        return view(failed.runId(), failed.phase(),
                step == null ? null : step.stepRunId());
    }

    private PipelineAdvance view(
            String runId,
            RunPhase phase,
            String waitingStepRunId
    ) {
        return new PipelineAdvance(runId, phase, waitingStepRunId);
    }

    public record PipelineAdvance(
            String runId,
            RunPhase phase,
            String waitingStepRunId
    ) { }
}
