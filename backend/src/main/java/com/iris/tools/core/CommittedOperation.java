package com.iris.tools.core;

import com.fasterxml.jackson.databind.JsonNode;

import java.util.List;

public record CommittedOperation(
        String executionId,
        String snapshotId,
        String snapshotHash,
        JsonNode normalizedInput,
        List<PreparedOperation.ResourceClaim> resources
) {
    public CommittedOperation {
        resources = List.copyOf(resources);
    }
}
