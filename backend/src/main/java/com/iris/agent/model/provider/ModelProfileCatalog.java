package com.iris.agent.model.provider;

import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.boot.ApplicationArguments;
import org.springframework.boot.ApplicationRunner;
import org.springframework.core.annotation.Order;
import org.springframework.jdbc.core.simple.JdbcClient;
import org.springframework.stereotype.Service;

import java.time.Instant;
import java.util.List;
import java.util.concurrent.atomic.AtomicReference;

/**
 * 活跃模型 profile 的运行时选择。启动顺序：yml 的 {@code iris.model.active}
 * 先行生效，随后（{@link #run}，schema 已就位）读取 app_setting 里持久化的
 * 选择覆盖；持久化值指向已不存在的 profile 时回落 yml 默认并告警。
 * 切换立即生效于之后启动的 Run/Compaction，不重启、不回改历史事实。
 */
@Service
@Order(10)
public class ModelProfileCatalog implements ApplicationRunner {
    private static final Logger log =
            LoggerFactory.getLogger(ModelProfileCatalog.class);
    private static final String SETTING_KEY = "model.active_profile";

    private final ModelProviderRegistry providers;
    private final JdbcClient jdbc;
    private final AtomicReference<String> active;

    public ModelProfileCatalog(
            IrisModelProperties properties,
            ModelProviderRegistry providers,
            JdbcClient jdbc
    ) {
        this.providers = providers;
        this.jdbc = jdbc;
        this.active = new AtomicReference<>(properties.getActive());
    }

    @Override
    public void run(ApplicationArguments args) {
        String persisted = jdbc
                .sql("SELECT setting_value FROM app_setting"
                        + " WHERE setting_key = :key")
                .param("key", SETTING_KEY)
                .query(String.class)
                .optional()
                .orElse(null);
        if (persisted == null) {
            return;
        }
        if (providers.configured(persisted)) {
            active.set(persisted);
            log.info("Model profile restored from settings: {}", persisted);
        } else {
            log.warn(
                    "Persisted model profile '{}' is no longer configured; "
                            + "falling back to '{}'",
                    persisted,
                    active.get()
            );
        }
    }

    public String activeProfile() {
        return active.get();
    }

    public List<ProfileSummary> profiles() {
        String current = active.get();
        return providers.all().stream()
                .map(provider -> new ProfileSummary(
                        provider.profileId(),
                        provider.providerKind(),
                        provider.modelId(),
                        provider.effort(),
                        provider.profileId().equals(current)
                ))
                .toList();
    }

    public ProfileSummary switchTo(String profileId) {
        ModelProvider provider;
        try {
            provider = providers.require(profileId);
        } catch (IllegalArgumentException unknown) {
            throw new UnknownModelProfileException(profileId);
        }
        jdbc.sql("""
                INSERT INTO app_setting(setting_key, setting_value, updated_at)
                VALUES (:key, :value, :now)
                ON CONFLICT(setting_key) DO UPDATE SET
                    setting_value = excluded.setting_value,
                    updated_at = excluded.updated_at
                """)
                .param("key", SETTING_KEY)
                .param("value", profileId)
                .param("now", Instant.now().toString())
                .update();
        active.set(profileId);
        log.info("Model profile switched to {}", profileId);
        return new ProfileSummary(
                provider.profileId(),
                provider.providerKind(),
                provider.modelId(),
                provider.effort(),
                true
        );
    }

    /** 不含 api-key 等秘密；base-url 也只留在 adapter 内部。 */
    public record ProfileSummary(
            String id,
            String kind,
            String modelId,
            String effort,
            boolean active
    ) {
    }

    public static class UnknownModelProfileException
            extends RuntimeException {
        public UnknownModelProfileException(String profileId) {
            super("Unknown model profile: " + profileId);
        }
    }
}
