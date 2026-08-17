package com.iris.extension;

import com.fasterxml.jackson.annotation.JsonIgnoreProperties;
import com.fasterxml.jackson.annotation.JsonProperty;

import java.util.Map;

/**
 * SKILL.md frontmatter 的线格式（docs/31 §5.1）。字段白名单之外一律
 * 拒绝（fail-closed）；name 为 kebab-case，投影时确定性转 snake_case。
 */
@JsonIgnoreProperties(ignoreUnknown = false)
public record SkillDefinition(
        String name,
        String description,
        @JsonProperty("whenToUse") String whenToUse,
        Map<String, Object> metadata,
        @JsonProperty("disable-model-invocation") Boolean disableModelInvocation,
        @JsonProperty("user-invocable") Boolean userInvocable
) {
    public boolean disabledForModel() {
        return Boolean.TRUE.equals(disableModelInvocation);
    }
}
