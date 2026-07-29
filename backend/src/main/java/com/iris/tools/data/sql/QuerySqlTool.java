package com.iris.tools.data.sql;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.node.ArrayNode;
import com.fasterxml.jackson.databind.node.ObjectNode;
import com.iris.sql.SqlConnectionCatalog;
import com.iris.sql.SqlConnectionProvider;
import com.iris.sql.SqlReadQueryExecutor;
import com.iris.sql.SqlReadQueryExecutor.QueryResult;
import com.iris.sql.SqlStatementAnalyzer;
import com.iris.sql.SqlStatementAnalyzer.Analysis;
import com.iris.sql.SqlStatementAnalyzer.Kind;
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
import java.util.ArrayList;
import java.util.List;
import java.util.Locale;

/**
 * 面向 SQL Connection 对象的只读查询动作。
 */
@Component
public class QuerySqlTool implements Tool {

    private static final int DEFAULT_MAX_ROWS = 500;
    private static final int MAX_ROWS = 5_000;
    private static final int DEFAULT_MAX_CELL_CHARACTERS = 8_000;
    private static final int MAX_CELL_CHARACTERS = 50_000;
    private static final int DEFAULT_TIMEOUT_SECONDS = 30;
    private static final int MAX_TIMEOUT_SECONDS = 60;

    private final ObjectMapper objectMapper;
    private final SqlConnectionCatalog connections;
    private final SqlStatementAnalyzer analyzer;
    private final SqlReadQueryExecutor queries;
    private final ToolManifest manifest;

    public QuerySqlTool(
            ObjectMapper objectMapper,
            SqlConnectionCatalog connections,
            SqlStatementAnalyzer analyzer,
            SqlReadQueryExecutor queries
    ) {
        this.objectMapper = objectMapper;
        this.connections = connections;
        this.analyzer = analyzer;
        this.queries = queries;
        this.manifest = new ToolManifest(
                "iris.data.sql.query_sql",
                "1",
                "query_sql",
                "在已配置的只读连接上执行一条参数化 SQL 查询；需要读取结构化业务数据时使用",
                inputSchema(),
                outputSchema(),
                RiskLevel.READ_ONLY,
                ToolManifest.SideEffect.NONE,
                75,
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
        String sql = requiredText(input, "sql");
        SqlConnectionProvider provider =
                connections.requireReadOnly(connectionId);
        Analysis analysis = analyzer.analyze(
                sql,
                provider.definition().dialect()
        );
        requireRead(analysis);

        ArrayNode parameters = normalizeParameters(
                input.path("parameters")
        );
        int maxRows = bounded(
                input.path("max_rows").asInt(DEFAULT_MAX_ROWS),
                1,
                MAX_ROWS,
                "max_rows"
        );
        int maxCellCharacters = bounded(
                input.path("max_cell_characters")
                        .asInt(DEFAULT_MAX_CELL_CHARACTERS),
                1,
                MAX_CELL_CHARACTERS,
                "max_cell_characters"
        );
        int timeoutSeconds = bounded(
                input.path("timeout_seconds")
                        .asInt(DEFAULT_TIMEOUT_SECONDS),
                1,
                MAX_TIMEOUT_SECONDS,
                "timeout_seconds"
        );

        ObjectNode normalized = objectMapper.createObjectNode();
        normalized.put("connection_id", connectionId);
        normalized.put("sql", sql);
        normalized.set("parameters", parameters);
        normalized.put("max_rows", maxRows);
        normalized.put("max_cell_characters", maxCellCharacters);
        normalized.put("timeout_seconds", timeoutSeconds);

        List<ResourceClaim> resources = new ArrayList<>();
        if (analysis.resources().isEmpty()) {
            resources.add(new ResourceClaim(
                    "sql_connection",
                    connectionId,
                    null
            ));
        } else {
            for (String resource : analysis.resources()) {
                resources.add(new ResourceClaim(
                        "sql_read",
                        connectionId + "/" + resource,
                        null
                ));
            }
        }
        return new PreparedOperation(
                normalized,
                "在只读连接 " + connectionId + " 上执行 "
                        + analysis.operation() + " 查询，最多返回 "
                        + maxRows + " 行，不改变数据库状态",
                resources,
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
        String sql = input.path("sql").asText();
        SqlConnectionProvider provider =
                connections.requireReadOnly(connectionId);
        Analysis analysis = analyzer.analyze(
                sql,
                provider.definition().dialect()
        );
        requireRead(analysis);
        QueryResult result = queries.execute(
                provider,
                sql,
                (ArrayNode) input.path("parameters"),
                input.path("max_rows").asInt(),
                input.path("max_cell_characters").asInt(),
                input.path("timeout_seconds").asInt(),
                context::cancelled
        );

        ObjectNode output = objectMapper.createObjectNode();
        output.put("connectionId", connectionId);
        output.put(
                "dialect",
                provider.definition().dialect().name()
                        .toLowerCase(Locale.ROOT)
        );
        ObjectNode analysisNode = output.putObject("analysis");
        analysisNode.put("operation", analysis.operation());
        analysisNode.put("reason", analysis.reason());
        analysisNode.set(
                "resources",
                objectMapper.valueToTree(analysis.resources())
        );
        output.set("columns", result.columns());
        output.set("rows", result.rows());
        output.put("rowCount", result.rows().size());
        output.put("truncated", result.truncated());
        output.put("durationMs", result.durationMs());
        output.put(
                "guidance",
                result.truncated()
                        ? "结果达到行数预算；请增加更精确的 WHERE、聚合或 LIMIT，不要把当前窗口当作全集"
                        : "查询结果已完整返回"
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
                        "sql_read_result",
                        operation.normalizedInput()
                                .path("connection_id").asText(),
                        "分析器确认只读，JDBC 已返回 "
                                + outcome.output().path("rowCount").asInt()
                                + " 行"
                )
        ));
    }

    private void requireRead(Analysis analysis) {
        if (analysis.kind() == Kind.WRITE) {
            throw new ToolRuntimeException(
                    "sql_write_not_allowed",
                    "query_sql 只允许读取；分析到的操作 "
                            + analysis.operation() + " 可能改变数据库状态"
            );
        }
        if (!analysis.readOnlyConfirmed()) {
            throw new ToolRuntimeException(
                    "sql_read_not_proven",
                    "当前分析器无法证明 SQL 只读：" + analysis.reason()
            );
        }
    }

    private ArrayNode normalizeParameters(JsonNode source) {
        ArrayNode normalized = objectMapper.createArrayNode();
        if (source.isMissingNode() || source.isNull()) {
            return normalized;
        }
        if (!source.isArray()) {
            throw new ToolRuntimeException(
                    "invalid_sql_parameters",
                    "parameters 必须是与 ? 占位符顺序一致的数组"
            );
        }
        for (int index = 0; index < source.size(); index++) {
            JsonNode value = source.get(index);
            if (value == null
                    || value.isNull()
                    || value.isTextual()
                    || value.isNumber()
                    || value.isBoolean()) {
                normalized.add(value);
                continue;
            }
            throw new ToolRuntimeException(
                    "invalid_sql_parameter",
                    "parameters[" + index
                            + "] 只能是字符串、数字、布尔值或 null"
            );
        }
        return normalized;
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

    private JsonNode inputSchema() {
        ObjectNode schema = objectMapper.createObjectNode();
        schema.put("type", "object");
        schema.put("additionalProperties", false);
        ObjectNode properties = schema.putObject("properties");
        properties.putObject("connection_id")
                .put("type", "string")
                .put("description", "list_sql_connections 返回的稳定连接 ID");
        properties.putObject("sql")
                .put("type", "string")
                .put("description", "一条只读 SQL；值使用 ? 占位，不能拼接进 SQL 文本");
        ObjectNode parameters = properties.putObject("parameters");
        parameters.put("type", "array");
        parameters.put(
                "description",
                "与 SQL 中 ? 顺序一致的标量参数；允许字符串、数字、布尔值和 null"
        );
        parameters.putObject("items").put(
                "description",
                "一个 JDBC bind 标量"
        );
        properties.putObject("max_rows")
                .put("type", "integer")
                .put("minimum", 1)
                .put("maximum", MAX_ROWS)
                .put("description", "最多返回行数；默认 500，上限 5000");
        properties.putObject("max_cell_characters")
                .put("type", "integer")
                .put("minimum", 1)
                .put("maximum", MAX_CELL_CHARACTERS)
                .put("description", "单元格最多内联字符数；默认 8000");
        properties.putObject("timeout_seconds")
                .put("type", "integer")
                .put("minimum", 1)
                .put("maximum", MAX_TIMEOUT_SECONDS)
                .put("description", "JDBC 查询超时秒数；默认 30，上限 60");
        schema.putArray("required")
                .add("connection_id").add("sql");
        return schema;
    }

    private JsonNode outputSchema() {
        ObjectNode schema = objectMapper.createObjectNode();
        schema.put("type", "object");
        schema.put("additionalProperties", false);
        ObjectNode properties = schema.putObject("properties");
        properties.putObject("connectionId")
                .put("type", "string")
                .put("description", "实际使用的稳定连接 ID");
        properties.putObject("dialect")
                .put("type", "string")
                .put("description", "连接声明的 SQL 方言");
        properties.putObject("analysis")
                .put("type", "object")
                .put("description", "只读分类、理由与识别到的资源");
        properties.putObject("columns")
                .put("type", "array")
                .put("description", "按结果顺序排列的列 metadata，保留重复列名");
        properties.putObject("rows")
                .put("type", "array")
                .put("description", "与 columns 顺序对应的二维值数组");
        properties.putObject("rowCount")
                .put("type", "integer")
                .put("description", "本次实际返回行数");
        properties.putObject("truncated")
                .put("type", "boolean")
                .put("description", "是否因 max_rows 只返回结果窗口");
        properties.putObject("durationMs")
                .put("type", "integer")
                .put("description", "JDBC 执行与结果读取耗时毫秒");
        properties.putObject("guidance")
                .put("type", "string")
                .put("description", "完整性说明或收窄查询提示");
        schema.putArray("required")
                .add("connectionId").add("dialect").add("analysis")
                .add("columns").add("rows").add("rowCount")
                .add("truncated").add("durationMs").add("guidance");
        return schema;
    }
}
