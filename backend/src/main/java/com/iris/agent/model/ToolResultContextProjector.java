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
    private static final int PREVIEW_CHARACTER_COUNT = 300;
    private static final String TRUNCATION_MARK = "…";

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
        JsonNode previousOutput = content.path("output");
        ObjectNode output = objectMapper.createObjectNode();
        output.put("contextProjection", "reference");
        output.put("resultReference", "tool-result://" + executionId);
        output.put("contentHash", payloadHash);
        writePreview(output, previousOutput);
        output.put(
                "guidance",
                "旧结果已从当前视野收敛，preview 只保留开头片段；"
                        + "需要完整内容时调用 read_tool_result 读回"
        );
        content.set("output", output);
        return content;
    }

    /**
     * 预览是纯文本截断片段，不保证是合法 JSON；previewTruncated 与尾部
     * 省略标记表明它被截断。原输出已是引用投影时沿用既有预览，不随
     * 再次投影改写旧前缀。
     */
    private void writePreview(ObjectNode projection, JsonNode previousOutput) {
        if (previousOutput == null
                || previousOutput.isMissingNode()
                || previousOutput.isNull()) {
            return;
        }
        if (previousOutput.isObject()
                && "reference".equals(
                        previousOutput.path("contextProjection").asText())) {
            JsonNode existing = previousOutput.path("preview");
            if (existing.isTextual()) {
                projection.put("preview", existing.asText());
                projection.put(
                        "previewTruncated",
                        previousOutput.path("previewTruncated").asBoolean()
                );
            }
            return;
        }
        String text = previousOutput.isTextual()
                ? previousOutput.asText()
                : previousOutput.toString();
        if (text.isEmpty()) {
            return;
        }
        boolean truncated = text.length() > PREVIEW_CHARACTER_COUNT;
        if (!truncated) {
            projection.put("preview", text);
            projection.put("previewTruncated", false);
            return;
        }
        int end = PREVIEW_CHARACTER_COUNT;
        if (Character.isHighSurrogate(text.charAt(end - 1))) {
            end--;
        }
        projection.put(
                "preview",
                text.substring(0, end) + TRUNCATION_MARK
        );
        projection.put("previewTruncated", true);
    }

    private boolean blank(String value) {
        return value == null || value.isBlank();
    }
}
