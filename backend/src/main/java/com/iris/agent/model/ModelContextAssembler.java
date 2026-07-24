package com.iris.agent.model;

import com.fasterxml.jackson.core.JsonProcessingException;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.iris.agent.run.RunRoundRepository.RoundRow;
import com.iris.agent.run.RunRoundRepository.RunRow;
import com.iris.agent.model.ModelContextWindowPlanner.ContextBudget;
import com.iris.agent.model.ModelContextWindowPlanner.WindowPlan;
import com.iris.tools.core.ToolRegistry;
import com.iris.tools.core.ToolRegistry.ToolBinding;
import org.springframework.stereotype.Service;

import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.security.NoSuchAlgorithmException;
import java.util.ArrayList;
import java.util.HexFormat;
import java.util.LinkedHashSet;
import java.util.List;
import java.time.Clock;

@Service
public class ModelContextAssembler {
    private final ModelContextRepository facts;
    private final ToolRegistry tools;
    private final ObjectMapper objectMapper;
    private final ModelContextWindowPlanner windows;
    private final ModelContextSnapshotRepository snapshots;
    private final Clock clock = Clock.systemUTC();

    public ModelContextAssembler(
            ModelContextRepository facts,
            ToolRegistry tools,
            ObjectMapper objectMapper,
            ModelContextWindowPlanner windows,
            ModelContextSnapshotRepository snapshots
    ) {
        this.facts = facts;
        this.tools = tools;
        this.objectMapper = objectMapper;
        this.windows = windows;
        this.snapshots = snapshots;
    }

    public ModelContext assemble(
            RunRow run,
            RoundRow round,
            ContextSeed seed
    ) {
        if (seed == null || seed.systemInstruction() == null
                || seed.systemInstruction().isBlank()) {
            throw new IllegalArgumentException("System instruction is required");
        }
        LinkedHashSet<String> uniqueNames =
                new LinkedHashSet<>(seed.leasedToolNames());
        if (uniqueNames.size() != seed.leasedToolNames().size()) {
            throw new IllegalArgumentException(
                    "Capability lease contains duplicate tool names"
            );
        }

        List<ModelRequest.ToolDefinition> definitions = new ArrayList<>();
        for (String name : uniqueNames) {
            ToolBinding binding = tools.find(name).orElseThrow(
                    () -> new IllegalArgumentException(
                            "Capability lease references an unknown tool: " + name
                    )
            );
            definitions.add(new ModelRequest.ToolDefinition(
                    binding.manifest().name(),
                    binding.manifest().description(),
                    binding.manifest().inputSchema(),
                    binding.manifestHash()
            ));
        }
        List<ModelInputItem> allItems = facts.branchFactsBeforeRound(
                run.conversationId(),
                run.branchId(),
                round.roundId()
        );
        String leaseHash = hash(definitions);
        WindowPlan window = windows.plan(
                seed.systemInstruction(),
                allItems,
                definitions,
                seed.budget()
        );
        SnapshotPayload payload = new SnapshotPayload(
                seed.systemInstruction(),
                window.items(),
                definitions,
                leaseHash,
                window.estimatedInputTokens(),
                window.budget().maxInputTokens(),
                window.budget().reservedOutputTokens(),
                window.droppedFactCount()
        );
        String payloadJson = write(payload);
        String contextHash = hash(payloadJson);
        ModelContext context = new ModelContext(
                seed.systemInstruction(),
                window.items(),
                definitions,
                contextHash,
                leaseHash,
                window.estimatedInputTokens(),
                window.budget().maxInputTokens(),
                window.budget().reservedOutputTokens(),
                window.droppedFactCount()
        );
        snapshots.save(
                context,
                run.conversationId(),
                run.branchId(),
                run.runId(),
                round.roundId(),
                payloadJson,
                clock.instant()
        );
        return context;
    }

    private String hash(Object value) {
        try {
            byte[] bytes = write(value)
                    .getBytes(StandardCharsets.UTF_8);
            return HexFormat.of().formatHex(
                    MessageDigest.getInstance("SHA-256").digest(bytes)
            );
        } catch (NoSuchAlgorithmException exception) {
            throw new IllegalStateException(
                    "Unable to hash model context",
                    exception
            );
        }
    }

    private String write(Object value) {
        try {
            return objectMapper.writeValueAsString(value);
        } catch (JsonProcessingException exception) {
            throw new IllegalStateException(
                    "Unable to serialize model context",
                    exception
            );
        }
    }

    public record ContextSeed(
            String systemInstruction,
            List<String> leasedToolNames,
            ContextBudget budget
    ) {
        public ContextSeed(
                String systemInstruction,
                List<String> leasedToolNames
        ) {
            this(
                    systemInstruction,
                    leasedToolNames,
                    ContextBudget.defaults()
            );
        }

        public ContextSeed {
            leasedToolNames = List.copyOf(leasedToolNames);
            budget = budget == null ? ContextBudget.defaults() : budget;
        }
    }

    private record SnapshotPayload(
            String systemInstruction,
            List<ModelInputItem> items,
            List<ModelRequest.ToolDefinition> tools,
            String capabilityLeaseHash,
            int estimatedInputTokens,
            int maxInputTokens,
            int reservedOutputTokens,
            int droppedFactCount
    ) {
    }
}
