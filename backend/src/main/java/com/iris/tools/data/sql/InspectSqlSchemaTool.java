package com.iris.tools.data.sql;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.node.ObjectNode;
import com.iris.sql.SqlConnectionCatalog;
import com.iris.sql.SqlConnectionProvider;
import com.iris.sql.SqlSchemaInspector;
import com.iris.sql.SqlSchemaInspector.Inspection;
import com.iris.sql.SqlSchemaInspector.Request;
import com.iris.tools.core.CommittedOperation;
import com.iris.tools.core.PreparedOperation;
import com.iris.tools.core.PreparedOperation.ResourceClaim;
import com.iris.tools.core.RiskLevel;
import com.iris.tools.core.Tool;
import com.iris.tools.core.ToolContext;
import com.iris.tools.core.ToolManifest;
import com.iris.tools.core.ToolOutcome;
import com.iris.tools.core.ToolRuntimeException;
import com.iris.tools.core.VerificationResult;
import org.springframework.stereotype.Component;

import java.time.Instant;
import java.util.List;

/**
 * Connection 对象的结构观察动作。
 */
@Component
public class InspectSqlSchemaTool implements Tool {

    private static final int DEFAULT_MAX_OBJECTS = 100;
    private static final int MAX_OBJECTS = 500;
    private static final int DEFAULT_MAX_COLUMNS = 100;
    private static final int MAX_COLUMNS = 256;

    private final ObjectMapper objectMapper;
    private final SqlConnectionCatalog connections;
    private final SqlSchemaInspector inspector;
    private final ToolManifest manifest;

    public InspectSqlSchemaTool(
            ObjectMapper objectMapper,
            SqlConnectionCatalog connections,
            SqlSchemaInspector inspector
    ) {
        this.objectMapper = objectMapper;
        this.connections = connections;
        this.inspector = inspector;
        this.manifest = new ToolManifest(
                "iris.data.sql.inspect_sql_schema",
                "1",
                "inspect_sql_schema",
                "观察只读 SQL 连接中的表、视图、列和键关系；写查询前需要理解数据对象结构时使用",
                inputSchema(),
                outputSchema(),
                RiskLevel.READ_ONLY,
                ToolManifest.SideEffect.NONE,
                60,
                80_000,
                ToolManifest.IdempotencySemantics.IDEMPOTENT,
                ToolManifest.EvidencePolicy.SUMMARY,
                ToolManifest.ContextRetention.REFETCHABLE,
                ToolManifest.ConcurrencySemantics.PARALLEL_SAFE,
                ToolManifest.CancellationSemantics.COOPERATIVE
        );
    }

    @Override
    public ToolManifest manifest() {
        return manifest;
    }

    @Override
    public PreparedOperation prepare(JsonNode input, ToolContext context) {
        String connectionId = requiredText(
                input,
                "connection_id"
        );
        connections.requireReadOnly(connectionId);
        String catalog = optionalText(input, "catalog");
        String schemaPattern = optionalText(
                input,
                "schema_pattern"
        );
        String objectPattern = optionalText(
                input,
                "object_pattern"
        );
        if (objectPattern == null) {
            objectPattern = "%";
        }
        boolean includeViews = input.path("include_views")
                .asBoolean(true);
        boolean includeColumns = input.path("include_columns")
                .asBoolean(true);
        boolean includeKeys = input.path("include_keys")
                .asBoolean(true);
        int maxObjects = bounded(
                input.path("max_objects")
                        .asInt(DEFAULT_MAX_OBJECTS),
                1,
                MAX_OBJECTS,
                "max_objects"
        );
        int maxColumns = bounded(
                input.path("max_columns_per_object")
                        .asInt(DEFAULT_MAX_COLUMNS),
                1,
                MAX_COLUMNS,
                "max_columns_per_object"
        );

        ObjectNode normalized = objectMapper.createObjectNode();
        normalized.put("connection_id", connectionId);
        if (catalog != null) {
            normalized.put("catalog", catalog);
        }
        if (schemaPattern != null) {
            normalized.put("schema_pattern", schemaPattern);
        }
        normalized.put("object_pattern", objectPattern);
        normalized.put("include_views", includeViews);
        normalized.put("include_columns", includeColumns);
        normalized.put("include_keys", includeKeys);
        normalized.put("max_objects", maxObjects);
        normalized.put("max_columns_per_object", maxColumns);
        return new PreparedOperation(
                normalized,
                "观察只读连接 " + connectionId
                        + " 中匹配 " + objectPattern
                        + " 的结构化对象，最多 " + maxObjects
                        + " 个，不改变数据库状态",
                List.of(new ResourceClaim(
                        "sql_schema",
                        connectionId,
                        null
                )),
                Instant.now().plusSeconds(90)
        );
    }

    @Override
    public ToolOutcome execute(
            CommittedOperation operation,
            ToolContext context
    ) {
        JsonNode input = operation.normalizedInput();
        String connectionId = input.path("connection_id").asText();
        SqlConnectionProvider provider =
                connections.requireReadOnly(connectionId);
        Inspection result = inspector.inspect(
                provider,
                new Request(
                        nullable(input, "catalog"),
                        nullable(input, "schema_pattern"),
                        input.path("object_pattern").asText(),
                        input.path("include_views").asBoolean(),
                        input.path("include_columns").asBoolean(),
                        input.path("include_keys").asBoolean(),
                        input.path("max_objects").asInt(),
                        input.path("max_columns_per_object").asInt()
                ),
                context::cancelled
        );
        ObjectNode output = objectMapper.createObjectNode();
        output.put("connectionId", connectionId);
        putNullable(output, "catalog", result.catalog());
        putNullable(
                output,
                "schemaPattern",
                result.schemaPattern()
        );
        output.put("objectPattern", result.objectPattern());
        output.set("objects", result.objects());
        output.put("objectCount", result.objects().size());
        output.put("truncated", result.truncated());
        output.put(
                "guidance",
                result.truncated()
                        ? "对象达到预算；请使用更精确的 schema_pattern 或 object_pattern 继续观察"
                        : result.objects().isEmpty()
                        ? "没有匹配对象；检查 JDBC pattern、schema 或连接说明"
                        : "结构已返回；用 identity、列和键关系组织后续参数化查询"
        );
        return ToolOutcome.succeeded(output);
    }

    @Override
    public VerificationResult verify(
            ToolOutcome outcome,
            CommittedOperation operation,
            ToolContext context
    ) {
        return VerificationResult.confirmed(List.of(
                new VerificationResult.Evidence(
                        "sql_schema_metadata",
                        operation.normalizedInput()
                                .path("connection_id").asText(),
                        "已通过 JDBC metadata 观察 "
                                + outcome.output()
                                .path("objectCount").asInt()
                                + " 个结构化对象"
                )
        ));
    }

    private String requiredText(JsonNode input, String field) {
        String value = input.path(field).asText().trim();
        if (value.isBlank()) {
            throw new ToolRuntimeException(
                    "invalid_tool_input",
                    field + " 不能为空"
            );
        }
        return value;
    }

    private String optionalText(JsonNode input, String field) {
        if (!input.has(field) || input.get(field).isNull()) {
            return null;
        }
        String value = input.path(field).asText().trim();
        return value.isBlank() ? null : value;
    }

    private String nullable(JsonNode input, String field) {
        return input.has(field) ? input.path(field).asText() : null;
    }

    private int bounded(
            int value,
            int minimum,
            int maximum,
            String field
    ) {
        if (value < minimum || value > maximum) {
            throw new ToolRuntimeException(
                    "invalid_tool_input",
                    field + " 必须在 " + minimum
                            + " 到 " + maximum + " 之间"
            );
        }
        return value;
    }

    private void putNullable(
            ObjectNode output,
            String field,
            String value
    ) {
        if (value == null) {
            output.putNull(field);
        } else {
            output.put(field, value);
        }
    }

    private JsonNode inputSchema() {
        ObjectNode schema = objectMapper.createObjectNode();
        schema.put("type", "object");
        schema.put("additionalProperties", false);
        ObjectNode properties = schema.putObject("properties");
        properties.putObject("connection_id")
                .put("type", "string")
                .put("description", "list_sql_connections 返回的稳定连接 ID");
        properties.putObject("catalog")
                .put("type", "string")
                .put("description", "精确 JDBC catalog；省略时使用连接当前 catalog");
        properties.putObject("schema_pattern")
                .put("type", "string")
                .put("description", "JDBC schema pattern；% 为任意长度，_ 为单字符");
        properties.putObject("object_pattern")
                .put("type", "string")
                .put("description", "表或视图名 JDBC pattern；默认 %");
        properties.putObject("include_views")
                .put("type", "boolean")
                .put("description", "是否同时返回视图；默认 true");
        properties.putObject("include_columns")
                .put("type", "boolean")
                .put("description", "是否返回列 metadata；默认 true");
        properties.putObject("include_keys")
                .put("type", "boolean")
                .put("description", "是否返回主键与外键；默认 true");
        properties.putObject("max_objects")
                .put("type", "integer")
                .put("minimum", 1)
                .put("maximum", MAX_OBJECTS)
                .put("description", "最多返回对象数；默认 100，上限 500");
        properties.putObject("max_columns_per_object")
                .put("type", "integer")
                .put("minimum", 1)
                .put("maximum", MAX_COLUMNS)
                .put("description", "每个对象最多返回列数；默认 100，上限 256");
        schema.putArray("required").add("connection_id");
        return schema;
    }

    private JsonNode outputSchema() {
        ObjectNode schema = objectMapper.createObjectNode();
        schema.put("type", "object");
        schema.put("additionalProperties", false);
        ObjectNode properties = schema.putObject("properties");
        properties.putObject("connectionId")
                .put("type", "string")
                .put("description", "实际观察的稳定连接 ID");
        properties.putObject("catalog")
                .put("type", "string")
                .put("description", "实际使用的 catalog；可能为 null");
        properties.putObject("schemaPattern")
                .put("type", "string")
                .put("description", "实际使用的 schema pattern；可能为 null");
        properties.putObject("objectPattern")
                .put("type", "string")
                .put("description", "实际使用的对象名 pattern");
        properties.putObject("objects")
                .put("type", "array")
                .put("description", "表和视图的身份、列、主键与外键投影");
        properties.putObject("objectCount")
                .put("type", "integer")
                .put("description", "本次返回对象数量");
        properties.putObject("truncated")
                .put("type", "boolean")
                .put("description", "是否因对象预算仅返回窗口");
        properties.putObject("guidance")
                .put("type", "string")
                .put("description", "继续观察或组织查询的提示");
        schema.putArray("required")
                .add("connectionId").add("objectPattern")
                .add("objects").add("objectCount")
                .add("truncated").add("guidance");
        return schema;
    }
}
