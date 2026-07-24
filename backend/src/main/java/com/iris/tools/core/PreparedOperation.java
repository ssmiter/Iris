package com.iris.tools.core;

import com.fasterxml.jackson.databind.JsonNode;

import java.time.Instant;
import java.util.List;

public record PreparedOperation(
        JsonNode normalizedInput,
        String impactStatement,
        List<ResourceClaim> resources,
        Instant expiresAt
) {
    public PreparedOperation {
        resources = resources == null ? List.of() : List.copyOf(resources);
    }

    public record ResourceClaim(
            String kind,
            String logicalPath,
            String expectedVersion
    ) {
    }
}
