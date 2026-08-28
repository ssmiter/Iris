package com.iris.agent.model;

import com.iris.agent.model.ModelRequest.ToolDefinition;
import com.iris.tools.core.CapabilityAvailabilityService;
import com.iris.tools.core.ToolManifest;
import com.iris.tools.core.ToolRegistry;
import com.iris.tools.core.ToolRegistry.ToolBinding;
import org.springframework.stereotype.Service;

import java.util.ArrayList;
import java.util.LinkedHashSet;
import java.util.List;

/**
 * Freezes the complete, ordered provider-visible tool surface.
 *
 * <p>The primary agent does not admit optional domain schemas here. If a
 * resident primitive is missing, unavailable or too large, context assembly
 * fails closed instead of silently changing the protocol.</p>
 *
 * <p>双通道装配（docs/42 §4 P1 第 6 条）：发现层只看 manifest 的一句话
 * description；驻留工具的 schema 本就常驻 provider surface（即「已被
 * 选中」），其完整行为合同 prompt 在此与 description 拼接进入请求，
 * 而非另开发现通道。prompt 为 null 时描述保持原样，前缀稳定。</p>
 */
@Service
public final class ProviderToolSurfacePlanner {
    private final ToolRegistry tools;
    private final ModelTokenEstimator tokens;
    private final CapabilityAvailabilityService availability;

    public ProviderToolSurfacePlanner(
            ToolRegistry tools,
            ModelTokenEstimator tokens,
            CapabilityAvailabilityService availability
    ) {
        this.tools = tools;
        this.tokens = tokens;
        this.availability = availability;
    }

    public SurfacePlan plan(
            List<String> orderedNames,
            int maxSchemaTokens
    ) {
        if (maxSchemaTokens < 1) {
            throw new IllegalArgumentException(
                    "Provider tool schema budget must be positive"
            );
        }
        LinkedHashSet<String> uniqueNames =
                new LinkedHashSet<>(orderedNames);
        if (uniqueNames.size() != orderedNames.size()) {
            throw new IllegalArgumentException(
                    "Provider tool surface contains duplicate names"
            );
        }

        List<ToolDefinition> definitions = new ArrayList<>();
        for (String name : uniqueNames) {
            ToolBinding binding = tools.find(name).orElseThrow(
                    () -> new IllegalStateException(
                            "Resident tool is not registered: " + name
                    )
            );
            availability.requireExecutable(binding);
            definitions.add(new ToolDefinition(
                    binding.manifest().name(),
                    providerDescription(binding.manifest()),
                    binding.manifest().inputSchema(),
                    binding.manifestHash()
            ));
        }

        int estimatedTokens = tokens.estimate(definitions);
        if (estimatedTokens > maxSchemaTokens) {
            throw new PromptTooLargeException(
                    "Resident provider tools exceed the schema budget"
            );
        }
        return new SurfacePlan(
                List.copyOf(uniqueNames),
                estimatedTokens,
                maxSchemaTokens
        );
    }

    /**
     * 驻留工具进请求的描述：一句话 description 拼上可选的行为合同
     * prompt（ToolManifest.prompt），未声明 prompt 时逐字不变。
     */
    private static String providerDescription(ToolManifest manifest) {
        if (manifest.prompt() == null) {
            return manifest.description();
        }
        return manifest.description() + "\n\n" + manifest.prompt();
    }

    public record SurfacePlan(
            List<String> toolNames,
            int estimatedSchemaTokens,
            int maxSchemaTokens
    ) {
        public SurfacePlan {
            toolNames = List.copyOf(toolNames);
        }
    }
}
