package com.iris.tools.system.files;

import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.node.ObjectNode;
import com.iris.tools.core.ToolRuntimeException;

final class WorkspaceFileToolSupport {

    private WorkspaceFileToolSupport() {
    }

    static ObjectNode objectSchema(ObjectMapper objectMapper) {
        ObjectNode schema = objectMapper.createObjectNode();
        schema.put("type", "object");
        schema.put("additionalProperties", false);
        schema.putObject("properties");
        return schema;
    }

    static int boundedInteger(
            int value,
            int minimum,
            int maximum,
            String field
    ) {
        if (value < minimum || value > maximum) {
            throw new ToolRuntimeException(
                    "invalid_tool_input",
                    "参数 " + field + " 收到 " + value
                            + "，超出允许范围（" + minimum + " 到 "
                            + maximum + "）；请调整取值后重试"
            );
        }
        return value;
    }

    static String requiredText(String value, String field) {
        if (value == null || value.isBlank()) {
            throw new ToolRuntimeException(
                    "invalid_tool_input",
                    "参数 " + field + " 不能为空；请提供具体取值后重试"
            );
        }
        return value;
    }
}
