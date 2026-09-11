package com.iris.gateway.model;

import org.springframework.boot.ApplicationArguments;
import org.springframework.boot.ApplicationRunner;
import org.springframework.core.annotation.Order;
import org.springframework.jdbc.core.simple.JdbcClient;
import org.springframework.stereotype.Service;

import java.net.URI;
import java.time.Instant;
import java.util.List;
import java.util.concurrent.atomic.AtomicReference;

@Service
@Order(10)
public class ModelGatewayProfileCatalog implements ApplicationRunner {
    private static final String SETTING_KEY = "model.active_profile";

    private final ModelGatewayProperties properties;
    private final JdbcClient jdbc;
    private final AtomicReference<String> active;

    public ModelGatewayProfileCatalog(ModelGatewayProperties properties, JdbcClient jdbc) {
        this.properties = properties;
        this.jdbc = jdbc;
        this.active = new AtomicReference<>(properties.getActive());
    }

    @Override
    public void run(ApplicationArguments args) {
        jdbc.sql("SELECT setting_value FROM app_setting WHERE setting_key = :key")
                .param("key", SETTING_KEY)
                .query(String.class)
                .optional()
                .filter(this::configured)
                .ifPresent(active::set);
    }

    public String activeId() { return active.get(); }

    public ModelGatewayProperties.Profile activeProfile() {
        ModelGatewayProperties.Profile profile = properties.getProfiles().get(active.get());
        if (profile == null || !configured(active.get())) {
            throw new IllegalStateException("模型连接尚未配置");
        }
        return profile;
    }

    public List<ProfileView> views() {
        return properties.getProfiles().entrySet().stream()
                .filter(entry -> configured(entry.getKey()))
                .map(entry -> new ProfileView(
                        entry.getKey(),
                        entry.getValue().getKind(),
                        entry.getValue().getModelId(),
                        entry.getValue().effectiveEffort(),
                        entry.getKey().equals(active.get())
                ))
                .toList();
    }

    public void switchTo(String profileId) {
        if (!configured(profileId)) throw new UnknownProfileException(profileId);
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
    }

    private boolean configured(String profileId) {
        ModelGatewayProperties.Profile profile = properties.getProfiles().get(profileId);
        if (profile == null || "unconfigured".equalsIgnoreCase(profile.getKind())) return false;
        if (profile.getBaseUrl().isBlank() || profile.getModelId().isBlank() || profile.getApiKey().isBlank()) return false;
        URI uri = URI.create(profile.getBaseUrl());
        boolean local = "http".equalsIgnoreCase(uri.getScheme())
                && ("localhost".equalsIgnoreCase(uri.getHost()) || "127.0.0.1".equals(uri.getHost()));
        return "https".equalsIgnoreCase(uri.getScheme()) || local;
    }

    public record ProfileView(String id, String kind, String modelId, String effort, boolean active) { }

    public static class UnknownProfileException extends RuntimeException {
        public UnknownProfileException(String id) { super("Unknown model profile: " + id); }
    }
}
