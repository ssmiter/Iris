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
        /**
         * 推理强度档位 low/medium/high；不配置等同 medium，且此时请求体
         * 不带 effort 参数，行为与引入该字段前完全一致。effort 是请求标量：
         * 变更即 provider 前缀缓存分叉，docs/42 §5.2 的请求快照需纳入归因。
         */
        private String effort;

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

        /** 配置的原始值；null 或空白表示未显式设档。 */
        public String getEffort() {
            return effort;
        }

        public void setEffort(String effort) {
            this.effort = effort;
        }

        /** 未显式设档时按 medium 计（docs/42 §3）。 */
        public String effectiveEffort() {
            return effort == null || effort.isBlank() ? "medium" : effort;
        }
    }
}
