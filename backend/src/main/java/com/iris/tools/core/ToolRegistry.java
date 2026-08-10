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
    private final Map<String, String> providerByName = new LinkedHashMap<>();

    public ToolRegistry(List<Tool> tools, ObjectMapper objectMapper) {
        List<String> invalid = new java.util.ArrayList<>();
        for (Tool tool : tools) {
            try {
                register(tool, objectMapper);
            } catch (RuntimeException exception) {
                invalid.add(exception.getMessage());
            }
        }
        if (!invalid.isEmpty()) {
            throw new IllegalStateException(
                    "本地 Tool provider 有 " + invalid.size()
                            + " 个无效定义：\n- "
                            + String.join("\n- ", invalid)
            );
        }
    }

    private synchronized void register(Tool tool, ObjectMapper objectMapper) {
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
        addBinding(binding, identity, "local-java");
    }

    /** Atomically replaces all live Tool bindings contributed by one provider. */
    public synchronized void replaceExternal(
            String providerKey,
            List<ExternalToolRegistration> registrations,
            ObjectMapper objectMapper
    ) {
        if (providerKey == null || providerKey.isBlank()) {
            throw new IllegalArgumentException("providerKey is required");
        }
        List<ToolBinding> bindings = new java.util.ArrayList<>();
        java.util.HashSet<String> incomingNames = new java.util.HashSet<>();
        java.util.HashSet<String> incomingIdentities = new java.util.HashSet<>();
        for (ExternalToolRegistration registration : registrations) {
            ToolManifest manifest = requireValidManifest(
                    registration.tool().manifest()
            );
            String path = requireExternalPath(registration.capabilityPath());
            String identity = manifest.id() + "@" + manifest.version();
            if (!incomingNames.add(manifest.name())
                    || !incomingIdentities.add(identity)) {
                throw new IllegalStateException(
                        "External provider contains duplicate Tool identity"
                );
            }
            String existingProvider = providerByName.get(manifest.name());
            if (existingProvider != null
                    && !providerKey.equals(existingProvider)) {
                throw new IllegalStateException(
                        "工具名冲突: " + manifest.name()
                );
            }
            ToolBinding existingIdentity = byIdentity.get(identity);
            if (existingIdentity != null
                    && !providerKey.equals(providerByName.get(
                            existingIdentity.manifest().name()
                    ))) {
                throw new IllegalStateException(
                        "工具定义身份冲突: " + identity
                );
            }
            bindings.add(new ToolBinding(
                    manifest,
                    path.substring(0, path.lastIndexOf('/')),
                    path,
                    manifestHash(objectMapper, manifest, path),
                    registration.tool()
            ));
        }
        removeProvider(providerKey);
        for (ToolBinding binding : bindings) {
            addBinding(
                    binding,
                    binding.manifest().id() + "@"
                            + binding.manifest().version(),
                    providerKey
            );
        }
    }

    public synchronized void unregisterExternal(String providerKey) {
        removeProvider(providerKey);
    }

    private void addBinding(
            ToolBinding binding,
            String identity,
            String providerKey
    ) {
        ToolBinding sameName = byName.putIfAbsent(
                binding.manifest().name(), binding
        );
        if (sameName != null) {
            throw new IllegalStateException(
                    "工具名冲突: " + binding.manifest().name()
            );
        }
        ToolBinding sameIdentity = byIdentity.putIfAbsent(identity, binding);
        if (sameIdentity != null) {
            byName.remove(binding.manifest().name());
            throw new IllegalStateException(
                    "工具定义身份冲突: " + identity
            );
        }
        providerByName.put(binding.manifest().name(), providerKey);
    }

    private void removeProvider(String providerKey) {
        List<String> names = providerByName.entrySet().stream()
                .filter(entry -> providerKey.equals(entry.getValue()))
                .map(Map.Entry::getKey)
                .toList();
        for (String name : names) {
            ToolBinding binding = byName.remove(name);
            providerByName.remove(name);
            if (binding != null) {
                byIdentity.remove(
                        binding.manifest().id() + "@"
                                + binding.manifest().version()
                );
            }
        }
    }

    private String requireExternalPath(String value) {
        if (value == null || !value.matches(
                "^/(?:[a-z0-9][a-z0-9_-]*/)*[a-z][a-z0-9_]*$"
        )) {
            throw new IllegalArgumentException(
                    "External capabilityPath is invalid"
            );
        }
        return value;
    }

    /** Computes the same immutable identity used by Registry registration. */
    public static ToolBinding describe(Tool tool, ObjectMapper objectMapper) {
        ToolManifest manifest = tool.manifest();
        String directoryPath = DomainCatalog.inferPath(tool.getClass());
        String capabilityPath = directoryPath + "/" + manifest.name();
        return new ToolBinding(
                manifest,
                directoryPath,
                capabilityPath,
                manifestHash(objectMapper, manifest, capabilityPath),
                tool
        );
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
        return manifestHash(objectMapper, manifest, capabilityPath);
    }

    private static String manifestHash(
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

    public synchronized Optional<ToolBinding> find(String name) {
        return Optional.ofNullable(byName.get(name));
    }

    public synchronized Optional<ToolBinding> findByCapabilityPath(String path) {
        if (path == null || path.isBlank()) {
            return Optional.empty();
        }
        return byName.values().stream()
                .filter(binding -> binding.capabilityPath().equals(path))
                .findFirst();
    }

    public synchronized Collection<ToolBinding> all() {
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

    public record ExternalToolRegistration(
            String capabilityPath,
            Tool tool
    ) { }
}
