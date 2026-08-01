package com.iris.agent.model;

import com.fasterxml.jackson.core.JsonProcessingException;
import com.fasterxml.jackson.databind.ObjectMapper;
import org.springframework.stereotype.Component;

import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.security.NoSuchAlgorithmException;
import java.util.HexFormat;
import java.util.List;

@Component
public final class ModelPromptPrefixService {
    private final ObjectMapper objectMapper;

    public ModelPromptPrefixService(ObjectMapper objectMapper) {
        this.objectMapper = objectMapper;
    }

    public ModelPromptPrefix capture(
            String definitionId,
            int version,
            String systemInstruction,
            List<ModelRequest.ToolDefinition> orderedTools
    ) {
        String promptHash = hash(systemInstruction);
        List<ProviderVisibleTool> visibleTools = orderedTools.stream()
                .map(tool -> new ProviderVisibleTool(
                        tool.name(),
                        tool.description(),
                        tool.inputSchema()
                ))
                .toList();
        String toolsJson = write(visibleTools);
        String toolSchemaHash = hash(toolsJson);
        String prefixHash = hash(write(new PrefixPayload(
                definitionId,
                version,
                systemInstruction,
                visibleTools
        )));
        return new ModelPromptPrefix(
                definitionId,
                version,
                promptHash,
                toolSchemaHash,
                prefixHash
        );
    }

    private String write(Object value) {
        try {
            return objectMapper.writeValueAsString(value);
        } catch (JsonProcessingException exception) {
            throw new IllegalStateException("Unable to serialize prompt prefix", exception);
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
            throw new IllegalStateException("SHA-256 unavailable", exception);
        }
    }

    private record PrefixPayload(
            String promptDefinitionId,
            int promptVersion,
            String systemInstruction,
            List<ProviderVisibleTool> tools
    ) {
    }

    private record ProviderVisibleTool(
            String name,
            String description,
            com.fasterxml.jackson.databind.JsonNode parameters
    ) {
    }
}
