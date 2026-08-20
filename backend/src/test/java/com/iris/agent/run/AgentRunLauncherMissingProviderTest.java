package com.iris.agent.run;

import com.iris.agent.model.AutoCompactionService;
import com.iris.agent.model.provider.IrisModelProperties;
import com.iris.agent.model.provider.ModelProviderRegistry;
import com.iris.workspace.WorkspaceService;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.springframework.context.ApplicationEventPublisher;
import reactor.core.publisher.Mono;

import java.nio.file.Path;
import java.time.Instant;
import java.util.Optional;

import static org.assertj.core.api.Assertions.assertThat;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.ArgumentMatchers.anyBoolean;
import static org.mockito.ArgumentMatchers.anyString;
import static org.mockito.ArgumentMatchers.eq;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.never;
import static org.mockito.Mockito.verify;
import static org.mockito.Mockito.when;

/**
 * 未配置模型 provider 时：普通 launch 记 model_not_configured 失败并返回 false；
 * stop 唤醒（stopWakeup=true）不再触发该失败，Run 继续走取消路径。
 */
class AgentRunLauncherMissingProviderTest {

    private final RunRoundRepository facts = mock(RunRoundRepository.class);
    private final AgenticRunCoordinator coordinator = mock(
            AgenticRunCoordinator.class
    );
    private final ModelProviderRegistry providers = mock(
            ModelProviderRegistry.class
    );
    private final IrisModelProperties model = mock(IrisModelProperties.class);
    private final WorkspaceService workspace = mock(WorkspaceService.class);
    private final RunCancellationRegistry cancellations = mock(
            RunCancellationRegistry.class
    );
    private final AutoCompactionService autoCompactions = mock(
            AutoCompactionService.class
    );
    private final ApplicationEventPublisher events = mock(
            ApplicationEventPublisher.class
    );

    private AgentRunLauncher launcher;

    @BeforeEach
    void setUp() {
        when(providers.configured(anyString())).thenReturn(false);
        when(model.getProfile()).thenReturn("unconfigured");
        when(workspace.root()).thenReturn(Path.of("/tmp/iris"));
        when(coordinator.failForMissingProvider(anyString()))
                .thenReturn(Mono.empty());
        launcher = new AgentRunLauncher(
                coordinator,
                facts,
                providers,
                model,
                workspace,
                cancellations,
                autoCompactions,
                events,
                3
        );
    }

    @Test
    void launchRecordsModelNotConfiguredFailureAndReturnsFalse() {
        when(facts.findRun("run_1")).thenReturn(Optional.of(rootRun(
                "run_1",
                RunPhase.RUNNING,
                1L
        )));

        boolean launched = launcher.launch("run_1");

        assertThat(launched).isFalse();
        verify(coordinator).failForMissingProvider("run_1");
        verify(coordinator, never()).advance(
                anyString(),
                anyString(),
                any(),
                anyBoolean()
        );
        verify(events, never()).publishEvent(any());
    }

    @Test
    void stopWakeupSkipsMissingProviderFailure() {
        RunRoundRepository.RunRow accepted = rootRun(
                "run_2",
                RunPhase.ACCEPTED,
                1L
        );
        RunRoundRepository.RunRow running = rootRun(
                "run_2",
                RunPhase.RUNNING,
                2L
        );
        when(facts.findRun("run_2"))
                .thenReturn(Optional.of(accepted), Optional.of(running));
        when(facts.transitionRun(
                eq("run_2"),
                eq(RunPhase.ACCEPTED),
                eq(RunPhase.RUNNING),
                eq(1L),
                any(Instant.class)
        )).thenReturn(true);
        when(coordinator.advance(
                eq("run_2"),
                anyString(),
                any(),
                eq(true)
        )).thenReturn(Mono.empty());

        boolean launched = launcher.requestStop("run_2");

        assertThat(launched).isTrue();
        verify(cancellations).signal("run_2");
        verify(coordinator, never()).failForMissingProvider(anyString());
        verify(coordinator).advance(
                eq("run_2"),
                anyString(),
                any(),
                eq(true)
        );
    }

    private static RunRoundRepository.RunRow rootRun(
            String runId,
            RunPhase phase,
            long version
    ) {
        return new RunRoundRepository.RunRow(
                runId,
                "conv",
                "branch",
                "turn",
                null,
                runId,
                "agentic",
                "task",
                phase,
                version
        );
    }
}
