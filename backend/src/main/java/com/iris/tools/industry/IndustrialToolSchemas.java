package com.iris.tools.industry;

import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.node.ObjectNode;

/**
 * 工业样例工具共享的紧凑 JSON Schema 构造器。
 */
public final class IndustrialToolSchemas {
    private IndustrialToolSchemas() {
    }

    public static ObjectNode input(ObjectMapper mapper) {
        ObjectNode schema = mapper.createObjectNode();
        schema.put("type", "object");
        schema.put("additionalProperties", false);
        schema.putObject("properties")
                .putObject("limit")
                .put("type", "integer")
                .put("minimum", 1)
                .put("maximum", AbstractIndustrialReadTool.MAX_LIMIT)
                .put(
                        "description",
                        "最多返回记录数；默认 50，上限 200"
                );
        return schema;
    }

    public static ObjectNode output(ObjectMapper mapper) {
        ObjectNode schema = mapper.createObjectNode();
        schema.put("type", "object");
        schema.put("additionalProperties", false);
        ObjectNode properties = schema.putObject("properties");
        property(properties, "dataset", "string", "固定模拟数据集标识");
        property(properties, "simulated", "boolean", "始终为 true，明确结果不是生产数据");
        property(properties, "domain", "string", "实际查询的脱敏业务域");
        property(properties, "view", "string", "固定只读业务视图");
        property(properties, "filters", "object", "归一化后的实际筛选条件");
        property(properties, "rows", "array", "结构化模拟业务记录");
        property(properties, "rowCount", "integer", "本次实际返回记录数");
        property(properties, "truncated", "boolean", "是否因行数预算只返回结果窗口");
        property(properties, "guidance", "string", "结果完整性与下一步收窄提示");
        property(properties, "summary", "object", "视图可提供的确定性聚合；不适用时省略");
        schema.putArray("required")
                .add("dataset")
                .add("simulated")
                .add("domain")
                .add("view")
                .add("filters")
                .add("rows")
                .add("rowCount")
                .add("truncated")
                .add("guidance");
        return schema;
    }

    public static void string(
            ObjectNode schema,
            String name,
            String description
    ) {
        property(
                (ObjectNode) schema.path("properties"),
                name,
                "string",
                description
        );
    }

    public static void bool(
            ObjectNode schema,
            String name,
            String description
    ) {
        property(
                (ObjectNode) schema.path("properties"),
                name,
                "boolean",
                description
        );
    }

    private static void property(
            ObjectNode properties,
            String name,
            String type,
            String description
    ) {
        properties.putObject(name)
                .put("type", type)
                .put("description", description);
    }
}
