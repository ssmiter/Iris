package com.iris.tools.core;

import com.fasterxml.jackson.databind.JsonNode;

/**
 * Resolves a stable provider-visible tool call to one concrete runtime tool.
 * The provider transcript keeps the proxy call; policy and execution use the
 * resolved target.
 */
public interface ToolCallResolver {
    ResolvedToolCall resolve(JsonNode input, ToolContext context);

    record ResolvedToolCall(
            String targetToolName,
            String targetCapabilityPath,
            String targetManifestHash,
            JsonNode arguments
    ) {
        public ResolvedToolCall {
            if (targetToolName == null || targetToolName.isBlank()
                    || targetCapabilityPath == null
                    || targetCapabilityPath.isBlank()
                    || targetManifestHash == null
                    || !targetManifestHash.matches("[0-9a-f]{64}")
                    || arguments == null || !arguments.isObject()) {
                throw new IllegalArgumentException(
                        "Resolved tool call is incomplete"
                );
            }
            arguments = arguments.deepCopy();
        }
    }
}
