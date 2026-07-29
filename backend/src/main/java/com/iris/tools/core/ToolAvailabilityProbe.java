package com.iris.tools.core;

import com.iris.tools.core.ToolRegistry.ToolBinding;

import java.util.Optional;

/**
 * 某类 Tool 对 Application/Environment 的当前依赖检查。
 * 不支持的 binding 返回 empty，不用伪造 available。
 */
public interface ToolAvailabilityProbe {

    Optional<Assessment> assess(ToolBinding binding);

    record Assessment(
            CapabilityAvailability.Status status,
            String reason
    ) {
        public Assessment {
            if (status == null) {
                throw new IllegalArgumentException(
                        "Availability assessment requires status"
                );
            }
        }
    }
}
