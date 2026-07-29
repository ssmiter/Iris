package com.iris.industry.demo;

import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.node.ArrayNode;
import com.fasterxml.jackson.databind.node.ObjectNode;
import org.springframework.jdbc.core.simple.JdbcClient;
import org.springframework.stereotype.Repository;

import java.sql.ResultSetMetaData;
import java.sql.SQLException;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

/**
 * 脱敏工业样例的统一只读数据网关。
 *
 * <p>领域 Tool 只选择固定的数据视图并归一化用户参数；表、SQL、行预算和结果信封
 * 集中在这里，避免每个业务能力复制数据库访问代码。</p>
 */
@Repository
public class IndustrialDemoRepository {
    private final JdbcClient jdbc;
    private final ObjectMapper objectMapper;

    public IndustrialDemoRepository(
            JdbcClient jdbc,
            ObjectMapper objectMapper
    ) {
        this.jdbc = jdbc;
        this.objectMapper = objectMapper;
    }

    public ObjectNode materialInventory(
            String domain,
            ObjectNode filters
    ) {
        StringBuilder sql = new StringBuilder("""
                SELECT material_code AS materialCode,
                       material_name AS materialName,
                       material_category AS materialCategory,
                       warehouse_code AS warehouseCode,
                       available_quantity AS availableQuantity,
                       reserved_quantity AS reservedQuantity,
                       safety_stock AS safetyStock,
                       unit,
                       updated_at AS updatedAt
                FROM industrial_demo_material_stock
                WHERE domain_code = :domain
                """);
        Map<String, Object> parameters = parameters(domain, filters);
        addContains(
                sql,
                parameters,
                filters,
                "material",
                " AND (material_code LIKE :material"
                        + " OR material_name LIKE :material)"
        );
        addEquals(
                sql,
                parameters,
                filters,
                "warehouse_code",
                " AND warehouse_code = :warehouse_code"
        );
        if (filters.path("below_safety_stock").asBoolean(false)) {
            sql.append(" AND available_quantity < safety_stock");
        }
        sql.append(" ORDER BY material_category, material_code")
                .append(" LIMIT :fetchLimit");
        return result(
                domain,
                "material_inventory",
                filters,
                query(sql.toString(), parameters)
        );
    }

    public ObjectNode productionPlans(
            String domain,
            ObjectNode filters
    ) {
        StringBuilder sql = new StringBuilder("""
                SELECT plan_no AS planNo,
                       process_code AS processCode,
                       plan_date AS planDate,
                       equipment_code AS equipmentCode,
                       material_code AS materialCode,
                       material_name AS materialName,
                       planned_batches AS plannedBatches,
                       completed_batches AS completedBatches,
                       ROUND(
                           CASE WHEN planned_batches = 0 THEN 0
                                ELSE completed_batches * 100.0
                                     / planned_batches END,
                           1
                       ) AS completionPercent,
                       planned_weight AS plannedWeight,
                       actual_weight AS actualWeight,
                       shift_code AS shiftCode,
                       priority,
                       status
                FROM industrial_demo_production_plan
                WHERE domain_code = :domain
                """);
        Map<String, Object> parameters = parameters(domain, filters);
        addDateRange(sql, parameters, filters, "plan_date");
        addEquals(
                sql,
                parameters,
                filters,
                "equipment_code",
                " AND equipment_code = :equipment_code"
        );
        addEquals(
                sql,
                parameters,
                filters,
                "material_code",
                " AND material_code = :material_code"
        );
        addEquals(
                sql,
                parameters,
                filters,
                "status",
                " AND status = :status"
        );
        sql.append("""
                 ORDER BY plan_date DESC,
                          CASE priority WHEN 'high' THEN 0 ELSE 1 END,
                          equipment_code, plan_no
                 LIMIT :fetchLimit
                """);
        return result(
                domain,
                "mixing_plans",
                filters,
                query(sql.toString(), parameters)
        );
    }

    public ObjectNode equipmentStates(
            String domain,
            ObjectNode filters
    ) {
        StringBuilder sql = new StringBuilder("""
                SELECT equipment_code AS equipmentCode,
                       equipment_name AS equipmentName,
                       process_code AS processCode,
                       workshop_code AS workshopCode,
                       state,
                       utilization_percent AS utilizationPercent,
                       current_plan_no AS currentPlanNo,
                       latest_alarm AS latestAlarm,
                       updated_at AS updatedAt
                FROM industrial_demo_equipment_state
                WHERE domain_code = :domain
                """);
        Map<String, Object> parameters = parameters(domain, filters);
        addEquals(
                sql,
                parameters,
                filters,
                "process_code",
                " AND process_code = :process_code"
        );
        addEquals(
                sql,
                parameters,
                filters,
                "state",
                " AND state = :state"
        );
        addContains(
                sql,
                parameters,
                filters,
                "equipment",
                " AND (equipment_code LIKE :equipment"
                        + " OR equipment_name LIKE :equipment)"
        );
        sql.append(" ORDER BY process_code, equipment_code")
                .append(" LIMIT :fetchLimit");
        return result(
                domain,
                "equipment_status",
                filters,
                query(sql.toString(), parameters)
        );
    }

    public ObjectNode equipmentEvents(
            String domain,
            ObjectNode filters
    ) {
        StringBuilder sql = new StringBuilder("""
                SELECT event_no AS eventNo,
                       equipment_code AS equipmentCode,
                       event_type AS eventType,
                       severity,
                       reason_category AS reasonCategory,
                       started_at AS startedAt,
                       ended_at AS endedAt,
                       resolution_state AS resolutionState
                FROM industrial_demo_equipment_event
                WHERE domain_code = :domain
                """);
        Map<String, Object> parameters = parameters(domain, filters);
        addTimestampRange(sql, parameters, filters, "started_at");
        addEquals(
                sql,
                parameters,
                filters,
                "equipment_code",
                " AND equipment_code = :equipment_code"
        );
        addEquals(
                sql,
                parameters,
                filters,
                "severity",
                " AND severity = :severity"
        );
        if (filters.path("unresolved_only").asBoolean(false)) {
            sql.append(" AND resolution_state <> 'resolved'");
        }
        sql.append(" ORDER BY started_at DESC, event_no")
                .append(" LIMIT :fetchLimit");
        return result(
                domain,
                "equipment_events",
                filters,
                query(sql.toString(), parameters)
        );
    }

    public ObjectNode qualityMeasurements(
            String domain,
            ObjectNode filters
    ) {
        StringBuilder sql = new StringBuilder("""
                SELECT sample_no AS sampleNo,
                       batch_no AS batchNo,
                       material_code AS materialCode,
                       equipment_code AS equipmentCode,
                       metric_code AS metricCode,
                       measured_value AS measuredValue,
                       lower_limit AS lowerLimit,
                       upper_limit AS upperLimit,
                       judge_result AS judgeResult,
                       sampled_at AS sampledAt
                FROM industrial_demo_quality_measurement
                WHERE domain_code = :domain
                """);
        Map<String, Object> parameters = parameters(domain, filters);
        addTimestampRange(sql, parameters, filters, "sampled_at");
        addEquals(
                sql,
                parameters,
                filters,
                "material_code",
                " AND material_code = :material_code"
        );
        addEquals(
                sql,
                parameters,
                filters,
                "equipment_code",
                " AND equipment_code = :equipment_code"
        );
        addEquals(
                sql,
                parameters,
                filters,
                "judge_result",
                " AND judge_result = :judge_result"
        );
        sql.append(" ORDER BY sampled_at DESC, sample_no, metric_code")
                .append(" LIMIT :fetchLimit");
        ObjectNode result = result(
                domain,
                "quality_measurements",
                filters,
                query(sql.toString(), parameters)
        );
        int passed = 0;
        int failed = 0;
        for (var row : result.withArray("rows")) {
            if ("pass".equals(row.path("judgeResult").asText())) {
                passed++;
            } else {
                failed++;
            }
        }
        ObjectNode summary = result.putObject("summary");
        summary.put("measurementCount", passed + failed);
        summary.put("passedCount", passed);
        summary.put("failedCount", failed);
        summary.put(
                "passRatePercent",
                passed + failed == 0
                        ? 0
                        : Math.round(passed * 10_000.0
                                / (passed + failed)) / 100.0
        );
        return result;
    }

    private Map<String, Object> parameters(
            String domain,
            ObjectNode filters
    ) {
        Map<String, Object> parameters = new LinkedHashMap<>();
        parameters.put("domain", domain);
        parameters.put(
                "fetchLimit",
                filters.path("limit").asInt() + 1
        );
        return parameters;
    }

    private void addContains(
            StringBuilder sql,
            Map<String, Object> parameters,
            ObjectNode filters,
            String field,
            String clause
    ) {
        String value = filters.path(field).asText();
        if (!value.isBlank()) {
            sql.append(clause);
            parameters.put(field, "%" + value + "%");
        }
    }

    private void addEquals(
            StringBuilder sql,
            Map<String, Object> parameters,
            ObjectNode filters,
            String field,
            String clause
    ) {
        String value = filters.path(field).asText();
        if (!value.isBlank()) {
            sql.append(clause);
            parameters.put(field, value);
        }
    }

    private void addDateRange(
            StringBuilder sql,
            Map<String, Object> parameters,
            ObjectNode filters,
            String column
    ) {
        String from = filters.path("start_date").asText();
        String to = filters.path("end_date").asText();
        if (!from.isBlank()) {
            sql.append(" AND ").append(column).append(" >= :start_date");
            parameters.put("start_date", from);
        }
        if (!to.isBlank()) {
            sql.append(" AND ").append(column).append(" <= :end_date");
            parameters.put("end_date", to);
        }
    }

    private void addTimestampRange(
            StringBuilder sql,
            Map<String, Object> parameters,
            ObjectNode filters,
            String column
    ) {
        String from = filters.path("start_date").asText();
        String to = filters.path("end_date").asText();
        if (!from.isBlank()) {
            sql.append(" AND ").append(column).append(" >= :start_time");
            parameters.put("start_time", from + "T00:00:00Z");
        }
        if (!to.isBlank()) {
            sql.append(" AND ").append(column).append(" < :end_time");
            parameters.put("end_time", to + "T23:59:59.999Z");
        }
    }

    private List<ObjectNode> query(
            String sql,
            Map<String, Object> parameters
    ) {
        return jdbc.sql(sql)
                .params(parameters)
                .query((rs, rowNumber) -> {
                    ObjectNode row = objectMapper.createObjectNode();
                    ResultSetMetaData metadata = rs.getMetaData();
                    for (int index = 1;
                            index <= metadata.getColumnCount();
                            index++) {
                        put(
                                row,
                                metadata.getColumnLabel(index),
                                rs.getObject(index)
                        );
                    }
                    return row;
                })
                .list();
    }

    private void put(ObjectNode row, String name, Object value)
            throws SQLException {
        if (value == null) {
            row.putNull(name);
        } else if (value instanceof Integer number) {
            row.put(name, number);
        } else if (value instanceof Long number) {
            row.put(name, number);
        } else if (value instanceof Float number) {
            row.put(name, number);
        } else if (value instanceof Double number) {
            row.put(name, number);
        } else if (value instanceof Number number) {
            row.put(name, number.doubleValue());
        } else if (value instanceof Boolean booleanValue) {
            row.put(name, booleanValue);
        } else {
            row.put(name, value.toString());
        }
    }

    private ObjectNode result(
            String domain,
            String view,
            ObjectNode filters,
            List<ObjectNode> fetchedRows
    ) {
        int limit = filters.path("limit").asInt();
        boolean truncated = fetchedRows.size() > limit;
        List<ObjectNode> visible = truncated
                ? new ArrayList<>(fetchedRows.subList(0, limit))
                : fetchedRows;
        ObjectNode result = objectMapper.createObjectNode();
        result.put("dataset", "iris-industrial-demo");
        result.put("simulated", true);
        result.put("domain", domain);
        result.put("view", view);
        result.set("filters", filters.deepCopy());
        ArrayNode rows = result.putArray("rows");
        visible.forEach(rows::add);
        result.put("rowCount", visible.size());
        result.put("truncated", truncated);
        result.put(
                "guidance",
                truncated
                        ? "结果达到行数预算；请增加日期、状态、设备或物料条件后重新查询"
                        : visible.isEmpty()
                                ? "模拟数据中没有符合条件的记录；可放宽筛选条件"
                                : "已返回当前筛选范围内的全部模拟记录"
        );
        return result;
    }
}
