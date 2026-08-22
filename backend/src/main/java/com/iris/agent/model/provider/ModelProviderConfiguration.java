package com.iris.agent.model.provider;

import com.fasterxml.jackson.databind.ObjectMapper;
import com.iris.agent.model.provider.IrisModelProperties.Profile;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.boot.context.properties.EnableConfigurationProperties;
import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Configuration;
import org.springframework.web.reactive.function.client.WebClient;

import java.util.ArrayList;
import java.util.List;
import java.util.Map;

/**
 * 按 {@code iris.model.profiles} 逐 profile 构造 provider 并登记注册表。
 * kind 缺省或为 {@code unconfigured} 的条目跳过（env 占位默认值）；
 * 其他未知 kind 直接 fail-close，避免静默丢失配置错误。
 */
@Configuration
@EnableConfigurationProperties(IrisModelProperties.class)
public class ModelProviderConfiguration {
    private static final Logger log =
            LoggerFactory.getLogger(ModelProviderConfiguration.class);

    @Bean
    public ModelProviderRegistry modelProviderRegistry(
            IrisModelProperties properties,
            ProviderMessageCompiler compiler,
            ObjectMapper objectMapper,
            WebClient.Builder webClient
    ) {
        List<ModelProvider> providers = new ArrayList<>();
        for (Map.Entry<String, Profile> entry
                : properties.getProfiles().entrySet()) {
            String profileId = entry.getKey();
            Profile profile = entry.getValue();
            String kind = profile.getKind();
            if (kind == null || kind.isBlank() || "unconfigured".equals(kind)) {
                continue;
            }
            switch (kind) {
                case "openai-compatible" -> providers.add(
                        new OpenAiCompatibleModelProvider(
                                profileId,
                                profile,
                                compiler,
                                objectMapper,
                                webClient
                        )
                );
                default -> throw new IllegalStateException(
                        "Unknown model provider kind '" + kind
                                + "' for profile: " + profileId
                );
            }
        }
        log.info(
                "Model provider profiles registered: {}",
                providers.stream().map(ModelProvider::profileId).toList()
        );
        return new ModelProviderRegistry(providers);
    }
}
