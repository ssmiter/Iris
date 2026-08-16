package com.iris.extension;

import com.fasterxml.jackson.annotation.JsonIgnoreProperties;
import com.fasterxml.jackson.annotation.JsonProperty;

import java.util.List;

/**
 * {@code *.mcp.yml} 接入声明的线格式（docs/31 §5.3）。未知字段拒绝
 * （fail-closed）。声明只表达"接入哪个 MCP 服务器、怎么拉起"；冲突裁决在
 * McpServerService（与管理页手工连接器比对来源）。
 */
@JsonIgnoreProperties(ignoreUnknown = false)
public record McpServerDeclaration(
        String slug,
        @JsonProperty("display_name") String displayName,
        String transport,
        List<String> command,
        List<String> env,
        String endpoint,
        @JsonProperty("authorization_env") String authorizationEnv,
        Boolean enabled
) {
    public boolean enabledOrDefault() {
        return enabled == null || enabled;
    }
}
