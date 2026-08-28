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
import java.util.Set;

/**
 * 按 {@code iris.model.profiles} 逐 profile 构造 provider 并登记注册表。
 * kind 缺省或为 {@code unconfigured} 的条目跳过（env 占位默认值）；
 * 其他未知 kind 直接 fail-close，避免静默丢失配置错误。
 * effort 档位（docs/42 §3）在注册时校验取值并核对 kind 支持度：
 * 非法值 fail-close，kind 不支持则 WARN 可诊断、不静默吞。
 */
@Configuration
@EnableConfigurationProperties(IrisModelProperties.class)
public class ModelProviderConfiguration {
    private static final Logger log =
            LoggerFactory.getLogger(ModelProviderConfiguration.class);
    private static final Set<String> EFFORT_VALUES =
            Set.of("low", "medium", "high");
    /**
     * 能把 effort 映射进请求体的 kind。openai-compatible 一律透传
     * {@code reasoning_effort}，不支持的 provider 自行忽略未知参数；
     * anthropic kind 落地时其对应机制（thinking budget）在请求装配处
     * 映射并登记到这里，未登记前由下方的 WARN 保证可诊断。
     */
    private static final Set<String> EFFORT_REQUEST_KINDS =
            Set.of("openai-compatible");

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
            validateEffort(profileId, kind, profile);
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

    /**
     * effort 取值非法直接拒绝启动（fail-close）；取值合法但 kind 没有
     * 对应请求机制时记一条 WARN——档位被忽略必须可诊断，不静默降语义。
     */
    private void validateEffort(String profileId, String kind, Profile profile) {
        String effort = profile.getEffort();
        if (effort == null || effort.isBlank()) {
            return;
        }
        if (!EFFORT_VALUES.contains(effort)) {
            throw new IllegalStateException(
                    "模型 profile '" + profileId + "' 的 effort 值 '" + effort
                            + "' 不合法，只接受 low/medium/high"
                            + "（不配置则按 medium 处理）"
            );
        }
        if (!EFFORT_REQUEST_KINDS.contains(kind)) {
            log.warn(
                    "模型 profile '{}' 声明 effort={}，但 kind '{}' 不支持"
                            + "该请求参数，已忽略",
                    profileId,
                    effort,
                    kind
            );
        }
    }
}
