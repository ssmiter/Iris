package com.iris.tools.core;

import com.fasterxml.jackson.databind.JsonNode;

public record ToolManifest(
        String id,
        String version,
        String name,
        String description,
        JsonNode inputSchema,
        JsonNode outputSchema,
        RiskLevel riskLevel,
        SideEffect sideEffect,
        int timeoutSeconds,
        int resultCharacterLimit,
        IdempotencySemantics idempotency,
        EvidencePolicy evidencePolicy
) {
    public enum SideEffect {
        NONE,
        WORKSPACE_WRITE,
        EXTERNAL_WRITE,
        DESTRUCTIVE
    }

    public enum IdempotencySemantics {
        IDEMPOTENT,
        IDEMPOTENT_WITH_KEY,
        NON_IDEMPOTENT
    }

    public enum EvidencePolicy {
        NONE,
        SUMMARY,
        REQUIRED
    }
}
