package com.iris.agent.model.provider;

import java.time.Duration;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

/**
 * 已配置的 provider profile 全集。由 {@link ModelProviderConfiguration}
 * 按 {@code iris.model.profiles} 构造；活跃 profile 的选择归
 * {@link ModelProfileCatalog}。
 */
public class ModelProviderRegistry {
    private final Map<String, ModelProvider> profiles;

    public ModelProviderRegistry(List<ModelProvider> providers) {
        Map<String, ModelProvider> configured = new LinkedHashMap<>();
        for (ModelProvider provider : providers) {
            validate(provider);
            ModelProvider duplicate = configured.putIfAbsent(
                    provider.profileId(),
                    provider
            );
            if (duplicate != null) {
                throw new IllegalStateException(
                        "Duplicate model provider profile: "
                                + provider.profileId()
                );
            }
        }
        profiles = Map.copyOf(configured);
    }

    public ModelProvider require(String profileId) {
        if (profileId == null || profileId.isBlank()) {
            throw new IllegalArgumentException(
                    "Model provider profile is required"
            );
        }
        ModelProvider provider = profiles.get(profileId);
        if (provider == null) {
            throw new IllegalArgumentException(
                    "Unknown model provider profile: " + profileId
            );
        }
        return provider;
    }

    public boolean configured(String profileId) {
        return profileId != null && profiles.containsKey(profileId);
    }

    public List<ModelProvider> all() {
        return List.copyOf(profiles.values());
    }

    private void validate(ModelProvider provider) {
        if (provider == null
                || blank(provider.profileId())
                || blank(provider.providerKind())
                || blank(provider.modelId())
                || provider.timeout() == null
                || provider.timeout().isZero()
                || provider.timeout().isNegative()
                || provider.timeout().compareTo(Duration.ofMinutes(30)) > 0) {
            throw new IllegalStateException(
                    "Model provider profile is incomplete"
            );
        }
    }

    private boolean blank(String value) {
        return value == null || value.isBlank();
    }
}
