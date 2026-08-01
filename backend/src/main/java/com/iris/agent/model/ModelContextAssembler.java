package com.iris.agent.model;

import com.fasterxml.jackson.core.JsonProcessingException;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.iris.agent.run.RunRoundRepository;
import com.iris.agent.run.RunRoundRepository.RoundRow;
import com.iris.agent.run.RunRoundRepository.RunBudget;
import com.iris.agent.run.RunRoundRepository.RunRow;
import com.iris.agent.model.ModelContextWindowPlanner.ContextBudget;
import com.iris.agent.model.ModelContextWindowPlanner.WindowPlan;
import com.iris.agent.model.ToolObservationMicroCompactor.Projection;
import com.iris.tools.core.ToolRegistry;
import com.iris.tools.core.ToolRegistry.ToolBinding;
import com.iris.tools.core.CapabilityAvailabilityService;
import com.iris.task.TaskLedgerService;
import com.iris.artifact.ArtifactService;
import org.springframework.stereotype.Service;

import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.security.NoSuchAlgorithmException;
import java.util.ArrayList;
import java.util.HexFormat;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Set;
import java.time.Clock;

@Service
public class ModelContextAssembler {
    private static final int RUNTIME_ACTIVITY_LIMIT = 8;

    private final ModelContextRepository facts;
    private final ToolRegistry tools;
    private final CapabilityAvailabilityService availability;
    private final ObjectMapper objectMapper;
    private final ModelContextWindowPlanner windows;
    private final ToolObservationMicroCompactor microCompactor;
    private final ModelContextSnapshotRepository snapshots;
    private final ModelTokenEstimator tokens;
    private final TaskLedgerService taskLedger;
    private final ArtifactService artifacts;
    private final RunRoundRepository runs;
    private final ModelPromptPrefixService promptPrefixes;
    private final Clock clock = Clock.systemUTC();

    public ModelContextAssembler(
            ModelContextRepository facts,
            ToolRegistry tools,
            CapabilityAvailabilityService availability,
            ObjectMapper objectMapper,
            ModelContextWindowPlanner windows,
            ToolObservationMicroCompactor microCompactor,
            ModelContextSnapshotRepository snapshots,
            ModelTokenEstimator tokens,
            TaskLedgerService taskLedger,
            ArtifactService artifacts,
            RunRoundRepository runs,
            ModelPromptPrefixService promptPrefixes
    ) {
        this.facts = facts;
        this.tools = tools;
        this.availability = availability;
        this.objectMapper = objectMapper;
        this.windows = windows;
        this.microCompactor = microCompactor;
        this.snapshots = snapshots;
        this.tokens = tokens;
        this.taskLedger = taskLedger;
        this.artifacts = artifacts;
        this.runs = runs;
        this.promptPrefixes = promptPrefixes;
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
                new LinkedHashSet<>(seed.providerToolNames());
        if (uniqueNames.size() != seed.providerToolNames().size()) {
            throw new IllegalArgumentException(
                    "Provider tool surface contains duplicate names"
            );
        }

        List<ModelRequest.ToolDefinition> definitions = new ArrayList<>();
        List<ModelInputItem.CapabilityRuntimeLimit> capabilityLimits =
                new ArrayList<>();
        for (String name : uniqueNames) {
            ToolBinding binding = tools.find(name).orElseThrow(
                    () -> new IllegalArgumentException(
                            "Provider tool surface references an unknown tool: " + name
                    )
            );
            var currentAvailability =
                    availability.requireExecutable(binding);
            definitions.add(new ModelRequest.ToolDefinition(
                    binding.manifest().name(),
                    binding.manifest().description(),
                    binding.manifest().inputSchema(),
                    binding.manifestHash()
            ));
            if (currentAvailability.status()
                    == com.iris.tools.core.CapabilityAvailability.Status.DEGRADED) {
                capabilityLimits.add(
                        new ModelInputItem.CapabilityRuntimeLimit(
                                binding.manifest().name(),
                                currentAvailability.value(),
                                currentAvailability.reason(),
                                currentAvailability.checkedAt().toString()
                        )
                );
            }
        }
        int estimatedCapabilityTokens = tokens.estimate(definitions);
        if (estimatedCapabilityTokens > seed.maxCapabilityTokens()) {
            throw new PromptTooLargeException(
                    "Provider tool surface exceeds its schema budget"
            );
        }
        if (seed.estimatedCapabilityTokens() != 0
                && seed.estimatedCapabilityTokens()
                != estimatedCapabilityTokens) {
            throw new IllegalStateException(
                    "Provider tool surface changed after planning"
            );
        }
        List<ModelInputItem> allItems = new ArrayList<>(
                facts.branchFactsBeforeRound(
                        run.conversationId(),
                        run.branchId(),
                        round.roundId()
                )
        );
        var artifactIndex = artifacts.modelContextIndex(
                run.conversationId(),
                run.branchId(),
                8
        );
        if (!artifactIndex.isEmpty()) {
            var index = objectMapper.createArrayNode();
            artifactIndex.forEach(artifact -> index.addObject()
                    .put("artifactRef", artifact.reference())
                    .put("title", artifact.title())
                    .put("kind", artifact.kind())
                    .put("mediaType", artifact.mediaType())
                    .put("byteCount", artifact.byteCount())
                    .put("contentHash", artifact.contentHash()));
            allItems.add(new ModelInputItem.ArtifactContextIndex(
                    index.toString()
            ));
        }
        if (!capabilityLimits.isEmpty()) {
            allItems.add(new ModelInputItem.CapabilityRuntimeState(
                    capabilityLimits
            ));
        }
        taskLedger.activeForContext(
                run.conversationId(),
                run.branchId()
        ).forEach(task -> allItems.add(new ModelInputItem.TaskWorkState(
                task.taskId(),
                task.stateVersion(),
                taskLedger.toJson(task).toString()
        )));
        RunBudget runtimeBudget = runs.runBudget(run.runId());
        allItems.add(new ModelInputItem.RuntimePulse(
                run.runId(),
                round.index(),
                runtimeBudget.toolCallsUsed(),
                runtimeBudget.toolCallsLimit(),
                runtimeBudget.elapsedMs(),
                runtimeBudget.timeLimitMs(),
                clock.instant()
                        .atZone(java.time.ZoneId.systemDefault())
                        .toOffsetDateTime()
                        .toString(),
                java.time.ZoneId.systemDefault().getId(),
                System.getProperty("os.name", "unknown"),
                definitions.size(),
                seed.omittedCapabilityCount(),
                runs.recentToolActivity(
                                run.runId(),
                                RUNTIME_ACTIVITY_LIMIT
                        )
                        .stream()
                        .map(activity -> new ModelInputItem.ToolActivity(
                                activity.toolName(),
                                activity.callCount(),
                                activity.failedCount(),
                                activity.outcomeUnknownCount(),
                                activity.latestPhase(),
                                activity.latestSameFailureCount(),
                                activity.latestErrorCode()
                        ))
                        .toList()
        ));
        String leaseHash = hash(definitions);
        ModelPromptPrefix promptPrefix = promptPrefixes.capture(
                seed.promptDefinitionId(),
                seed.promptVersion(),
                seed.systemInstruction(),
                definitions
        );
        Projection observationProjection = microCompactor.project(
                run.conversationId(),
                seed.systemInstruction(),
                allItems,
                definitions,
                seed.budget()
        );
        List<String> requiredUserFactIds =
                facts.requiredUserFactIdsBeforeRound(
                        run.turnId(),
                        round.roundId()
                );
        LinkedHashSet<String> requiredObservationIds =
                new LinkedHashSet<>(
                        facts.currentTurnObservationIdsBeforeRound(
                                run.turnId(),
                                round.roundId()
                        )
                );
        requiredObservationIds.retainAll(
                microCompactor.pinnedObservationIds(
                        observationProjection.items()
                )
        );
        WindowPlan window = windows.plan(
                seed.systemInstruction(),
                observationProjection.items(),
                definitions,
                seed.budget(),
                new LinkedHashSet<>(requiredUserFactIds),
                requiredObservationIds
        );
        SnapshotPayload payload = new SnapshotPayload(
                seed.systemInstruction(),
                window.items(),
                requiredUserFactIds,
                List.copyOf(requiredObservationIds),
                definitions,
                promptPrefix,
                leaseHash,
                window.estimatedInputTokens(),
                window.budget().maxInputTokens(),
                window.budget().reservedOutputTokens(),
                window.droppedFactCount(),
                seed.maxCapabilityTokens(),
                estimatedCapabilityTokens,
                seed.omittedCapabilityCount(),
                observationProjection.compactedObservationCount(),
                observationProjection.decisionsAdded(),
                observationProjection.estimatedTokensSaved()
        );
        String payloadJson = write(payload);
        String contextHash = hash(payloadJson);
        ModelContext context = new ModelContext(
                seed.systemInstruction(),
                window.items(),
                definitions,
                promptPrefix,
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
            String promptDefinitionId,
            int promptVersion,
            List<String> providerToolNames,
            ContextBudget budget,
            int maxCapabilityTokens,
            int estimatedCapabilityTokens,
            int omittedCapabilityCount
    ) {
        public ContextSeed(
                String systemInstruction,
                List<String> providerToolNames
        ) {
            this(
                    systemInstruction,
                    "iris.agent.adhoc",
                    1,
                    providerToolNames,
                    ContextBudget.defaults(),
                    Integer.MAX_VALUE,
                    0,
                    0
            );
        }

        public ContextSeed(
                String systemInstruction,
                List<String> providerToolNames,
                ContextBudget budget
        ) {
            this(
                    systemInstruction,
                    "iris.agent.adhoc",
                    1,
                    providerToolNames,
                    budget,
                    Integer.MAX_VALUE,
                    0,
                    0
            );
        }

        public ContextSeed {
            providerToolNames = List.copyOf(providerToolNames);
            budget = budget == null ? ContextBudget.defaults() : budget;
            if (promptDefinitionId == null || promptDefinitionId.isBlank()
                    || promptVersion < 1
                    || maxCapabilityTokens < 1
                    || estimatedCapabilityTokens < 0
                    || estimatedCapabilityTokens > maxCapabilityTokens
                    || omittedCapabilityCount < 0) {
                throw new IllegalArgumentException(
                        "Invalid provider tool surface budget metadata"
                );
            }
        }
    }

    private record SnapshotPayload(
            String systemInstruction,
            List<ModelInputItem> items,
            List<String> requiredUserFactIds,
            List<String> requiredObservationIds,
            List<ModelRequest.ToolDefinition> tools,
            ModelPromptPrefix promptPrefix,
            String capabilityLeaseHash,
            int estimatedInputTokens,
            int maxInputTokens,
            int reservedOutputTokens,
            int droppedFactCount,
            int maxCapabilityTokens,
            int estimatedCapabilityTokens,
            int omittedCapabilityCount,
            int microCompactedObservationCount,
            int microCompactDecisionsAdded,
            int estimatedTokensSavedByMicroCompact
    ) {
    }
}
