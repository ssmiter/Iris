package com.iris.tools.system.artifacts;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.node.ObjectNode;
import com.iris.tools.core.ToolRuntimeException;

import java.util.Set;

final class ArtifactToolSupport {
    static final Set<String> KINDS = Set.of(
            "document", "spreadsheet", "presentation", "pdf",
            "image", "html", "data", "code", "archive", "file"
    );

    private ArtifactToolSupport() {
    }

    static String requiredText(
            JsonNode input,
            String field,
            int maximum
    ) {
        String value = input.path(field).asText("").trim();
        if (value.isBlank() || value.length() > maximum) {
            throw ToolRuntimeException.beforeCommit(
                    "invalid_artifact_" + field,
                    field + " 必须是 1 到 " + maximum + " 个字符"
            );
        }
        return value;
    }

    static ObjectNode objectSchema(ObjectMapper mapper) {
        ObjectNode schema = mapper.createObjectNode();
        schema.put("type", "object");
        schema.put("additionalProperties", false);
        schema.putObject("properties");
        return schema;
    }

    static ObjectNode outputSchema(ObjectMapper mapper) {
        ObjectNode schema = mapper.createObjectNode();
        schema.put("type", "object");
        schema.put("additionalProperties", true);
        ObjectNode properties = schema.putObject("properties");
        properties.putObject("artifactId")
                .put("type", "string")
                .put("description", "Artifact 的不透明稳定 ID");
        properties.putObject("artifactRef")
                .put("type", "string")
                .put("description", "任务账本和后续工具使用的版本化引用");
        properties.putObject("version")
                .put("type", "integer")
                .put("description", "不可变内容版本");
        properties.putObject("visibility")
                .put("type", "array")
                .put("description", "当前已发布的可见性集合")
                .putObject("items")
                .put("type", "string");
        schema.putArray("required")
                .add("artifactId").add("artifactRef")
                .add("version").add("visibility");
        return schema;
    }
}
