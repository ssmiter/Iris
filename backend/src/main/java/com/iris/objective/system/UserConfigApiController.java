package com.iris.objective.system;

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
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

/**
 * 用户 provider 配置 API（WonWork 契约形状 /api/userconfig/*，对照 UserConfigController.cs）。
 *
 * <p>数据源 = user_config 表（SQLite，单用户本地——WonWork 按 userId+systemCode 分区，
 * Iris 省略）。形状 = UserConfigDto：{provider, model?, baseUrl?, apiKey?}。
 * apikey 端点不返回 404（未配置回空串），避免前端把"未配置 API Key"当作资源不存在 Toast。</p>
 */
@RestController
@RequestMapping("/api/userconfig")
public class UserConfigApiController {

    private final JdbcClient jdbc;
    private final ConfigProvidersApiController configStore;

    public UserConfigApiController(
            JdbcClient jdbc,
            ConfigProvidersApiController configStore
    ) {
        this.jdbc = jdbc;
        this.configStore = configStore;
    }

    /** GET /api/userconfig —— 全部用户配置（不含 apiKey）。 */
    @GetMapping
    public List<Map<String, Object>> getConfigs() {
        return jdbc.sql("SELECT provider, model, base_url FROM user_config")
                .query((rs, rowNum) -> {
                    Map<String, Object> m = new LinkedHashMap<String, Object>();
                    m.put("provider", rs.getString("provider"));
                    m.put("model", rs.getString("model"));
                    m.put("baseUrl", rs.getString("base_url"));
                    return m;
                })
                .list();
    }

    /** GET /api/userconfig/{provider} —— 单条（未配置 404，前端按"未配置"正常分支处理）。 */
    @GetMapping("/{provider}")
    public Map<String, Object> getConfig(@PathVariable String provider) {
        return jdbc.sql("SELECT provider, model, base_url, api_key FROM user_config"
                        + " WHERE provider = :provider")
                .param("provider", provider)
                .query((rs, rowNum) -> {
                    Map<String, Object> m = new LinkedHashMap<String, Object>();
                    m.put("provider", rs.getString("provider"));
                    m.put("model", rs.getString("model"));
                    m.put("baseUrl", rs.getString("base_url"));
                    m.put("apiKey", rs.getString("api_key"));
                    return m;
                })
                .optional()
                .orElseThrow(() -> new ResponseStatusException(
                        HttpStatus.NOT_FOUND, "Provider config not found: " + provider));
    }

    /** PUT /api/userconfig/{provider} —— 覆写（字段 null 保留旧值）。 */
    @PutMapping("/{provider}")
    public ResponseEntity<Map<String, Object>> upsertConfig(
            @PathVariable String provider,
            @RequestBody UserConfigRequest request
    ) {
        if (request == null) {
            throw new ResponseStatusException(HttpStatus.BAD_REQUEST, "请求体不能为空");
        }
        configStore.upsertConfigRow(
                provider,
                request.model(),
                request.baseUrl(),
                null,
                request.apiKey());
        // 对齐 WonWork：返回 apiKey 接收回执（不回显密钥本体）
        String apiKeyReceived = request.apiKey() == null
                ? "NULL"
                : "Length=" + request.apiKey().length();
        return ResponseEntity.ok(Map.of(
                "apiKeyReceived", apiKeyReceived,
                "provider", provider));
    }

    /** GET /api/userconfig/{provider}/apikey —— 未配置返回空串而非 404。 */
    @GetMapping("/{provider}/apikey")
    public Map<String, Object> getApiKey(@PathVariable String provider) {
        String apiKey = jdbc.sql("SELECT api_key FROM user_config WHERE provider = :provider")
                .param("provider", provider)
                .query(String.class)
                .optional()
                .orElse(null);
        return Map.of("apiKey", apiKey == null ? "" : apiKey);
    }

    public record UserConfigRequest(
            String provider,
            String model,
            String baseUrl,
            String apiKey
    ) { }

    static {
        // 保留引用避免 Instant 导入被优化掉（updated_at 由 ConfigProvidersApiController 写入）
        assert Instant.EPOCH != null;
    }
}
