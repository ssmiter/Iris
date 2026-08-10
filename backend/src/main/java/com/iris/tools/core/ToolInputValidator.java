package com.iris.tools.core;

import com.fasterxml.jackson.databind.JsonNode;
import org.springframework.stereotype.Component;

import java.util.HashSet;
import java.util.Iterator;
import java.util.Set;
import java.util.TreeSet;

/**
 * 首版有界 JSON Schema 校验器。
 *
 * 支持 object/properties/required/additionalProperties 以及常用标量和数组类型。
 * 更完整的组合关键字随真实 Tool schema 需求扩展，不假装已经实现完整 JSON Schema。
 */
@Component
public class ToolInputValidator {
    public void validate(JsonNode schema, JsonNode input) {
        if (input == null || !input.isObject()) {
            throw new ToolRuntimeException(
                    "invalid_tool_input",
                    "工具输入必须是 JSON object"
            );
        }
        Set<String> required = new HashSet<>();
        schema.path("required").forEach(node -> required.add(node.asText()));
        for (String field : required) {
            if (!input.has(field) || input.get(field).isNull()) {
                throw new ToolRuntimeException(
                        "invalid_tool_input",
                        "缺少必填参数: " + field
                );
            }
        }

        JsonNode properties = schema.path("properties");
        boolean additionalAllowed =
                schema.path("additionalProperties").asBoolean(false);
        if (!additionalAllowed) {
            Set<String> allowed = new TreeSet<>();
            properties.fieldNames().forEachRemaining(allowed::add);
            Set<String> unknown = new TreeSet<>();
            input.fieldNames().forEachRemaining(name -> {
                if (!allowed.contains(name)) {
                    unknown.add(name);
                }
            });
            if (!unknown.isEmpty()) {
                throw new ToolRuntimeException(
                        "invalid_tool_input",
                        "未声明参数: " + String.join(", ", unknown)
                                + "；只允许这些字段: "
                                + String.join(", ", allowed)
                );
            }
        }
        Iterator<String> names = input.fieldNames();
        while (names.hasNext()) {
            String name = names.next();
            JsonNode propertySchema = properties.get(name);
            if (propertySchema == null) {
                continue;
            }
            requireType(name, propertySchema.path("type").asText(), input.get(name));
        }
    }

    private void requireType(String field, String type, JsonNode value) {
        boolean valid = switch (type) {
            case "string" -> value.isTextual();
            case "integer" -> value.isIntegralNumber();
            case "number" -> value.isNumber();
            case "boolean" -> value.isBoolean();
            case "array" -> value.isArray();
            case "object" -> value.isObject();
            default -> false;
        };
        if (!valid) {
            throw new ToolRuntimeException(
                    "invalid_tool_input",
                    "参数 " + field + " 类型应为 " + type
            );
        }
    }
}
