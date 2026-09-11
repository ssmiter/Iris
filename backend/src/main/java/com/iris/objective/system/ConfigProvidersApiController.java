package com.iris.objective.system;

import com.iris.gateway.model.ModelGatewayProperties;
import org.springframework.http.HttpStatus;
import org.springframework.http.ResponseEntity;
import org.springframework.jdbc.core.simple.JdbcClient;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.PutMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RestController;
import org.springframework.web.server.ResponseStatusException;

import java.time.Instant;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

/**
 * WonWork 契约 /api/config/providers（对照 ConfigController.cs + ConfigService.cs）。
 *
 * <p>WonWork 的数据源是平台库 AiProviderConfig 表（内置 BYOK 目录为熔断回退）；
 * Iris 本地单用户无平台库：yml 配置的模型 profile（ModelGatewayProperties）即
 * 内置目录，用户在设置页的改动落 user_config 表叠加（同 provider 以 user_config 为准，
 * 对齐 WonWork "同名 provider 以 DB 为准"语义）。形状 = ProviderConfig[]：
 * {provider, model, baseUrl, isEnabled}。</p>
 */
@RestController
@RequestMapping("/api/config")
public class ConfigProvidersApiController {

    private final ModelGatewayProperties properties;
    private final JdbcClient jdbc;

    public ConfigProvidersApiController(
            ModelGatewayProperties properties,
            JdbcClient jdbc
    ) {
        this.properties = properties;
        this.jdbc = jdbc;
    }

    /** GET /api/config/providers —— provider 清单（yml 种子 ∪ user_config 叠加）。 */
    @GetMapping("/providers")
    public List<Map<String, Object>> providers() {
        Map<String, Map<String, Object>> merged = new LinkedHashMap<>();
        // 内置目录：yml 配置的 profile
        properties.getProfiles().forEach((id, profile) -> merged.put(
                id,
                entry(id, profile.getModelId(), profile.getBaseUrl(), true)));
        // 用户覆写层：同 provider 以 user_config 为准
        for (Map<String, Object> row : configRows()) {
            String provider = (String) row.get("provider");
            merged.put(provider, entry(
                    provider,
                    (String) row.get("model"),
                    (String) row.get("base_url"),
                    row.get("is_enabled") == null
                            || ((Number) row.get("is_enabled")).intValue() == 1));
        }
        return new ArrayList<>(merged.values());
    }

    /** GET /api/config/providers/{provider} —— 单 provider（yml 种子或 user_config）。 */
    @GetMapping("/providers/{provider}")
    public Map<String, Object> provider(@PathVariable String provider) {
        return providers().stream()
                .filter(p -> provider.equals(p.get("provider")))
                .findFirst()
                .orElseThrow(() -> new ResponseStatusException(
                        HttpStatus.NOT_FOUND, "Provider not found: " + provider));
    }

    /** PUT /api/config/providers/{provider} —— 覆写 provider 配置（落 user_config）。 */
    @PutMapping("/providers/{provider}")
    public ResponseEntity<Void> upsertProvider(
            @PathVariable String provider,
            @RequestBody ProviderConfigRequest request
    ) {
        if (request == null) {
            throw new ResponseStatusException(HttpStatus.BAD_REQUEST, "请求体不能为空");
        }
        upsertConfigRow(
                provider,
                request.model(),
                request.baseUrl(),
                request.isEnabled(),
                null);
        return ResponseEntity.noContent().build();
    }

    // ---------- user_config 表读写（UserConfigApiController 同款，包内复用） ----------

    List<Map<String, Object>> configRows() {
        return jdbc.sql("SELECT provider, model, base_url, is_enabled FROM user_config")
                .query((rs, rowNum) -> {
                    Map<String, Object> row = new LinkedHashMap<>();
                    row.put("provider", rs.getString("provider"));
                    row.put("model", rs.getString("model"));
                    row.put("base_url", rs.getString("base_url"));
                    row.put("is_enabled", rs.getObject("is_enabled"));
                    return row;
                })
                .list();
    }

    void upsertConfigRow(
            String provider,
            String model,
            String baseUrl,
            Boolean isEnabled,
            String apiKey
    ) {
        jdbc.sql("""
                INSERT INTO user_config(provider, model, base_url, api_key, is_enabled, updated_at)
                VALUES (:provider, :model, :baseUrl, :apiKey, COALESCE(:isEnabled, 1), :now)
                ON CONFLICT(provider) DO UPDATE SET
                    model = COALESCE(:model, user_config.model),
                    base_url = COALESCE(:baseUrl, user_config.base_url),
                    api_key = COALESCE(:apiKey, user_config.api_key),
                    is_enabled = COALESCE(:isEnabled, user_config.is_enabled),
                    updated_at = excluded.updated_at
                """)
                .param("provider", provider)
                .param("model", model)
                .param("baseUrl", baseUrl)
                .param("apiKey", apiKey)
                .param("isEnabled", isEnabled == null ? null : (isEnabled ? 1 : 0))
                .param("now", Instant.now().toString())
                .update();
    }

    private Map<String, Object> entry(
            String provider, String model, String baseUrl, boolean isEnabled) {
        Map<String, Object> m = new LinkedHashMap<>();
        m.put("provider", provider);
        m.put("model", model == null ? "" : model);
        m.put("baseUrl", baseUrl == null ? "" : baseUrl);
        m.put("isEnabled", isEnabled);
        return m;
    }

    public record ProviderConfigRequest(
            String provider,
            String model,
            String baseUrl,
            Boolean isEnabled
    ) { }
}
