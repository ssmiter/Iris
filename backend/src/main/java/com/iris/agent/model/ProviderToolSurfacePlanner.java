package com.iris.agent.model;

import com.iris.agent.model.ModelRequest.ToolDefinition;
import com.iris.tools.core.CapabilityAvailabilityService;
import com.iris.tools.core.ToolRegistry;
import com.iris.tools.core.ToolRegistry.ToolBinding;
import org.springframework.stereotype.Service;

import java.util.ArrayList;
import java.util.LinkedHashSet;
import java.util.List;

/**
 * Freezes the complete, ordered provider-visible tool surface.
 *
 * <p>The primary agent does not admit optional domain schemas here. If a
 * resident primitive is missing, unavailable or too large, context assembly
 * fails closed instead of silently changing the protocol.</p>
 */
@Service
public final class ProviderToolSurfacePlanner {
    private final ToolRegistry tools;
    private final ModelTokenEstimator tokens;
    private final CapabilityAvailabilityService availability;

    public ProviderToolSurfacePlanner(
            ToolRegistry tools,
            ModelTokenEstimator tokens,
            CapabilityAvailabilityService availability
    ) {
        this.tools = tools;
        this.tokens = tokens;
        this.availability = availability;
    }

    public SurfacePlan plan(
            List<String> orderedNames,
            int maxSchemaTokens
    ) {
        if (maxSchemaTokens < 1) {
            throw new IllegalArgumentException(
                    "Provider tool schema budget must be positive"
            );
        }
        LinkedHashSet<String> uniqueNames =
                new LinkedHashSet<>(orderedNames);
        if (uniqueNames.size() != orderedNames.size()) {
            throw new IllegalArgumentException(
                    "Provider tool surface contains duplicate names"
            );
        }

        List<ToolDefinition> definitions = new ArrayList<>();
        for (String name : uniqueNames) {
            ToolBinding binding = tools.find(name).orElseThrow(
                    () -> new IllegalStateException(
                            "Resident tool is not registered: " + name
                    )
            );
            availability.requireExecutable(binding);
            definitions.add(new ToolDefinition(
                    binding.manifest().name(),
                    binding.manifest().description(),
                    binding.manifest().inputSchema(),
                    binding.manifestHash()
            ));
        }

        int estimatedTokens = tokens.estimate(definitions);
        if (estimatedTokens > maxSchemaTokens) {
            throw new PromptTooLargeException(
                    "Resident provider tools exceed the schema budget"
            );
        }
        return new SurfacePlan(
                List.copyOf(uniqueNames),
                estimatedTokens,
                maxSchemaTokens
        );
    }

    public record SurfacePlan(
            List<String> toolNames,
            int estimatedSchemaTokens,
            int maxSchemaTokens
    ) {
        public SurfacePlan {
            toolNames = List.copyOf(toolNames);
        }
    }
}
