package com.iris.agent.pipeline;

import com.fasterxml.jackson.core.JsonProcessingException;
import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.iris.agent.pipeline.PipelineDefinitionRegistry.Binding;
import com.iris.agent.run.RunRoundRepository;
import com.iris.agent.run.RunRoundRepository.RunRow;
import com.iris.conversation.application.RunEventEmitter;
import com.iris.tools.core.ToolInputValidator;
import org.springframework.stereotype.Service;
import org.springframework.transaction.support.TransactionTemplate;

import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.security.NoSuchAlgorithmException;
import java.time.Clock;
import java.util.HexFormat;
import java.util.UUID;

/** Accepts Pipeline invocations from tools, UI commands and system triggers. */
@Service
public class PipelineCommandService {
    private final PipelineDefinitionRegistry definitions;
    private final PipelineRunRepository runs;
    private final RunRoundRepository runFacts;
    private final ToolInputValidator validator;
    private final ObjectMapper objectMapper;
    private final TransactionTemplate transactions;
    private final RunEventEmitter events;
    private final Clock clock = Clock.systemUTC();

    public PipelineCommandService(
            PipelineDefinitionRegistry definitions,
            PipelineRunRepository runs,
            RunRoundRepository runFacts,
            ToolInputValidator validator,
            ObjectMapper objectMapper,
            TransactionTemplate transactions,
            RunEventEmitter events
    ) {
        this.definitions = definitions;
        this.runs = runs;
        this.runFacts = runFacts;
        this.validator = validator;
        this.objectMapper = objectMapper;
        this.transactions = transactions;
        this.events = events;
    }

    public PipelineAcceptance createChild(
            String definitionId,
            JsonNode input,
            String parentRunId,
            String triggerKind,
            String triggerRef,
            String requestedBy
    ) {
        if (parentRunId == null || parentRunId.isBlank()
                || triggerKind == null || triggerKind.isBlank()
                || requestedBy == null || requestedBy.isBlank()) {
            throw new IllegalArgumentException(
                    "Pipeline parent, trigger kind and requester are required"
            );
        }
        Binding binding = definitions.find(definitionId).orElseThrow(() ->
                new IllegalArgumentException(
                        "Pipeline Definition not found: " + definitionId
                )
        );
        validator.validate(binding.definition().inputSchema(), input);
        String scopedTriggerRef = triggerRef == null || triggerRef.isBlank()
                ? null
                : definitionId + ":" + triggerRef.trim();
        var existing = runs.findByInvocation(
                parentRunId,
                triggerKind,
                scopedTriggerRef,
                definitionId
        );
        if (existing.isPresent()) {
            var run = existing.get();
            if (!hash(write(run.input())).equals(hash(write(input)))) {
                throw new IllegalStateException(
                        "Idempotent Pipeline invocation changed its input"
                );
            }
            return new PipelineAcceptance(
                    run.runId(),
                    run.definitionId(),
                    run.definitionVersion(),
                    run.phase().name().toLowerCase()
            );
        }
        RunRow parent = runFacts.findRun(parentRunId).orElseThrow(() ->
                new IllegalArgumentException("Parent Run not found")
        );
        boolean detachedEntry = "ui_action".equals(triggerKind)
                || "system_event".equals(triggerKind);
        if (parent.phase().terminal() && !detachedEntry) {
            throw new IllegalStateException(
                    "Only UI or system entries may attach a Pipeline to a terminal Run"
            );
        }
        String runId = id("run");
        String inputHash = hash(write(input));
        transactions.executeWithoutResult(status -> runs.insertChildRun(
                runId,
                parent.runId(),
                parent.rootRunId(),
                parent.conversationId(),
                parent.branchId(),
                parent.turnId(),
                binding,
                input.deepCopy(),
                inputHash,
                triggerKind,
                scopedTriggerRef,
                requestedBy,
                clock.instant()
        ));
        events.runStarted(runId);
        return new PipelineAcceptance(
                runId,
                binding.definition().id(),
                binding.definition().version(),
                "running"
        );
    }

    private String write(JsonNode input) {
        try {
            return objectMapper.writeValueAsString(input);
        } catch (JsonProcessingException exception) {
            throw new IllegalStateException("Unable to serialize Pipeline input", exception);
        }
    }

    private String hash(String value) {
        try {
            return HexFormat.of().formatHex(
                    MessageDigest.getInstance("SHA-256").digest(
                            value.getBytes(StandardCharsets.UTF_8)
                    )
            );
        } catch (NoSuchAlgorithmException exception) {
            throw new IllegalStateException("SHA-256 is unavailable", exception);
        }
    }

    private String id(String prefix) {
        return prefix + "_" + UUID.randomUUID().toString().replace("-", "");
    }

    public record PipelineAcceptance(
            String runId,
            String definitionId,
            String definitionVersion,
            String phase
    ) { }
}
