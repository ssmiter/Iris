package com.iris.tools.core;

import com.iris.tools.core.CapabilityAvailability.Status;
import com.iris.tools.core.ToolAvailabilityProbe.Assessment;
import com.iris.tools.core.ToolRegistry.ToolBinding;
import org.springframework.stereotype.Service;

import java.time.Clock;
import java.util.ArrayList;
import java.util.List;

/**
 * Tool binding availability 的内存真相。
 *
 * 多个 probe 可同时约束一个 binding，采用最严格状态；没有 probe 的本地
 * Java Tool 由 Registry binding 本身证明 available。
 */
@Service
public class CapabilityAvailabilityService {

    private final List<ToolAvailabilityProbe> probes;
    private final Clock clock = Clock.systemUTC();

    public CapabilityAvailabilityService(
            List<ToolAvailabilityProbe> probes
    ) {
        this.probes = List.copyOf(probes);
    }

    public CapabilityAvailability current(ToolBinding binding) {
        Status status = Status.AVAILABLE;
        List<String> reasons = new ArrayList<>();
        boolean assessed = false;
        for (ToolAvailabilityProbe probe : probes) {
            java.util.Optional<Assessment> result =
                    probe.assess(binding);
            if (result.isEmpty()) {
                continue;
            }
            assessed = true;
            Assessment assessment = result.get();
            if (severity(assessment.status()) > severity(status)) {
                status = assessment.status();
            }
            if (assessment.reason() != null
                    && !assessment.reason().isBlank()) {
                reasons.add(assessment.reason());
            }
        }
        String reason = assessed
                ? String.join("；", reasons)
                : "本地 Java executor binding 已注册";
        return new CapabilityAvailability(
                status,
                reason,
                clock.instant()
        );
    }

    public CapabilityAvailability requireExecutable(ToolBinding binding) {
        CapabilityAvailability availability = current(binding);
        if (!availability.executable()) {
            throw new ToolRuntimeException(
                    "capability_unavailable",
                    "能力 " + binding.manifest().name()
                            + " 当前不可用：" + availability.reason()
            );
        }
        return availability;
    }

    private int severity(Status status) {
        return switch (status) {
            case AVAILABLE -> 0;
            case DEGRADED -> 1;
            case UNAVAILABLE -> 2;
        };
    }
}
