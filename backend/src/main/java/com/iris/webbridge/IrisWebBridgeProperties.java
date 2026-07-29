package com.iris.webbridge;

import org.springframework.boot.context.properties.ConfigurationProperties;

import java.time.Duration;
import java.util.LinkedHashMap;
import java.util.Map;

/**
 * Browser Runtime 本机绑定配置。物理地址和 token 只停留在 Connector，
 * 不进入 Capability Definition、Tool observation 或日志。
 */
@ConfigurationProperties(prefix = "iris.webbridge")
public class IrisWebBridgeProperties {

    private Duration healthCacheTtl = Duration.ofSeconds(3);
    private Map<String, RuntimeSettings> runtimes =
            new LinkedHashMap<>();

    public Duration getHealthCacheTtl() {
        return healthCacheTtl;
    }

    public void setHealthCacheTtl(Duration healthCacheTtl) {
        this.healthCacheTtl = healthCacheTtl == null
                ? Duration.ofSeconds(3)
                : healthCacheTtl;
    }

    public Map<String, RuntimeSettings> getRuntimes() {
        return runtimes;
    }

    public void setRuntimes(Map<String, RuntimeSettings> runtimes) {
        this.runtimes = runtimes == null
                ? new LinkedHashMap<>()
                : new LinkedHashMap<>(runtimes);
    }

    public static class RuntimeSettings {
        private String title;
        private String description;
        private String baseUrl;
        private String token;
        private int protocolVersion = 1;

        public String getTitle() {
            return title;
        }

        public void setTitle(String title) {
            this.title = title;
        }

        public String getDescription() {
            return description;
        }

        public void setDescription(String description) {
            this.description = description;
        }

        public String getBaseUrl() {
            return baseUrl;
        }

        public void setBaseUrl(String baseUrl) {
            this.baseUrl = baseUrl;
        }

        public String getToken() {
            return token;
        }

        public void setToken(String token) {
            this.token = token;
        }

        public int getProtocolVersion() {
            return protocolVersion;
        }

        public void setProtocolVersion(int protocolVersion) {
            this.protocolVersion = protocolVersion;
        }
    }
}
