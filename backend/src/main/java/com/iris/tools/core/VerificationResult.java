package com.iris.tools.core;

import java.util.List;

public record VerificationResult(
        Status status,
        List<Evidence> evidence,
        String message
) {
    public VerificationResult {
        evidence = evidence == null ? List.of() : List.copyOf(evidence);
    }

    public enum Status {
        CONFIRMED,
        FAILED,
        UNKNOWN
    }

    public record Evidence(String kind, String reference, String summary) {
    }

    public static VerificationResult confirmed(List<Evidence> evidence) {
        return new VerificationResult(Status.CONFIRMED, evidence, null);
    }
}
