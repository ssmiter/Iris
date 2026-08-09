package com.iris.agent.pipeline;

import com.fasterxml.jackson.core.JsonProcessingException;
import com.fasterxml.jackson.databind.ObjectMapper;
import org.springframework.stereotype.Component;

import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.security.NoSuchAlgorithmException;
import java.util.Collection;
import java.util.HexFormat;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Optional;
import java.util.regex.Pattern;

/** Exact Pipeline Definition identity -> executable code binding. */
@Component
public class PipelineDefinitionRegistry {
    private static final Pattern NAME = Pattern.compile(
            "[a-z][a-z0-9]*(?:_[a-z0-9]+)*"
    );
    private final Map<String, Binding> byId = new LinkedHashMap<>();
    private final Map<String, Binding> byPath = new LinkedHashMap<>();

    public PipelineDefinitionRegistry(
            List<PipelineDefinitionProvider> providers,
            ObjectMapper objectMapper
    ) {
        for (PipelineDefinitionProvider provider : providers) {
            PipelineDefinition definition = validate(provider.definition());
            Binding binding = new Binding(
                    definition,
                    hash(objectMapper, definition)
            );
            if (byId.putIfAbsent(definition.id(), binding) != null) {
                throw new IllegalStateException(
                        "Duplicate Pipeline id: " + definition.id()
                );
            }
            if (byPath.putIfAbsent(
                    definition.capabilityPath(),
                    binding
            ) != null) {
                throw new IllegalStateException(
                        "Duplicate Pipeline path: "
                                + definition.capabilityPath()
                );
            }
        }
    }

    public Optional<Binding> find(String definitionId) {
        return Optional.ofNullable(byId.get(definitionId));
    }

    public Optional<Binding> findByPath(String path) {
        return Optional.ofNullable(byPath.get(path));
    }

    public Collection<Binding> all() {
        return List.copyOf(byId.values());
    }

    private PipelineDefinition validate(PipelineDefinition definition) {
        if (definition == null
                || definition.id() == null
                || definition.id().isBlank()
                || definition.version() == null
                || definition.version().isBlank()
                || definition.name() == null
                || !NAME.matcher(definition.name()).matches()
                || definition.capabilityPath() == null
                || !definition.capabilityPath().startsWith("/")
                || definition.description() == null
                || definition.description().isBlank()
                || definition.inputSchema() == null
                || definition.outputSchema() == null
                || definition.steps().isEmpty()
                || definition.timeLimitMs() < 1) {
            throw new IllegalStateException("Invalid Pipeline Definition");
        }
        java.util.HashSet<String> stepIds = new java.util.HashSet<>();
        for (PipelineDefinition.Step step : definition.steps()) {
            if (step.stepId() == null || step.stepId().isBlank()
                    || !stepIds.add(step.stepId())) {
                throw new IllegalStateException(
                        "Pipeline step ids must be non-empty and unique"
                );
            }
            if (step instanceof PipelineDefinition.ChildAgentStep child) {
                validateSelector(child.taskInputPointer());
            } else if (step instanceof PipelineDefinition.ModelTransformStep transform) {
                validateSelector(transform.sourceInputPointer());
            }
        }
        return definition;
    }

    private void validateSelector(String selector) {
        if (selector == null
                || !(selector.startsWith("input:")
                || selector.startsWith("step:"))) {
            throw new IllegalStateException(
                    "Pipeline value selector must start with input: or step:"
            );
        }
    }

    private String hash(ObjectMapper objectMapper, Object value) {
        try {
            byte[] bytes = objectMapper.writeValueAsString(value)
                    .getBytes(StandardCharsets.UTF_8);
            return HexFormat.of().formatHex(
                    MessageDigest.getInstance("SHA-256").digest(bytes)
            );
        } catch (JsonProcessingException | NoSuchAlgorithmException exception) {
            throw new IllegalStateException(
                    "Unable to hash Pipeline Definition",
                    exception
            );
        }
    }

    public record Binding(PipelineDefinition definition, String snapshotHash) { }
}
