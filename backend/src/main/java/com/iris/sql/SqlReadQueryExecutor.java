package com.iris.sql;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.node.ArrayNode;
import com.fasterxml.jackson.databind.node.ObjectNode;
import com.iris.tools.core.ToolRuntimeException;
import org.springframework.stereotype.Component;

import java.math.BigInteger;
import java.sql.Blob;
import java.sql.Clob;
import java.sql.Connection;
import java.sql.PreparedStatement;
import java.sql.ResultSet;
import java.sql.ResultSetMetaData;
import java.sql.SQLException;
import java.sql.SQLXML;
import java.time.Duration;
import java.util.Base64;
import java.util.function.BooleanSupplier;

/**
 * 只读 SQL Query 的 JDBC adapter。
 *
 * 保留列顺序和重复列名；对单元格与行数设硬预算，不把 JDBC 对象泄漏给 Tool 层。
 */
@Component
public class SqlReadQueryExecutor {

    private static final int MAX_COLUMNS = 256;

    private final ObjectMapper objectMapper;

    public SqlReadQueryExecutor(ObjectMapper objectMapper) {
        this.objectMapper = objectMapper;
    }

    public QueryResult execute(
            SqlConnectionProvider provider,
            String sql,
            ArrayNode parameters,
            int maxRows,
            int maxCellCharacters,
            int timeoutSeconds,
            BooleanSupplier cancelled
    ) {
        long started = System.nanoTime();
        try (Connection connection = provider.open();
             PreparedStatement statement = connection.prepareStatement(sql)) {
            statement.setQueryTimeout(timeoutSeconds);
            statement.setMaxRows(maxRows + 1);
            bind(statement, parameters);
            try (ResultSet resultSet = statement.executeQuery()) {
                ResultSetMetaData metadata = resultSet.getMetaData();
                int columnCount = metadata.getColumnCount();
                if (columnCount > MAX_COLUMNS) {
                    throw new ToolRuntimeException(
                            "sql_too_many_columns",
                            "查询返回 " + columnCount
                                    + " 列，超过单次查询上限 "
                                    + MAX_COLUMNS
                    );
                }
                ArrayNode columns = columns(metadata, columnCount);
                ArrayNode rows = objectMapper.createArrayNode();
                boolean truncated = false;
                while (resultSet.next()) {
                    if (cancelled.getAsBoolean()) {
                        try {
                            statement.cancel();
                        } catch (SQLException ignored) {
                            // 当前查询仍是只读；取消失败由 Runtime deadline 继续收敛。
                        }
                        throw new ToolRuntimeException(
                                "tool_cancelled",
                                "SQL 查询已停止，没有改变数据库状态"
                        );
                    }
                    if (rows.size() >= maxRows) {
                        truncated = true;
                        break;
                    }
                    ArrayNode row = rows.addArray();
                    for (int index = 1; index <= columnCount; index++) {
                        row.add(readCell(
                                resultSet,
                                index,
                                maxCellCharacters
                        ));
                    }
                }
                return new QueryResult(
                        columns,
                        rows,
                        truncated,
                        Duration.ofNanos(
                                System.nanoTime() - started
                        ).toMillis()
                );
            }
        } catch (SQLException exception) {
            throw sqlFailure(exception);
        }
    }

    private ArrayNode columns(
            ResultSetMetaData metadata,
            int columnCount
    ) throws SQLException {
        ArrayNode columns = objectMapper.createArrayNode();
        for (int index = 1; index <= columnCount; index++) {
            ObjectNode column = columns.addObject();
            column.put("index", index);
            column.put("label", metadata.getColumnLabel(index));
            column.put("jdbcType", metadata.getColumnType(index));
            column.put("typeName", metadata.getColumnTypeName(index));
            column.put("nullable", metadata.isNullable(index));
        }
        return columns;
    }

    private JsonNode readCell(
            ResultSet resultSet,
            int index,
            int maxCharacters
    ) throws SQLException {
        Object value = resultSet.getObject(index);
        if (value == null) {
            return objectMapper.nullNode();
        }
        if (value instanceof Boolean booleanValue) {
            return objectMapper.getNodeFactory().booleanNode(booleanValue);
        }
        if (value instanceof Byte
                || value instanceof Short
                || value instanceof Integer
                || value instanceof Long
                || value instanceof Float
                || value instanceof Double
                || value instanceof java.math.BigDecimal
                || value instanceof BigInteger) {
            return objectMapper.valueToTree(value);
        }
        if (value instanceof byte[] bytes) {
            return binary(bytes, maxCharacters);
        }
        if (value instanceof Blob blob) {
            ObjectNode projected = objectMapper.createObjectNode();
            projected.put("kind", "blob");
            projected.put("sizeBytes", blob.length());
            projected.put(
                    "guidance",
                    "二进制大对象未内联；请使用面向该应用对象的专用能力读取"
            );
            return projected;
        }
        if (value instanceof Clob clob) {
            long length = clob.length();
            int count = (int) Math.min(length, maxCharacters);
            String text = count == 0
                    ? ""
                    : clob.getSubString(1, count);
            return text(text, length, maxCharacters);
        }
        if (value instanceof SQLXML) {
            ObjectNode projected = objectMapper.createObjectNode();
            projected.put("kind", "sqlxml");
            projected.put(
                    "guidance",
                    "SQLXML 未内联；请在 SQL 中选择所需的文本片段"
            );
            return projected;
        }
        return text(value.toString(), null, maxCharacters);
    }

    private JsonNode binary(byte[] bytes, int maxCharacters) {
        int maximumBytes = Math.max(1, maxCharacters * 3 / 4);
        int returnedBytes = Math.min(bytes.length, maximumBytes);
        byte[] prefix = java.util.Arrays.copyOf(bytes, returnedBytes);
        ObjectNode projected = objectMapper.createObjectNode();
        projected.put("kind", "binary");
        projected.put("sizeBytes", bytes.length);
        projected.put(
                "base64",
                Base64.getEncoder().encodeToString(prefix)
        );
        projected.put("truncated", returnedBytes < bytes.length);
        return projected;
    }

    private JsonNode text(
            String value,
            Long knownLength,
            int maxCharacters
    ) {
        long length = knownLength == null
                ? value.length()
                : knownLength;
        if (length <= maxCharacters && value.length() <= maxCharacters) {
            return objectMapper.getNodeFactory().textNode(value);
        }
        ObjectNode projected = objectMapper.createObjectNode();
        projected.put(
                "value",
                value.substring(0, Math.min(value.length(), maxCharacters))
        );
        projected.put("truncated", true);
        projected.put("originalCharacters", length);
        return projected;
    }

    private void bind(
            PreparedStatement statement,
            ArrayNode parameters
    ) throws SQLException {
        for (int index = 0; index < parameters.size(); index++) {
            JsonNode value = parameters.get(index);
            int jdbcIndex = index + 1;
            if (value == null || value.isNull()) {
                statement.setObject(jdbcIndex, null);
            } else if (value.isBoolean()) {
                statement.setBoolean(jdbcIndex, value.booleanValue());
            } else if (value.isIntegralNumber()) {
                if (value.canConvertToLong()) {
                    statement.setLong(jdbcIndex, value.longValue());
                } else {
                    statement.setObject(jdbcIndex, value.bigIntegerValue());
                }
            } else if (value.isFloatingPointNumber()) {
                statement.setBigDecimal(jdbcIndex, value.decimalValue());
            } else if (value.isTextual()) {
                statement.setString(jdbcIndex, value.textValue());
            } else {
                throw new ToolRuntimeException(
                        "invalid_sql_parameter",
                        "parameters[" + index
                                + "] 只能是字符串、数字、布尔值或 null"
                );
            }
        }
    }

    private ToolRuntimeException sqlFailure(SQLException exception) {
        String state = exception.getSQLState() == null
                ? "unknown"
                : exception.getSQLState();
        String detail = exception.getMessage() == null
                ? "数据库未返回错误详情"
                : exception.getMessage();
        if (detail.length() > 1_000) {
            detail = detail.substring(0, 1_000) + "…";
        }
        return new ToolRuntimeException(
                "sql_query_failed",
                "SQL 查询失败（SQLState=" + state
                        + ", vendorCode=" + exception.getErrorCode()
                        + "）：" + detail
        );
    }

    public record QueryResult(
            ArrayNode columns,
            ArrayNode rows,
            boolean truncated,
            long durationMs
    ) {
    }
}
