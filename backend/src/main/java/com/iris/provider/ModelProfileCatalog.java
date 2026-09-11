package com.iris.provider;

import com.iris.gateway.model.ModelGatewayProfileCatalog;
import com.iris.gateway.model.ModelGatewayProfileCatalog.ProfileView;
import com.iris.gateway.model.ModelGatewayProperties;
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

    private final ModelGatewayProfileCatalog gateway;
    private final ModelGatewayProperties properties;
    private final JdbcClient jdbc;
    private final AtomicReference<String> active;

    public ModelProfileCatalog(
            ModelGatewayProperties properties,
            ModelGatewayProfileCatalog gateway,
            JdbcClient jdbc
    ) {
        this.gateway = gateway;
        this.properties = properties;
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
        if (gateway.views().stream().anyMatch(view -> view.id().equals(persisted))) {
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
        return gateway.views().stream()
                .map(view -> new ProfileSummary(
                        view.id(),
                        view.kind(),
                        view.modelId(),
                        view.effort(),
                        view.id().equals(current)
                ))
                .toList();
    }

    public ProfileSummary switchTo(String profileId) {
        ProfileView provider;
        try {
            gateway.switchTo(profileId);
            provider = gateway.views().stream()
                    .filter(view -> view.id().equals(profileId))
                    .findFirst()
                    .orElseThrow();
        } catch (ModelGatewayProfileCatalog.UnknownProfileException unknown) {
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
                provider.id(),
                provider.kind(),
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
