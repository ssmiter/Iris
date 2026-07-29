package com.iris.webbridge;

import com.fasterxml.jackson.databind.JsonNode;
import com.iris.tools.core.ToolRuntimeException;
import org.springframework.stereotype.Service;

import java.time.Clock;
import java.time.Duration;
import java.time.Instant;
import java.util.Map;
import java.util.concurrent.ConcurrentHashMap;

/**
 * Runtime health 的短缓存投影。目录浏览不会为每张 Capability Card
 * 重复探测 daemon，但执行前仍会经过 Tool Runtime availability 核对。
 */
@Service
public class BrowserRuntimeService {

    private final BrowserRuntimeCatalog runtimes;
    private final WebBridgeClient client;
    private final Duration cacheTtl;
    private final Clock clock = Clock.systemUTC();
    private final Map<String, CachedHealth> cache =
            new ConcurrentHashMap<>();

    public BrowserRuntimeService(
            BrowserRuntimeCatalog runtimes,
            WebBridgeClient client,
            IrisWebBridgeProperties properties
    ) {
        this.runtimes = runtimes;
        this.client = client;
        Duration configured = properties.getHealthCacheTtl();
        this.cacheTtl = configured.isNegative() || configured.isZero()
                ? Duration.ofSeconds(3)
                : configured;
    }

    public RuntimeHealth health(String runtimeId) {
        Instant now = clock.instant();
        CachedHealth current = cache.get(runtimeId);
        if (current != null && current.expiresAt().isAfter(now)) {
            return current.health();
        }
        RuntimeHealth checked = check(runtimeId, now);
        cache.put(
                runtimeId,
                new CachedHealth(checked, now.plus(cacheTtl))
        );
        return checked;
    }

    public boolean hasConfiguredRuntime() {
        return !runtimes.definitions().isEmpty();
    }

    public boolean hasAvailableRuntime() {
        return runtimes.definitions().stream()
                .anyMatch(definition ->
                        health(definition.id()).available());
    }

    public void requireAvailable(String runtimeId) {
        RuntimeHealth health = health(runtimeId);
        if (!health.available()) {
            throw new ToolRuntimeException(
                    "browser_runtime_unavailable",
                    "Browser Runtime " + runtimeId
                            + " 当前不可用：" + health.reason()
            );
        }
    }

    private RuntimeHealth check(String runtimeId, Instant checkedAt) {
        BrowserRuntimeCatalog.Binding binding = runtimes.find(runtimeId)
                .orElse(null);
        if (binding == null) {
            return new RuntimeHealth(
                    false,
                    false,
                    null,
                    "Runtime 未配置",
                    checkedAt
            );
        }
        try {
            JsonNode payload = client.health(runtimeId);
            int actualProtocol = payload.path("protocolVersion")
                    .asInt(payload.path("protocol_version").asInt(-1));
            if (actualProtocol != binding.definition().protocolVersion()) {
                return new RuntimeHealth(
                        false,
                        false,
                        actualProtocol,
                        "协议版本不兼容：需要 "
                                + binding.definition().protocolVersion()
                                + "，实际 " + actualProtocol,
                        checkedAt
                );
            }
            boolean browserReady = payload.path("browserReady").asBoolean(
                    payload.path("chrome_ready").asBoolean(false)
            );
            String status = payload.path("status").asText("");
            boolean daemonReady = payload.path("ok").asBoolean(false)
                    || "ok".equalsIgnoreCase(status);
            if (!daemonReady) {
                return new RuntimeHealth(
                        false,
                        browserReady,
                        actualProtocol,
                        "daemon 已响应，但没有进入 ready 状态",
                        checkedAt
                );
            }
            return new RuntimeHealth(
                    true,
                    browserReady,
                    actualProtocol,
                    browserReady
                            ? "Browser Runtime 与浏览器环境可用"
                            : "daemon 可用；浏览器将在创建会话时启动",
                    checkedAt
            );
        } catch (RuntimeException exception) {
            return new RuntimeHealth(
                    false,
                    false,
                    null,
                    exception.getMessage() == null
                            ? "Browser Runtime 当前不可达"
                            : exception.getMessage(),
                    checkedAt
            );
        }
    }

    private record CachedHealth(
            RuntimeHealth health,
            Instant expiresAt
    ) {
    }

    public record RuntimeHealth(
            boolean available,
            boolean browserReady,
            Integer protocolVersion,
            String reason,
            Instant checkedAt
    ) {
    }
}
