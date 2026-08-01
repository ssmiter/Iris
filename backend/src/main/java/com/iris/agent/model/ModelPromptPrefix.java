package com.iris.agent.model;

/**
 * Provider-visible stable prefix identity for one model request.
 *
 * <p>The full context may grow every round. This identity changes only when
 * the system prompt definition or the ordered tool schemas change.</p>
 */
public record ModelPromptPrefix(
        String promptDefinitionId,
        int promptVersion,
        String promptHash,
        String toolSchemaHash,
        String prefixHash
) {
    public ModelPromptPrefix {
        requireText(promptDefinitionId, "promptDefinitionId");
        if (promptVersion < 1) {
            throw new IllegalArgumentException("promptVersion must be positive");
        }
        requireHash(promptHash, "promptHash");
        requireHash(toolSchemaHash, "toolSchemaHash");
        requireHash(prefixHash, "prefixHash");
    }

    private static void requireText(String value, String name) {
        if (value == null || value.isBlank()) {
            throw new IllegalArgumentException(name + " cannot be blank");
        }
    }

    private static void requireHash(String value, String name) {
        if (value == null || !value.matches("[0-9a-f]{64}")) {
            throw new IllegalArgumentException(name + " must be a SHA-256 hash");
        }
    }
}
