package com.iris.tools.core;

import com.fasterxml.jackson.core.JsonProcessingException;
import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.iris.tools.catalog.DomainCatalog;
import org.springframework.stereotype.Component;

import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.security.NoSuchAlgorithmException;
import java.util.Collection;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Optional;
import java.util.regex.Pattern;

/**
 * 精确 Definition → implementation binding 注册表。
 */
@Component
public class ToolRegistry {
    private static final Pattern SNAKE_CASE =
            Pattern.compile("[a-z][a-z0-9]*(?:_[a-z0-9]+)*");

    private final Map<String, ToolBinding> byName = new LinkedHashMap<>();
    private final Map<String, ToolBinding> byIdentity = new LinkedHashMap<>();

    public ToolRegistry(List<Tool> tools, ObjectMapper objectMapper) {
        for (Tool tool : tools) {
            register(tool, objectMapper);
        }
    }

    private void register(Tool tool, ObjectMapper objectMapper) {
        ToolManifest manifest;
        try {
            manifest = requireValidManifest(tool.manifest());
        } catch (RuntimeException exception) {
            throw new IllegalStateException(
                    "工具定义无效 " + tool.getClass().getName()
                            + "：" + exception.getMessage(),
                    exception
            );
        }
        String directoryPath = DomainCatalog.inferPath(tool.getClass());
        String capabilityPath = directoryPath + "/" + manifest.name();
        String identity = manifest.id() + "@" + manifest.version();
        ToolBinding binding = new ToolBinding(
                manifest,
                directoryPath,
                capabilityPath,
                hash(objectMapper, manifest, capabilityPath),
                tool
        );

        ToolBinding sameName = byName.putIfAbsent(manifest.name(), binding);
        if (sameName != null) {
            throw new IllegalStateException(
                    "工具名冲突: " + manifest.name()
            );
        }
        ToolBinding sameIdentity = byIdentity.putIfAbsent(identity, binding);
        if (sameIdentity != null) {
            throw new IllegalStateException(
                    "工具定义身份冲突: " + identity
            );
        }
    }

    private ToolManifest requireValidManifest(ToolManifest manifest) {
        if (manifest == null) {
            throw new IllegalStateException("工具缺少 manifest");
        }
        requireText(manifest.id(), "manifest.id");
        requireText(manifest.version(), "manifest.version");
        requireText(manifest.description(), "manifest.description");
        if (manifest.name() == null
                || !SNAKE_CASE.matcher(manifest.name()).matches()) {
            throw new IllegalStateException(
                    "工具 name 必须为 snake_case: " + manifest.name()
            );
        }
        validateSchema(manifest.inputSchema(), "inputSchema");
        validateSchema(manifest.outputSchema(), "outputSchema");
        if (manifest.riskLevel() == null || manifest.sideEffect() == null) {
            throw new IllegalStateException("工具缺少风险或副作用声明");
        }
        if (manifest.riskLevel() == RiskLevel.READ_ONLY
                && manifest.sideEffect() != ToolManifest.SideEffect.NONE) {
            throw new IllegalStateException(
                    "read_only 工具必须声明 sideEffect=none"
            );
        }
        if (manifest.riskLevel() != RiskLevel.READ_ONLY
                && manifest.sideEffect() == ToolManifest.SideEffect.NONE) {
            throw new IllegalStateException(
                    "写工具不能声明 sideEffect=none"
            );
        }
        if (manifest.timeoutSeconds() <= 0
                || manifest.resultCharacterLimit() <= 0
                || manifest.idempotency() == null
                || manifest.evidencePolicy() == null
                || manifest.contextRetention() == null
                || manifest.concurrency() == null
                || manifest.cancellation() == null) {
            throw new IllegalStateException("工具运行策略声明不完整");
        }
        if (manifest.concurrency()
                == ToolManifest.ConcurrencySemantics.PARALLEL_SAFE
                && (manifest.riskLevel() != RiskLevel.READ_ONLY
                || manifest.sideEffect() != ToolManifest.SideEffect.NONE)) {
            throw new IllegalStateException(
                    "parallel_safe 首版只允许无副作用只读工具"
            );
        }
        if (manifest.cancellation()
                == ToolManifest.CancellationSemantics.COOPERATIVE
                && manifest.sideEffect() != ToolManifest.SideEffect.NONE) {
            throw new IllegalStateException(
                    "有副作用工具不能声明 cooperative cancellation"
            );
        }
        return manifest;
    }

    private void validateSchema(JsonNode schema, String field) {
        if (schema == null
                || !"object".equals(schema.path("type").asText())
                || !schema.path("properties").isObject()) {
            throw new IllegalStateException(
                    field + " 必须是带 properties 的 object JSON Schema"
            );
        }
        schema.path("properties").fields().forEachRemaining(entry -> {
            JsonNode property = entry.getValue();
            if (property.path("description").asText().isBlank()) {
                throw new IllegalStateException(
                        field + "." + entry.getKey() + " 缺少 description"
                );
            }
        });
    }

    private void requireText(String value, String field) {
        if (value == null || value.isBlank()) {
            throw new IllegalStateException("工具缺少 " + field);
        }
    }

    private String hash(
            ObjectMapper objectMapper,
            ToolManifest manifest,
            String capabilityPath
    ) {
        try {
            byte[] manifestBytes = objectMapper.writeValueAsBytes(manifest);
            MessageDigest digest = MessageDigest.getInstance("SHA-256");
            digest.update(manifestBytes);
            digest.update(capabilityPath.getBytes(StandardCharsets.UTF_8));
            return java.util.HexFormat.of().formatHex(digest.digest());
        } catch (JsonProcessingException | NoSuchAlgorithmException exception) {
            throw new IllegalStateException(
                    "无法计算工具 Manifest hash",
                    exception
            );
        }
    }

    public Optional<ToolBinding> find(String name) {
        return Optional.ofNullable(byName.get(name));
    }

    public Collection<ToolBinding> all() {
        return List.copyOf(byName.values());
    }

    public record ToolBinding(
            ToolManifest manifest,
            String directoryPath,
            String capabilityPath,
            String manifestHash,
            Tool tool
    ) {
    }
}
