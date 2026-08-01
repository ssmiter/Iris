package com.iris.agent.model;

import com.iris.agent.model.ModelContextAssembler.ContextSeed;
import com.iris.agent.model.ModelContextWindowPlanner.ContextBudget;
import com.iris.agent.model.ProviderToolSurfacePlanner.SurfacePlan;
import com.iris.tools.core.ResidentToolSurface;
import org.springframework.stereotype.Service;

/**
 * Builds the byte-stable provider tool surface for the primary agent.
 * Domain capabilities are inspected through the catalog and executed through
 * invoke_capability; they never mutate this resident schema set.
 */
@Service
public final class AgentContextPolicy {
    private static final int MAX_PROVIDER_TOOL_SCHEMA_TOKENS = 16_384;
    private final ProviderToolSurfacePlanner surfaces;
    private final AgentSystemPrompt systemPrompt;

    public AgentContextPolicy(
            ProviderToolSurfacePlanner surfaces,
            AgentSystemPrompt systemPrompt
    ) {
        this.surfaces = surfaces;
        this.systemPrompt = systemPrompt;
    }

    public ContextSeed seedFor(String runId, String currentRoundId) {
        SurfacePlan surface = surfaces.plan(
                ResidentToolSurface.orderedNames(),
                MAX_PROVIDER_TOOL_SCHEMA_TOKENS
        );
        return new ContextSeed(
                systemPrompt.instruction(),
                systemPrompt.definitionId(),
                systemPrompt.version(),
                surface.toolNames(),
                ContextBudget.defaults(),
                surface.maxSchemaTokens(),
                surface.estimatedSchemaTokens(),
                0
        );
    }
}
