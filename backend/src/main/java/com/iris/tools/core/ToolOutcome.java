package com.iris.tools.core;

import com.fasterxml.jackson.databind.JsonNode;

public record ToolOutcome(
        Kind kind,
        JsonNode output,
        String errorCode,
        String message,
        boolean mayHaveChangedExternalState
) {
    public enum Kind {
        SUCCEEDED,
        FAILED,
        OUTCOME_UNKNOWN
    }

    public static ToolOutcome succeeded(JsonNode output) {
        return new ToolOutcome(Kind.SUCCEEDED, output, null, null, false);
    }

    public static ToolOutcome failed(String errorCode, String message) {
        return new ToolOutcome(Kind.FAILED, null, errorCode, message, false);
    }

    public static ToolOutcome unknown(String errorCode, String message) {
        return new ToolOutcome(
                Kind.OUTCOME_UNKNOWN,
                null,
                errorCode,
                message,
                true
        );
    }
}
