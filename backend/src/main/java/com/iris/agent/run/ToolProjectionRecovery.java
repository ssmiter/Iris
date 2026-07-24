package com.iris.agent.run;

import com.iris.agent.model.ModelAttemptRepository;
import com.iris.tools.core.ToolRuntime;
import org.springframework.boot.ApplicationArguments;
import org.springframework.boot.ApplicationRunner;
import org.springframework.core.annotation.Order;
import org.springframework.stereotype.Component;

/**
 * Rebuilds missing safe UI projections from canonical Tool Runtime facts.
 */
@Component
@Order(30)
public class ToolProjectionRecovery implements ApplicationRunner {
    private final ModelAttemptRepository modelFacts;
    private final ToolRuntime runtime;
    private final ToolProjectionService projections;

    public ToolProjectionRecovery(
            ModelAttemptRepository modelFacts,
            ToolRuntime runtime,
            ToolProjectionService projections
    ) {
        this.modelFacts = modelFacts;
        this.runtime = runtime;
        this.projections = projections;
    }

    @Override
    public void run(ApplicationArguments args) {
        for (ModelAttemptRepository.ProjectionGap gap
                : modelFacts.projectionGaps()) {
            projections.project(
                    gap.roundId(),
                    gap.call(),
                    runtime.get(
                            gap.conversationId(),
                            gap.call().toolCallId()
                    )
            );
        }
    }
}
