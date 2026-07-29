package com.iris.sql;

import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.node.ArrayNode;
import com.fasterxml.jackson.databind.node.ObjectNode;
import com.iris.tools.core.ToolRuntimeException;
import org.springframework.stereotype.Component;

import java.sql.Connection;
import java.sql.DatabaseMetaData;
import java.sql.ResultSet;
import java.sql.SQLException;
import java.util.function.BooleanSupplier;

/**
 * JDBC metadata → 有界结构化对象投影。
 */
@Component
public class SqlSchemaInspector {

    private static final int MAX_RELATIONSHIPS_PER_OBJECT = 100;

    private final ObjectMapper objectMapper;

    public SqlSchemaInspector(ObjectMapper objectMapper) {
        this.objectMapper = objectMapper;
    }

    public Inspection inspect(
            SqlConnectionProvider provider,
            Request request,
            BooleanSupplier cancelled
    ) {
        try (Connection connection = provider.open()) {
            DatabaseMetaData metadata = connection.getMetaData();
            String catalog = request.catalog() == null
                    ? connection.getCatalog()
                    : request.catalog();
            ArrayNode objects = objectMapper.createArrayNode();
            boolean truncated = false;
            try (ResultSet tables = metadata.getTables(
                    catalog,
                    request.schemaPattern(),
                    request.objectPattern(),
                    request.includeViews()
                            ? new String[]{"TABLE", "VIEW"}
                            : new String[]{"TABLE"}
            )) {
                while (tables.next()) {
                    requireActive(cancelled);
                    if (objects.size() >= request.maxObjects()) {
                        truncated = true;
                        break;
                    }
                    String objectCatalog = tables.getString("TABLE_CAT");
                    String objectSchema = tables.getString("TABLE_SCHEM");
                    String objectName = tables.getString("TABLE_NAME");
                    ObjectNode object = objects.addObject();
                    putNullable(object, "catalog", objectCatalog);
                    putNullable(object, "schema", objectSchema);
                    object.put("name", objectName);
                    object.put(
                            "type",
                            lower(tables.getString("TABLE_TYPE"))
                    );
                    putBounded(
                            object,
                            "remarks",
                            tables.getString("REMARKS"),
                            1_000
                    );
                    object.put(
                            "identity",
                            identity(
                                    objectCatalog,
                                    objectSchema,
                                    objectName
                            )
                    );
                    if (request.includeColumns()) {
                        projectColumns(
                                metadata,
                                object,
                                objectCatalog,
                                objectSchema,
                                objectName,
                                request.maxColumnsPerObject(),
                                cancelled
                        );
                    }
                    if (request.includeKeys()) {
                        projectKeys(
                                metadata,
                                object,
                                objectCatalog,
                                objectSchema,
                                objectName,
                                cancelled
                        );
                    }
                }
            }
            return new Inspection(
                    catalog,
                    request.schemaPattern(),
                    request.objectPattern(),
                    objects,
                    truncated
            );
        } catch (SQLException exception) {
            throw sqlFailure(exception);
        }
    }

    private void projectColumns(
            DatabaseMetaData metadata,
            ObjectNode object,
            String catalog,
            String schema,
            String name,
            int maximum,
            BooleanSupplier cancelled
    ) throws SQLException {
        ArrayNode columns = object.putArray("columns");
        boolean truncated = false;
        try (ResultSet result = metadata.getColumns(
                catalog,
                schema,
                name,
                "%"
        )) {
            while (result.next()) {
                requireActive(cancelled);
                if (columns.size() >= maximum) {
                    truncated = true;
                    break;
                }
                ObjectNode column = columns.addObject();
                column.put("name", result.getString("COLUMN_NAME"));
                column.put("ordinal", result.getInt("ORDINAL_POSITION"));
                column.put("jdbcType", result.getInt("DATA_TYPE"));
                column.put("typeName", result.getString("TYPE_NAME"));
                column.put("nullable", result.getInt("NULLABLE"));
                putNullableInteger(
                        column,
                        "size",
                        result,
                        "COLUMN_SIZE"
                );
                putNullableInteger(
                        column,
                        "decimalDigits",
                        result,
                        "DECIMAL_DIGITS"
                );
                putBounded(
                        column,
                        "defaultValue",
                        result.getString("COLUMN_DEF"),
                        1_000
                );
            }
        }
        object.put("columnsTruncated", truncated);
    }

    private void projectKeys(
            DatabaseMetaData metadata,
            ObjectNode object,
            String catalog,
            String schema,
            String name,
            BooleanSupplier cancelled
    ) throws SQLException {
        ArrayNode primaryKey = object.putArray("primaryKey");
        try (ResultSet result = metadata.getPrimaryKeys(
                catalog,
                schema,
                name
        )) {
            while (result.next()) {
                requireActive(cancelled);
                ObjectNode item = primaryKey.addObject();
                item.put("column", result.getString("COLUMN_NAME"));
                item.put("sequence", result.getInt("KEY_SEQ"));
                putNullable(
                        item,
                        "name",
                        result.getString("PK_NAME")
                );
            }
        }

        ArrayNode foreignKeys = object.putArray("foreignKeys");
        boolean truncated = false;
        try (ResultSet result = metadata.getImportedKeys(
                catalog,
                schema,
                name
        )) {
            while (result.next()) {
                requireActive(cancelled);
                if (foreignKeys.size()
                        >= MAX_RELATIONSHIPS_PER_OBJECT) {
                    truncated = true;
                    break;
                }
                ObjectNode item = foreignKeys.addObject();
                putNullable(
                        item,
                        "name",
                        result.getString("FK_NAME")
                );
                item.put("column", result.getString("FKCOLUMN_NAME"));
                item.put(
                        "referencedObject",
                        identity(
                                result.getString("PKTABLE_CAT"),
                                result.getString("PKTABLE_SCHEM"),
                                result.getString("PKTABLE_NAME")
                        )
                );
                item.put(
                        "referencedColumn",
                        result.getString("PKCOLUMN_NAME")
                );
                item.put("sequence", result.getInt("KEY_SEQ"));
            }
        }
        object.put("foreignKeysTruncated", truncated);
    }

    private void requireActive(BooleanSupplier cancelled) {
        if (cancelled.getAsBoolean()) {
            throw new ToolRuntimeException(
                    "tool_cancelled",
                    "SQL schema 观察已停止，没有改变数据库状态"
            );
        }
    }

    private String identity(
            String catalog,
            String schema,
            String name
    ) {
        StringBuilder identity = new StringBuilder();
        if (catalog != null && !catalog.isBlank()) {
            identity.append(catalog).append('.');
        }
        if (schema != null && !schema.isBlank()) {
            identity.append(schema).append('.');
        }
        return identity.append(name).toString();
    }

    private String lower(String value) {
        return value == null
                ? "unknown"
                : value.toLowerCase(java.util.Locale.ROOT);
    }

    private void putNullable(
            ObjectNode object,
            String field,
            String value
    ) {
        if (value == null) {
            object.putNull(field);
        } else {
            object.put(field, value);
        }
    }

    private void putBounded(
            ObjectNode object,
            String field,
            String value,
            int maximum
    ) {
        if (value == null) {
            object.putNull(field);
        } else if (value.length() <= maximum) {
            object.put(field, value);
        } else {
            object.put(field, value.substring(0, maximum) + "…");
        }
    }

    private void putNullableInteger(
            ObjectNode object,
            String field,
            ResultSet result,
            String column
    ) throws SQLException {
        int value = result.getInt(column);
        if (result.wasNull()) {
            object.putNull(field);
        } else {
            object.put(field, value);
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
                "sql_schema_inspection_failed",
                "SQL schema 观察失败（SQLState=" + state
                        + ", vendorCode=" + exception.getErrorCode()
                        + "）：" + detail
        );
    }

    public record Request(
            String catalog,
            String schemaPattern,
            String objectPattern,
            boolean includeViews,
            boolean includeColumns,
            boolean includeKeys,
            int maxObjects,
            int maxColumnsPerObject
    ) {
    }

    public record Inspection(
            String catalog,
            String schemaPattern,
            String objectPattern,
            ArrayNode objects,
            boolean truncated
    ) {
    }
}
