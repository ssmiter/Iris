package com.iris.agent.model;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.node.ObjectNode;
import com.iris.tools.core.ToolManifest.ContextRetention;
import com.iris.tools.core.ToolRegistry;
import com.iris.tools.core.ToolRegistry.ToolBinding;
import org.springframework.stereotype.Service;

/**
 * Decides whether a durable tool result may become a reference in a model
 * context and builds that provider-visible projection. Canonical observations
 * and payloads are never rewritten.
 */
@Service
public final class ToolResultContextProjector {
    private final ToolRegistry tools;
    private final ObjectMapper objectMapper;

    public ToolResultContextProjector(
            ToolRegistry tools,
            ObjectMapper objectMapper
    ) {
        this.tools = tools;
        this.objectMapper = objectMapper;
    }

    public boolean canReplace(
            String outcomeKind,
            String executionId,
            String payloadHash,
            String resolvedToolName,
            String manifestHash
    ) {
        if (!"succeeded".equals(outcomeKind)
                || blank(executionId)
                || blank(payloadHash)
                || blank(resolvedToolName)
                || blank(manifestHash)) {
            return false;
        }
        ToolBinding binding = tools.find(resolvedToolName).orElse(null);
        return binding != null
                && binding.manifestHash().equals(manifestHash)
                && binding.manifest().contextRetention()
                == ContextRetention.REFETCHABLE;
    }

    public ObjectNode toReference(
            JsonNode original,
            String visibleToolName,
            String resolvedToolName,
            String executionId,
            String payloadHash
    ) {
        ObjectNode content = original != null && original.isObject()
                ? ((ObjectNode) original).deepCopy()
                : objectMapper.createObjectNode();
        content.put(
                "toolName",
                blank(visibleToolName) ? resolvedToolName : visibleToolName
        );
        if (!blank(resolvedToolName)
                && !resolvedToolName.equals(content.path("toolName").asText())) {
            content.put("resolvedToolName", resolvedToolName);
        }
        content.put("status", "succeeded");
        content.put("isError", false);
        content.put("resultRef", "tool-result://" + executionId);
        ObjectNode output = objectMapper.createObjectNode();
        output.put("contextProjection", "reference");
        output.put("resultReference", "tool-result://" + executionId);
        output.put("contentHash", payloadHash);
        output.put(
                "guidance",
                "旧的可重取结果已从当前视野收敛；需要原文时调用 read_tool_result"
        );
        content.set("output", output);
        return content;
    }

    private boolean blank(String value) {
        return value == null || value.isBlank();
    }
}
