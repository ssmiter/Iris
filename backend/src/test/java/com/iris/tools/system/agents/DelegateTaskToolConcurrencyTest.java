package com.iris.tools.system.agents;

import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.node.ObjectNode;
import com.iris.agent.pipeline.PipelineCommandService;
import com.iris.agent.pipeline.PipelineRunCoordinator;
import com.iris.agent.pipeline.PipelineRunRepository;
import com.iris.agent.run.AgentRunLauncher;
import com.iris.agent.run.RunPhase;
import com.iris.task.TaskLedgerService;
import com.iris.tools.core.CommittedOperation;
import com.iris.tools.core.ToolContext;
import com.iris.tools.core.ToolOutcome;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.ObjectProvider;

import java.nio.file.Path;
import java.time.Instant;
import java.util.UUID;

import static org.assertj.core.api.Assertions.assertThat;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.ArgumentMatchers.anyString;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.when;

class DelegateTaskToolConcurrencyTest {

    @Test
    void queuedChildObservationReportsQueuePosition() {
        ObjectMapper objectMapper = new ObjectMapper();
        PipelineCommandService commands = mock(PipelineCommandService.class);
        PipelineRunCoordinator coordinator = mock(PipelineRunCoordinator.class);
        @SuppressWarnings("unchecked")
        ObjectProvider<PipelineRunCoordinator> coordinatorProvider =
                mock(ObjectProvider.class);
        PipelineRunRepository runs = mock(PipelineRunRepository.class);
        TaskLedgerService tasks = mock(TaskLedgerService.class);
        AgentRunLauncher agentRunLauncher = mock(AgentRunLauncher.class);
        @SuppressWarnings("unchecked")
        ObjectProvider<AgentRunLauncher> agentRuns = mock(ObjectProvider.class);
        when(agentRuns.getObject()).thenReturn(agentRunLauncher);

        String pipelineRunId = "pipeline_1";
        String childRunId = "child_1";

        when(commands.createChild(
                anyString(),
                any(),
                anyString(),
                anyString(),
                anyString(),
                anyString()
        )).thenReturn(new PipelineCommandService.PipelineAcceptance(
                pipelineRunId,
                "iris.pipeline.delegated_task",
                "3",
                "running"
        ));
        when(coordinatorProvider.getObject()).thenReturn(coordinator);
        when(coordinator.advance(pipelineRunId))
                .thenReturn(reactor.core.publisher.Mono.just(
                        new PipelineRunCoordinator.PipelineAdvance(
                                pipelineRunId,
                                RunPhase.ACCEPTED,
                                pipelineRunId + ":perform_task"
                        )
                ));
        PipelineRunRepository.StepRun step = new PipelineRunRepository.StepRun(
                pipelineRunId + ":perform_task",
                pipelineRunId,
                "perform_task",
                0,
                "child_agent",
                "waiting_child",
                childRunId,
                null,
                objectMapper.createObjectNode(),
                null,
                null,
                2L
        );
        when(runs.nextOpenStep(pipelineRunId)).thenReturn(
                java.util.Optional.of(step)
        );
        when(runs.find(pipelineRunId)).thenReturn(
                java.util.Optional.of(new PipelineRunRepository.PipelineRun(
                        pipelineRunId,
                        "parent_1",
                        "root_1",
                        "conv",
                        "branch",
                        "turn",
                        RunPhase.RUNNING,
                        1L,
                        "iris.pipeline.delegated_task",
                        "3",
                        "hash",
                        objectMapper.createObjectNode(),
                        null
                ))
        );
        when(agentRunLauncher.queuedAhead(childRunId)).thenReturn(2);

        DelegateTaskTool tool = new DelegateTaskTool(
                objectMapper,
                commands,
                coordinatorProvider,
                runs,
                tasks,
                agentRuns
        );

        ToolContext context = new ToolContext() {
            @Override
            public String conversationId() {
                return "conv";
            }

            @Override
            public String turnId() {
                return "turn";
            }

            @Override
            public String runId() {
                return "parent_1";
            }

            @Override
            public String roundId() {
                return "round_1";
            }

            @Override
            public Path workspaceRoot() {
                return Path.of("/tmp");
            }

            @Override
            public boolean cancelled() {
                return false;
            }
        };

        ObjectNode input = objectMapper.createObjectNode();
        input.put("task", "并行探索主题 A");
        var prepared = tool.prepare(input, context);
        CommittedOperation committed = new CommittedOperation(
                UUID.randomUUID().toString(),
                "snapshot_1",
                "snapshot_hash_1",
                prepared.normalizedInput(),
                prepared.resources()
        );
        ToolOutcome outcome = tool.execute(committed, context);

        assertThat(outcome.kind()).isEqualTo(ToolOutcome.Kind.SUCCEEDED);
        assertThat(outcome.output().path("phase").asText())
                .isEqualTo("accepted");
        assertThat(outcome.output().path("delivery").asText())
                .contains("已排队")
                .contains("前面还有 2 个");
    }
}
