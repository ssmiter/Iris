package com.iris.sandbox;

import com.iris.tools.core.CapabilityAvailability.Status;
import com.iris.tools.core.ToolAvailabilityProbe;
import com.iris.tools.core.ToolRegistry.ToolBinding;
import org.springframework.stereotype.Component;

import java.util.Optional;

@Component
public class PythonSandboxAvailabilityProbe
        implements ToolAvailabilityProbe {
    private final PythonAnalysisSandbox sandbox;

    public PythonSandboxAvailabilityProbe(PythonAnalysisSandbox sandbox) {
        this.sandbox = sandbox;
    }

    @Override
    public Optional<Assessment> assess(ToolBinding binding) {
        if (!"execute_python_analysis".equals(
                binding.manifest().name()
        )) {
            return Optional.empty();
        }
        PythonAnalysisSandbox.Assessment runtime = sandbox.assessment();
        if (!runtime.executable()) {
            return Optional.of(new Assessment(
                    Status.UNAVAILABLE,
                    runtime.reason()
            ));
        }
        return Optional.of(new Assessment(
                runtime.degraded() ? Status.DEGRADED : Status.AVAILABLE,
                runtime.reason()
        ));
    }
}
