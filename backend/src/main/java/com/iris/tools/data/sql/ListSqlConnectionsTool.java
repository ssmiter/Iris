package com.iris.tools.data.sql;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.node.ArrayNode;
import com.fasterxml.jackson.databind.node.ObjectNode;
import com.iris.sql.SqlConnectionCatalog;
import com.iris.sql.SqlConnectionProvider.Definition;
import com.iris.tools.core.CommittedOperation;
import com.iris.tools.core.PreparedOperation;
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
import java.util.Locale;

/**
 * 发现当前绑定的结构化数据连接，不暴露物理地址或凭据。
 */
@Component
public class ListSqlConnectionsTool implements Tool {

    private final ObjectMapper objectMapper;
    private final SqlConnectionCatalog connections;
    private final ToolManifest manifest;

    public ListSqlConnectionsTool(
            ObjectMapper objectMapper,
            SqlConnectionCatalog connections
    ) {
        this.objectMapper = objectMapper;
        this.connections = connections;
        this.manifest = new ToolManifest(
                "iris.data.sql.list_sql_connections",
                "1",
                "list_sql_connections",
                "列出当前可用的结构化数据连接及其安全 metadata；需要选择 connection_id 时使用",
                inputSchema(),
                outputSchema(),
                RiskLevel.READ_ONLY,
                ToolManifest.SideEffect.NONE,
                10,
                20_000,
                ToolManifest.IdempotencySemantics.IDEMPOTENT,
                ToolManifest.EvidencePolicy.SUMMARY,
                ToolManifest.ContextRetention.PINNED,
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
        return new PreparedOperation(
                objectMapper.createObjectNode(),
                "读取当前 SQL Connection Catalog，不建立数据库连接，也不改变外部状态",
                List.of(),
                Instant.now().plusSeconds(60)
        );
    }

    @Override
    public ToolOutcome execute(
            CommittedOperation operation,
            ToolContext context
    ) {
        ArrayNode items = objectMapper.createArrayNode();
        for (Definition definition : connections.definitions()) {
            if (context.cancelled()) {
                throw new ToolRuntimeException(
                        "tool_cancelled",
                        "SQL Connection Catalog 读取已停止，没有改变外部状态"
                );
            }
            ObjectNode item = items.addObject();
            item.put("id", definition.id());
            item.put("title", definition.title());
            item.put("description", definition.description());
            item.put(
                    "dialect",
                    definition.dialect().name()
                            .toLowerCase(Locale.ROOT)
            );
            item.put(
                    "accessMode",
                    definition.accessMode().name()
                            .toLowerCase(Locale.ROOT)
            );
        }
        ObjectNode output = objectMapper.createObjectNode();
        output.set("connections", items);
        output.put("count", items.size());
        output.put(
                "guidance",
                items.isEmpty()
                        ? "当前没有绑定 SQL 连接；需要用户先在本地配置中添加连接"
                        : "把目标连接的 id 作为 query_sql.connection_id"
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
                        "sql_connection_catalog",
                        "local-provider-bindings",
                        "已读取安全 Connection Definition，未暴露 URL 或凭据"
                )
        ));
    }

    private JsonNode inputSchema() {
        ObjectNode schema = objectMapper.createObjectNode();
        schema.put("type", "object");
        schema.put("additionalProperties", false);
        schema.putObject("properties");
        return schema;
    }

    private JsonNode outputSchema() {
        ObjectNode schema = objectMapper.createObjectNode();
        schema.put("type", "object");
        schema.put("additionalProperties", false);
        ObjectNode properties = schema.putObject("properties");
        ObjectNode connectionsSchema =
                properties.putObject("connections");
        connectionsSchema.put("type", "array");
        connectionsSchema.put(
                "description",
                "安全连接定义列表，不含 URL、账号或密码"
        );
        ObjectNode item = connectionsSchema.putObject("items");
        item.put("type", "object");
        ObjectNode itemProperties = item.putObject("properties");
        itemProperties.putObject("id").put("type", "string");
        itemProperties.putObject("title").put("type", "string");
        itemProperties.putObject("description").put("type", "string");
        itemProperties.putObject("dialect").put("type", "string");
        itemProperties.putObject("accessMode").put("type", "string");
        properties.putObject("count")
                .put("type", "integer")
                .put("description", "当前连接数量");
        properties.putObject("guidance")
                .put("type", "string")
                .put("description", "连接选择或缺失配置提示");
        schema.putArray("required")
                .add("connections").add("count").add("guidance");
        return schema;
    }
}
