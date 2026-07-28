package com.iris.agent.model;

import com.iris.agent.model.ModelRequest.ToolDefinition;
import com.iris.tools.core.ToolRegistry;
import com.iris.tools.core.ToolRegistry.ToolBinding;
import org.springframework.stereotype.Service;

import java.util.ArrayList;
import java.util.LinkedHashSet;
import java.util.List;

/**
 * Selects the exact tool definitions visible to one model attempt.
 *
 * Required definitions fail closed when they cannot fit. Optional definitions
 * preserve candidate order and are admitted only while the schema budget
 * allows; an oversized candidate does not prevent later smaller candidates
 * from being considered.
 */
@Service
public class CapabilityLeasePlanner {
    private final ToolRegistry tools;
    private final ModelTokenEstimator tokens;

    public CapabilityLeasePlanner(
            ToolRegistry tools,
            ModelTokenEstimator tokens
    ) {
        this.tools = tools;
        this.tokens = tokens;
    }

    public LeasePlan plan(
            List<String> requiredNames,
            List<String> optionalNames,
            int maxSchemaTokens
    ) {
        if (maxSchemaTokens < 1) {
            throw new IllegalArgumentException(
                    "Capability schema budget must be positive"
            );
        }

        LinkedHashSet<String> selectedNames = new LinkedHashSet<>();
        List<ToolDefinition> selectedDefinitions = new ArrayList<>();
        for (String name : requiredNames) {
            if (!selectedNames.add(name)) {
                throw new IllegalArgumentException(
                        "Required capability lease contains duplicates"
                );
            }
            selectedDefinitions.add(definition(requireBinding(name)));
        }

        int estimatedTokens = tokens.estimate(selectedDefinitions);
        if (estimatedTokens > maxSchemaTokens) {
            throw new PromptTooLargeException(
                    "Required resident capabilities exceed the schema budget"
            );
        }

        int omittedCount = 0;
        LinkedHashSet<String> seenOptional = new LinkedHashSet<>();
        for (String name : optionalNames) {
            if (!seenOptional.add(name) || selectedNames.contains(name)) {
                continue;
            }
            ToolBinding binding = tools.find(name).orElse(null);
            if (binding == null) {
                omittedCount++;
                continue;
            }
            ToolDefinition candidate = definition(binding);
            List<ToolDefinition> expanded =
                    new ArrayList<>(selectedDefinitions);
            expanded.add(candidate);
            int expandedTokens = tokens.estimate(expanded);
            if (expandedTokens > maxSchemaTokens) {
                omittedCount++;
                continue;
            }
            selectedNames.add(name);
            selectedDefinitions.add(candidate);
            estimatedTokens = expandedTokens;
        }

        return new LeasePlan(
                new ArrayList<>(selectedNames),
                estimatedTokens,
                maxSchemaTokens,
                omittedCount
        );
    }

    private ToolBinding requireBinding(String name) {
        return tools.find(name).orElseThrow(
                () -> new IllegalStateException(
                        "Required capability is not registered: " + name
                )
        );
    }

    private ToolDefinition definition(ToolBinding binding) {
        return new ToolDefinition(
                binding.manifest().name(),
                binding.manifest().description(),
                binding.manifest().inputSchema(),
                binding.manifestHash()
        );
    }

    public record LeasePlan(
            List<String> toolNames,
            int estimatedSchemaTokens,
            int maxSchemaTokens,
            int omittedCandidateCount
    ) {
        public LeasePlan {
            toolNames = List.copyOf(toolNames);
        }
    }
}
