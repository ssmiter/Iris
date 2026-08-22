package com.iris.agent.model.provider;

import org.springframework.boot.context.properties.ConfigurationProperties;

import java.util.LinkedHashMap;
import java.util.Map;

/**
 * 多 profile 模型配置：{@code iris.model.active} 是 yml 默认的活跃 profile，
 * {@code iris.model.profiles.<id>} 各冻结一份 provider kind/base-url/model/凭证。
 * 运行时切换见 {@link ModelProfileCatalog}；持久化的选择优先于这里的 active。
 */
@ConfigurationProperties(prefix = "iris.model")
public class IrisModelProperties {
    private String active = "unconfigured";
    private Map<String, Profile> profiles = new LinkedHashMap<>();

    public String getActive() {
        return active;
    }

    public void setActive(String active) {
        this.active = active;
    }

    public Map<String, Profile> getProfiles() {
        return profiles;
    }

    public void setProfiles(Map<String, Profile> profiles) {
        this.profiles = profiles;
    }

    public static class Profile {
        private String kind = "unconfigured";
        private String modelId = "";
        private String baseUrl = "";
        private String endpointPath = "/v1/chat/completions";
        private String apiKey = "";
        private int timeoutSeconds = 180;
        private int maxOutputTokens = 8192;
        private boolean cumulativeToolArguments;

        public String getKind() {
            return kind;
        }

        public void setKind(String kind) {
            this.kind = kind;
        }

        public String getModelId() {
            return modelId;
        }

        public void setModelId(String modelId) {
            this.modelId = modelId;
        }

        public String getBaseUrl() {
            return baseUrl;
        }

        public void setBaseUrl(String baseUrl) {
            this.baseUrl = baseUrl;
        }

        public String getEndpointPath() {
            return endpointPath;
        }

        public void setEndpointPath(String endpointPath) {
            this.endpointPath = endpointPath;
        }

        public String getApiKey() {
            return apiKey;
        }

        public void setApiKey(String apiKey) {
            this.apiKey = apiKey;
        }

        public int getTimeoutSeconds() {
            return timeoutSeconds;
        }

        public void setTimeoutSeconds(int timeoutSeconds) {
            this.timeoutSeconds = timeoutSeconds;
        }

        public int getMaxOutputTokens() {
            return maxOutputTokens;
        }

        public void setMaxOutputTokens(int maxOutputTokens) {
            this.maxOutputTokens = maxOutputTokens;
        }

        public boolean isCumulativeToolArguments() {
            return cumulativeToolArguments;
        }

        public void setCumulativeToolArguments(
                boolean cumulativeToolArguments
        ) {
            this.cumulativeToolArguments = cumulativeToolArguments;
        }
    }
}
