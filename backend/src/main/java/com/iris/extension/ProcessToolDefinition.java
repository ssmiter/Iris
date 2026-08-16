package com.iris.extension;

import com.fasterxml.jackson.annotation.JsonIgnoreProperties;
import com.fasterxml.jackson.annotation.JsonProperty;
import com.fasterxml.jackson.databind.JsonNode;

import java.util.List;

/**
 * {@code *.tool.yml} 清单的线格式（docs/31 §3.1）。未知字段拒绝（fail-closed）。
 */
@JsonIgnoreProperties(ignoreUnknown = false)
public record ProcessToolDefinition(
        String name,
        String kind,
        String description,
        @JsonProperty("input_schema") JsonNode inputSchema,
        Risk risk,
        Approval approval,
        RuntimeSpec runtime,
        Limits limits,
        @JsonProperty("search_hint") String searchHint
) {
    @JsonIgnoreProperties(ignoreUnknown = false)
    public record Risk(
            String level,
            @JsonProperty("side_effect") String sideEffect
    ) {
    }

    @JsonIgnoreProperties(ignoreUnknown = false)
    public record Approval(
            String mode,
            @JsonProperty("impact_statement") String impactStatement
    ) {
    }

    @JsonIgnoreProperties(ignoreUnknown = false)
    public record RuntimeSpec(
            /** argv 模板；元素内 {param} 用输入参数替换，{pluginDir} 用插件目录绝对路径替换。 */
            List<String> entry,
            /** 声明需要的环境变量名；缺失时在执行前给出明确错误。 */
            List<String> env
    ) {
    }

    @JsonIgnoreProperties(ignoreUnknown = false)
    public record Limits(
            @JsonProperty("timeout_ms") Long timeoutMs,
            @JsonProperty("max_result_chars") Integer maxResultChars
    ) {
    }
}
