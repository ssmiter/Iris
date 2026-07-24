package com.iris.agent.model.provider;

import org.springframework.boot.context.properties.ConfigurationProperties;

@ConfigurationProperties(prefix = "iris.model")
public class IrisModelProperties {
    private String profile = "unconfigured";
    private String kind = "unconfigured";
    private String modelId = "";
    private String baseUrl = "";
    private String endpointPath = "/v1/chat/completions";
    private String apiKey = "";
    private int timeoutSeconds = 180;
    private int maxOutputTokens = 8192;
    private boolean cumulativeToolArguments;

    public String getProfile() {
        return profile;
    }

    public void setProfile(String profile) {
        this.profile = profile;
    }

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
