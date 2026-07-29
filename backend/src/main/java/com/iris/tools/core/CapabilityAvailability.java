package com.iris.tools.core;

import java.time.Instant;

/**
 * 当前 binding 与其 Application/Environment 依赖能否承接调用。
 * 它是可重建状态，不属于不可变 Tool Definition。
 */
public record CapabilityAvailability(
        Status status,
        String reason,
        Instant checkedAt
) {
    public CapabilityAvailability {
        if (status == null || checkedAt == null) {
            throw new IllegalArgumentException(
                    "Capability availability is incomplete"
            );
        }
        reason = reason == null || reason.isBlank()
                ? defaultReason(status)
                : reason;
    }

    public boolean executable() {
        return status != Status.UNAVAILABLE;
    }

    public String value() {
        return status.name().toLowerCase(java.util.Locale.ROOT);
    }

    private static String defaultReason(Status status) {
        return switch (status) {
            case AVAILABLE -> "当前 binding 可以承接调用";
            case DEGRADED -> "当前 binding 可用，但存在运行限制";
            case UNAVAILABLE -> "当前 binding 无法承接调用";
        };
    }

    public enum Status {
        AVAILABLE,
        DEGRADED,
        UNAVAILABLE
    }
}
