package com.iris.industry.demo;

import com.fasterxml.jackson.core.JsonProcessingException;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.node.ArrayNode;
import com.fasterxml.jackson.databind.node.ObjectNode;
import org.springframework.dao.DataAccessException;
import org.springframework.jdbc.core.simple.JdbcClient;
import org.springframework.stereotype.Repository;

import java.sql.ResultSetMetaData;
import java.sql.SQLException;
import java.util.ArrayList;
import java.util.Comparator;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Set;

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
            String view,
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
                view,
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
        addEquals(
                sql,
                parameters,
                filters,
                "process_code",
                " AND equipment_code IN (SELECT equipment_code"
                        + " FROM industrial_demo_equipment_state"
                        + " WHERE domain_code = :domain"
                        + " AND process_code = :process_code)"
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

    public ObjectNode processRecords(
            String domain,
            String process,
            String view,
            ObjectNode filters
    ) {
        StringBuilder sql = new StringBuilder("""
                SELECT record_type AS recordType,
                       record_no AS recordNo,
                       business_date AS businessDate,
                       item_code AS itemCode,
                       item_name AS itemName,
                       resource_code AS resourceCode,
                       status,
                       planned_quantity AS plannedQuantity,
                       actual_quantity AS actualQuantity,
                       unit,
                       priority,
                       detail_json AS detailJson,
                       updated_at AS updatedAt
                FROM industrial_demo_process_record
                WHERE domain_code = :domain
                  AND process_code = :process
                """);
        Map<String, Object> parameters = parameters(domain, filters);
        parameters.put("process", process);
        addEquals(
                sql,
                parameters,
                filters,
                "record_type",
                " AND record_type = :record_type"
        );
        addDateRange(sql, parameters, filters, "business_date");
        addContains(
                sql,
                parameters,
                filters,
                "item",
                " AND (item_code LIKE :item OR item_name LIKE :item)"
        );
        addEquals(
                sql,
                parameters,
                filters,
                "resource_code",
                " AND resource_code = :resource_code"
        );
        addEquals(
                sql,
                parameters,
                filters,
                "status",
                " AND status = :status"
        );
        sql.append("""
                 ORDER BY business_date DESC,
                          CASE priority WHEN 'high' THEN 0 ELSE 1 END,
                          record_no
                 LIMIT :fetchLimit
                """);
        List<ObjectNode> rows = query(sql.toString(), parameters);
        rows.forEach(this::expandDetails);
        return result(domain, view, filters, rows);
    }

    public ObjectNode referenceObjects(
            String domain,
            String objectType,
            String view,
            ObjectNode filters
    ) {
        return referenceObjects(domain, Set.of(objectType), view, filters);
    }

    /**
     * 多 object type 版本（如工厂日历 + 班次模板同视图）；
     * IN 集合由调用方固定，模型不可选择。
     */
    public ObjectNode referenceObjects(
            String domain,
            Set<String> objectTypes,
            String view,
            ObjectNode filters
    ) {
        StringBuilder sql = new StringBuilder("""
                SELECT object_code AS objectCode,
                       object_name AS objectName,
                       object_type AS objectType,
                       process_code AS processCode,
                       version,
                       status,
                       resource_code AS resourceCode,
                       detail_json AS detailJson,
                       updated_at AS updatedAt
                FROM industrial_demo_reference_object
                WHERE domain_code = :domain
                  AND object_type IN (:objectTypes)
                """);
        Map<String, Object> parameters = parameters(domain, filters);
        parameters.put("objectTypes", List.copyOf(objectTypes));
        addContains(
                sql,
                parameters,
                filters,
                "query",
                " AND (object_code LIKE :query OR object_name LIKE :query)"
        );
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
                "status",
                " AND status = :status"
        );
        sql.append(" ORDER BY object_code LIMIT :fetchLimit");
        List<ObjectNode> rows = query(sql.toString(), parameters);
        rows.forEach(this::expandDetails);
        return result(domain, view, filters, rows);
    }

    /**
     * 链头需求订单（docs/27 §4）。state：unscheduled/scheduled/released/completed。
     */
    public ObjectNode demandOrders(
            String domain,
            ObjectNode filters
    ) {
        StringBuilder sql = new StringBuilder("""
                SELECT demand_no AS demandNo,
                       item_code AS itemCode,
                       item_name AS itemName,
                       quantity,
                       unit,
                       due_date AS dueDate,
                       priority,
                       state,
                       source,
                       updated_at AS updatedAt
                FROM industrial_demo_demand_order
                WHERE domain_code = :domain
                """);
        Map<String, Object> parameters = parameters(domain, filters);
        addContains(
                sql,
                parameters,
                filters,
                "item",
                " AND (item_code LIKE :item OR item_name LIKE :item)"
        );
        addEquals(sql, parameters, filters, "state", " AND state = :state");
        addEquals(
                sql,
                parameters,
                filters,
                "priority",
                " AND priority = :priority"
        );
        addDateRange(sql, parameters, filters, "due_date");
        sql.append("""
                 ORDER BY due_date,
                          CASE priority WHEN 'high' THEN 0 ELSE 1 END,
                          demand_no
                 LIMIT :fetchLimit
                """);
        return result(
                domain,
                "demand_orders",
                filters,
                query(sql.toString(), parameters)
        );
    }

    /**
     * 批次谱系主档：批次是串联计划、快检与下游去向的主键。
     */
    public ObjectNode batches(
            String domain,
            ObjectNode filters
    ) {
        StringBuilder sql = new StringBuilder("""
                SELECT batch_no AS batchNo,
                       item_code AS itemCode,
                       item_name AS itemName,
                       plan_no AS planNo,
                       equipment_code AS equipmentCode,
                       process_code AS processCode,
                       produced_at AS producedAt,
                       quantity,
                       unit,
                       quality_state AS qualityState,
                       downstream_ref AS downstreamRef,
                       updated_at AS updatedAt
                FROM industrial_demo_batch
                WHERE domain_code = :domain
                """);
        Map<String, Object> parameters = parameters(domain, filters);
        addContains(
                sql,
                parameters,
                filters,
                "batch",
                " AND batch_no LIKE :batch"
        );
        addContains(
                sql,
                parameters,
                filters,
                "item",
                " AND (item_code LIKE :item OR item_name LIKE :item)"
        );
        addEquals(
                sql,
                parameters,
                filters,
                "plan_no",
                " AND plan_no = :plan_no"
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
                "quality_state",
                " AND quality_state = :quality_state"
        );
        sql.append(" ORDER BY produced_at DESC, batch_no LIMIT :fetchLimit");
        return result(
                domain,
                "mixing_batches",
                filters,
                query(sql.toString(), parameters)
        );
    }

    /**
     * 原料收发存流转。movement_type：receipt/issue/return。
     */
    public ObjectNode materialMovements(
            String domain,
            ObjectNode filters
    ) {
        StringBuilder sql = new StringBuilder("""
                SELECT movement_no AS movementNo,
                       material_code AS materialCode,
                       material_name AS materialName,
                       movement_type AS movementType,
                       quantity,
                       unit,
                       warehouse_code AS warehouseCode,
                       related_no AS relatedNo,
                       occurred_at AS occurredAt
                FROM industrial_demo_material_movement
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
                "movement_type",
                " AND movement_type = :movement_type"
        );
        addEquals(
                sql,
                parameters,
                filters,
                "warehouse_code",
                " AND warehouse_code = :warehouse_code"
        );
        addEquals(
                sql,
                parameters,
                filters,
                "related_no",
                " AND related_no = :related_no"
        );
        addTimestampRange(sql, parameters, filters, "occurred_at");
        sql.append(" ORDER BY occurred_at DESC, movement_no LIMIT :fetchLimit");
        ObjectNode result = result(
                domain,
                "material_movements",
                filters,
                query(sql.toString(), parameters)
        );
        double received = 0;
        double issued = 0;
        double returned = 0;
        for (var row : result.withArray("rows")) {
            double quantity = row.path("quantity").asDouble();
            switch (row.path("movementType").asText()) {
                case "receipt" -> received += quantity;
                case "issue" -> issued += quantity;
                case "return" -> returned += quantity;
                default -> {
                }
            }
        }
        ObjectNode summary = result.putObject("summary");
        summary.put("receivedQuantity", received);
        summary.put("issuedQuantity", issued);
        summary.put("returnedQuantity", returned);
        return result;
    }

    /**
     * 质量异常台账（读视图）。status：open/disposed/closed。
     */
    public ObjectNode qualityExceptions(
            String domain,
            ObjectNode filters
    ) {
        StringBuilder sql = new StringBuilder("""
                SELECT exception_no AS exceptionNo,
                       item_code AS itemCode,
                       item_name AS itemName,
                       source_record_no AS sourceRecordNo,
                       defect_category AS defectCategory,
                       affected_quantity AS affectedQuantity,
                       status,
                       disposition,
                       version,
                       opened_at AS openedAt,
                       updated_at AS updatedAt
                FROM industrial_demo_quality_exception
                WHERE domain_code = :domain
                """);
        Map<String, Object> parameters = parameters(domain, filters);
        addContains(
                sql,
                parameters,
                filters,
                "item",
                " AND (item_code LIKE :item OR item_name LIKE :item)"
        );
        addEquals(sql, parameters, filters, "status", " AND status = :status");
        addEquals(
                sql,
                parameters,
                filters,
                "disposition",
                " AND disposition = :disposition"
        );
        sql.append(" ORDER BY opened_at DESC, exception_no LIMIT :fetchLimit");
        ObjectNode result = result(
                domain,
                "quality_exceptions",
                filters,
                query(sql.toString(), parameters)
        );
        int open = 0;
        int disposed = 0;
        for (var row : result.withArray("rows")) {
            if ("open".equals(row.path("status").asText())) {
                open++;
            } else if ("disposed".equals(row.path("status").asText())) {
                disposed++;
            }
        }
        ObjectNode summary = result.putObject("summary");
        summary.put("openCount", open);
        summary.put("disposedCount", disposed);
        return result;
    }

    /**
     * 批次全生命周期追溯（docs/27 §5 trace/genealogy）。
     *
     * <p>按批号或物料片段跨表串出各阶段行，每行带 stage 字段：
     * plan → batch → consumption → quality → semifinished / forming / curing →
     * warehouse → shipment。不是单表视图，是确定性的跨表走访。</p>
     */
    public ObjectNode batchTrace(
            String domain,
            ObjectNode filters
    ) {
        String batchNo = filters.path("batch_no").asText();
        String item = filters.path("item").asText();
        List<ObjectNode> rows = new ArrayList<>();
        if (!batchNo.isBlank()) {
            Map<String, Object> batchParams = Map.of(
                    "domain",
                    domain,
                    "batchNo",
                    "%" + batchNo + "%"
            );
            List<ObjectNode> batchRows = query(
                    """
                    SELECT batch_no AS batchNo, item_code AS itemCode,
                           item_name AS itemName, plan_no AS planNo,
                           equipment_code AS equipmentCode,
                           produced_at AS producedAt, quantity, unit,
                           quality_state AS qualityState,
                           downstream_ref AS downstreamRef
                    FROM industrial_demo_batch
                    WHERE domain_code = :domain AND batch_no LIKE :batchNo
                    ORDER BY produced_at DESC LIMIT 10
                    """,
                    batchParams
            );
            for (ObjectNode batch : batchRows) {
                rows.add(withStage(batch, "batch"));
                String planNo = batch.path("planNo").asText();
                Map<String, Object> planParams = Map.of(
                        "domain",
                        domain,
                        "planNo",
                        planNo
                );
                query(
                        """
                        SELECT plan_no AS planNo, process_code AS processCode,
                               plan_date AS planDate, equipment_code AS equipmentCode,
                               material_code AS materialCode,
                               material_name AS materialName,
                               planned_batches AS plannedBatches,
                               completed_batches AS completedBatches,
                               shift_code AS shiftCode, status
                        FROM industrial_demo_production_plan
                        WHERE domain_code = :domain AND plan_no = :planNo
                        LIMIT 5
                        """,
                        planParams
                ).forEach(plan -> rows.add(withStage(plan, "plan")));
                Map<String, Object> stepParams = Map.of(
                        "domain",
                        domain,
                        "batchNo",
                        batch.path("batchNo").asText()
                );
                query(
                        """
                        SELECT sample_no AS sampleNo, metric_code AS metricCode,
                               measured_value AS measuredValue,
                               lower_limit AS lowerLimit,
                               upper_limit AS upperLimit,
                               judge_result AS judgeResult,
                               sampled_at AS sampledAt
                        FROM industrial_demo_quality_measurement
                        WHERE domain_code = :domain AND batch_no = :batchNo
                        ORDER BY sampled_at DESC LIMIT 10
                        """,
                        stepParams
                ).forEach(quality -> rows.add(withStage(quality, "quality")));
                query(
                        """
                        SELECT record_type AS recordType, record_no AS recordNo,
                               business_date AS businessDate,
                               item_code AS itemCode, item_name AS itemName,
                               resource_code AS resourceCode, status,
                               detail_json AS detailJson
                        FROM industrial_demo_process_record
                        WHERE domain_code = :domain
                          AND detail_json LIKE :batchRef
                        ORDER BY business_date DESC LIMIT 10
                        """,
                        Map.of(
                                "domain",
                                domain,
                                "batchRef",
                                "%" + batch.path("batchNo").asText() + "%"
                        )
                ).forEach(record -> {
                    expandDetails(record);
                    rows.add(withStage(
                            record,
                            record.path("recordType").asText()
                    ));
                });
                String downstream = batch.path("downstreamRef").asText();
                if (!downstream.isBlank()) {
                    query(
                            """
                            SELECT process_code AS processCode,
                                   record_type AS recordType,
                                   record_no AS recordNo,
                                   business_date AS businessDate,
                                   item_code AS itemCode, item_name AS itemName,
                                   resource_code AS resourceCode, status,
                                   planned_quantity AS plannedQuantity,
                                   actual_quantity AS actualQuantity, unit,
                                   detail_json AS detailJson
                            FROM industrial_demo_process_record
                            WHERE domain_code = :domain AND record_no = :recordNo
                            LIMIT 5
                            """,
                            Map.of("domain", domain, "recordNo", downstream)
                    ).forEach(record -> {
                        expandDetails(record);
                        rows.add(withStage(
                                record,
                                record.path("processCode").asText()
                        ));
                    });
                }
            }
        } else if (!item.isBlank()) {
            String like = "%" + item + "%";
            query(
                    """
                    SELECT batch_no AS batchNo, item_code AS itemCode,
                           item_name AS itemName, plan_no AS planNo,
                           equipment_code AS equipmentCode,
                           produced_at AS producedAt, quantity, unit,
                           quality_state AS qualityState,
                           downstream_ref AS downstreamRef
                    FROM industrial_demo_batch
                    WHERE domain_code = :domain
                      AND (item_code LIKE :item OR item_name LIKE :item)
                    ORDER BY produced_at DESC LIMIT 20
                    """,
                    Map.of("domain", domain, "item", like)
            ).forEach(batch -> rows.add(withStage(batch, "batch")));
            query(
                    """
                    SELECT process_code AS processCode,
                           record_type AS recordType, record_no AS recordNo,
                           business_date AS businessDate,
                           item_code AS itemCode, item_name AS itemName,
                           resource_code AS resourceCode, status,
                           planned_quantity AS plannedQuantity,
                           actual_quantity AS actualQuantity, unit,
                           detail_json AS detailJson
                    FROM industrial_demo_process_record
                    WHERE domain_code = :domain
                      AND (item_code LIKE :item OR item_name LIKE :item)
                    ORDER BY business_date DESC LIMIT 40
                    """,
                    Map.of("domain", domain, "item", like)
            ).forEach(record -> {
                expandDetails(record);
                rows.add(withStage(
                        record,
                        record.path("processCode").asText()
                                + "_" + record.path("recordType").asText()
                ));
            });
            query(
                    """
                    SELECT plan_no AS planNo, process_code AS processCode,
                           plan_date AS planDate, equipment_code AS equipmentCode,
                           material_code AS materialCode,
                           material_name AS materialName,
                           planned_batches AS plannedBatches,
                           completed_batches AS completedBatches,
                           shift_code AS shiftCode, status
                    FROM industrial_demo_production_plan
                    WHERE domain_code = :domain
                      AND (material_code LIKE :item OR material_name LIKE :item)
                    ORDER BY plan_date DESC LIMIT 20
                    """,
                    Map.of("domain", domain, "item", like)
            ).forEach(plan -> rows.add(withStage(plan, "plan")));
        }
        rows.sort(Comparator.comparingInt(
                row -> stageOrder(row.path("stage").asText())
        ));
        return result(domain, "batch_trace", filters, rows);
    }

    /**
     * 计划执行报表：按工序×日期聚合计划量、完成量与达成率。
     */
    public ObjectNode reportPlanExecution(
            String domain,
            ObjectNode filters
    ) {
        StringBuilder sql = new StringBuilder("""
                SELECT process_code AS processCode,
                       plan_date AS planDate,
                       COUNT(*) AS planCount,
                       SUM(planned_batches) AS plannedBatches,
                       SUM(completed_batches) AS completedBatches,
                       ROUND(
                           CASE WHEN SUM(planned_batches) = 0 THEN 0
                                ELSE SUM(completed_batches) * 100.0
                                     / SUM(planned_batches) END,
                           1
                       ) AS completionPercent,
                       SUM(planned_weight) AS plannedWeight,
                       SUM(actual_weight) AS actualWeight
                FROM industrial_demo_production_plan
                WHERE domain_code = :domain
                """);
        Map<String, Object> parameters = parameters(domain, filters);
        addDateRange(sql, parameters, filters, "plan_date");
        addEquals(
                sql,
                parameters,
                filters,
                "process_code",
                " AND process_code = :process_code"
        );
        sql.append("""
                 GROUP BY process_code, plan_date
                 ORDER BY plan_date DESC, process_code
                 LIMIT :fetchLimit
                """);
        ObjectNode result = result(
                domain,
                "report_plan_execution",
                filters,
                query(sql.toString(), parameters)
        );
        double planned = 0;
        double completed = 0;
        for (var row : result.withArray("rows")) {
            planned += row.path("plannedBatches").asDouble();
            completed += row.path("completedBatches").asDouble();
        }
        ObjectNode summary = result.putObject("summary");
        summary.put("plannedBatches", planned);
        summary.put("completedBatches", completed);
        summary.put(
                "completionPercent",
                planned == 0
                        ? 0
                        : Math.round(completed * 1000.0 / planned) / 10.0
        );
        return result;
    }

    /**
     * 质量汇总报表：按物料聚合测量数、合格率与未闭环异常数。
     */
    public ObjectNode reportQualitySummary(
            String domain,
            ObjectNode filters
    ) {
        StringBuilder sql = new StringBuilder("""
                SELECT material_code AS itemCode,
                       COUNT(*) AS measurementCount,
                       SUM(CASE WHEN judge_result = 'pass' THEN 1 ELSE 0 END)
                           AS passedCount,
                       SUM(CASE WHEN judge_result = 'fail' THEN 1 ELSE 0 END)
                           AS failedCount,
                       ROUND(
                           SUM(CASE WHEN judge_result = 'pass' THEN 1 ELSE 0 END)
                               * 100.0 / COUNT(*),
                           1
                       ) AS passRatePercent
                FROM industrial_demo_quality_measurement
                WHERE domain_code = :domain
                """);
        Map<String, Object> parameters = parameters(domain, filters);
        addTimestampRange(sql, parameters, filters, "sampled_at");
        sql.append(" GROUP BY material_code ORDER BY itemCode LIMIT :fetchLimit");
        List<ObjectNode> rows = query(sql.toString(), parameters);
        Map<String, Object> exceptionParams = Map.of("domain", domain);
        Map<String, int[]> exceptionsByItem = new LinkedHashMap<>();
        query(
                """
                SELECT item_code AS itemCode,
                       SUM(CASE WHEN status = 'open' THEN 1 ELSE 0 END)
                           AS openCount,
                       SUM(CASE WHEN status = 'disposed' THEN 1 ELSE 0 END)
                           AS disposedCount
                FROM industrial_demo_quality_exception
                WHERE domain_code = :domain
                GROUP BY item_code
                """,
                exceptionParams
        ).forEach(row -> exceptionsByItem.put(
                row.path("itemCode").asText(),
                new int[]{
                    row.path("openCount").asInt(),
                    row.path("disposedCount").asInt()
                }
        ));
        int totalMeasurements = 0;
        int totalPassed = 0;
        for (ObjectNode row : rows) {
            int[] counts = exceptionsByItem.get(row.path("itemCode").asText());
            row.put("openExceptionCount", counts == null ? 0 : counts[0]);
            row.put("disposedExceptionCount", counts == null ? 0 : counts[1]);
            totalMeasurements += row.path("measurementCount").asInt();
            totalPassed += row.path("passedCount").asInt();
        }
        ObjectNode result = result(
                domain,
                "report_quality_summary",
                filters,
                rows
        );
        ObjectNode summary = result.putObject("summary");
        summary.put("measurementCount", totalMeasurements);
        summary.put(
                "passRatePercent",
                totalMeasurements == 0
                        ? 0
                        : Math.round(totalPassed * 1000.0 / totalMeasurements)
                                / 10.0
        );
        return result;
    }

    /**
     * 延误计划：plan_date 早于基准日（filters.as_of_date，必填）
     * 且仍未完成（scheduled/running）。通用交期风险视图，
     * 对齐成熟 MES 普遍提供的延误数据模式（docs/27 §5.1）。
     */
    public ObjectNode planDelays(
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
                       shift_code AS shiftCode,
                       priority,
                       status,
                       CAST(julianday(:as_of) - julianday(plan_date)
                           AS INTEGER) AS daysDelayed
                FROM industrial_demo_production_plan
                WHERE domain_code = :domain
                  AND plan_date < :as_of
                  AND status IN ('scheduled', 'running')
                """);
        Map<String, Object> parameters = parameters(domain, filters);
        parameters.put("as_of", filters.path("as_of_date").asText());
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
                "equipment_code",
                " AND equipment_code = :equipment_code"
        );
        sql.append(" ORDER BY daysDelayed DESC, plan_no LIMIT :fetchLimit");
        ObjectNode result = result(
                domain,
                "plan_delays",
                filters,
                query(sql.toString(), parameters)
        );
        double remaining = 0;
        for (var row : result.withArray("rows")) {
            remaining += row.path("plannedBatches").asDouble()
                    - row.path("completedBatches").asDouble();
        }
        ObjectNode summary = result.putObject("summary");
        summary.put("delayedPlanCount", result.path("rowCount").asInt());
        summary.put("remainingBatches", remaining);
        return result;
    }

    // ── 写操作支持（docs/27 §5.3）。所有写方法只做参数化 SQL 与乐观校验，
    //    业务规则（锁定、冲突策略、状态机）在 Tool 层判定。
    /** 按主键读单条工序记录；不存在返回 null。 */
    public ObjectNode findProcessRecord(
            String domain,
            String process,
            String recordType,
            String recordNo
    ) {
        List<ObjectNode> rows = query(
                """
                SELECT record_type AS recordType, record_no AS recordNo,
                       business_date AS businessDate,
                       item_code AS itemCode, item_name AS itemName,
                       resource_code AS resourceCode, status,
                       planned_quantity AS plannedQuantity,
                       actual_quantity AS actualQuantity, unit, priority,
                       detail_json AS detailJson
                FROM industrial_demo_process_record
                WHERE domain_code = :domain
                  AND process_code = :process
                  AND record_type = :recordType
                  AND record_no = :recordNo
                LIMIT 1
                """,
                Map.of(
                        "domain",
                        domain,
                        "process",
                        process,
                        "recordType",
                        recordType,
                        "recordNo",
                        recordNo
                )
        );
        if (rows.isEmpty()) {
            return null;
        }
        ObjectNode row = rows.get(0);
        expandDetails(row);
        return row;
    }

    /** 按主键读单条生产计划；不存在返回 null。 */
    public ObjectNode findPlan(String domain, String planNo) {
        List<ObjectNode> rows = query(
                """
                SELECT plan_no AS planNo, process_code AS processCode,
                       plan_date AS planDate, equipment_code AS equipmentCode,
                       material_code AS materialCode,
                       material_name AS materialName,
                       planned_batches AS plannedBatches,
                       completed_batches AS completedBatches,
                       planned_weight AS plannedWeight,
                       actual_weight AS actualWeight,
                       shift_code AS shiftCode, priority, status
                FROM industrial_demo_production_plan
                WHERE domain_code = :domain AND plan_no = :planNo
                LIMIT 1
                """,
                Map.of("domain", domain, "planNo", planNo)
        );
        return rows.isEmpty() ? null : rows.get(0);
    }

    /** 目标机台某日的既有计划（发布冲突检查用）。 */
    public List<ObjectNode> findPlansForEquipmentDate(
            String domain,
            String equipmentCode,
            String planDate
    ) {
        return query(
                """
                SELECT plan_no AS planNo, material_code AS materialCode,
                       planned_batches AS plannedBatches,
                       completed_batches AS completedBatches,
                       shift_code AS shiftCode, status
                FROM industrial_demo_production_plan
                WHERE domain_code = :domain
                  AND equipment_code = :equipmentCode
                  AND plan_date = :planDate
                ORDER BY plan_no
                """,
                Map.of(
                        "domain",
                        domain,
                        "equipmentCode",
                        equipmentCode,
                        "planDate",
                        planDate
                )
        );
    }

    /** 发布排程 → 新增生产计划。返回插入行数。 */
    public int insertProductionPlan(
            String domain,
            String planNo,
            String processCode,
            String planDate,
            String equipmentCode,
            String materialCode,
            String materialName,
            int plannedBatches,
            double plannedWeight,
            String shiftCode,
            String priority,
            String status
    ) {
        return update(
                """
                INSERT INTO industrial_demo_production_plan (
                    domain_code, plan_no, process_code, plan_date,
                    equipment_code, material_code, material_name,
                    planned_batches, completed_batches,
                    planned_weight, actual_weight,
                    shift_code, priority, status
                ) VALUES (
                    :domain, :planNo, :processCode, :planDate,
                    :equipmentCode, :materialCode, :materialName,
                    :plannedBatches, 0, :plannedWeight, 0,
                    :shiftCode, :priority, :status
                )
                """,
                mapOf(
                        "domain", domain,
                        "planNo", planNo,
                        "processCode", processCode,
                        "planDate", planDate,
                        "equipmentCode", equipmentCode,
                        "materialCode", materialCode,
                        "materialName", materialName,
                        "plannedBatches", plannedBatches,
                        "plannedWeight", plannedWeight,
                        "shiftCode", shiftCode,
                        "priority", priority,
                        "status", status
                )
        );
    }

    /** 乐观更新工序记录状态并合并 details 补丁；expectedStatus 不匹配返回 0。 */
    public int updateProcessRecordStatus(
            String domain,
            String process,
            String recordType,
            String recordNo,
            String expectedStatus,
            String newStatus,
            ObjectNode detailPatch,
            String updatedAt
    ) {
        ObjectNode current = findProcessRecord(
                domain,
                process,
                recordType,
                recordNo
        );
        if (current == null) {
            return 0;
        }
        ObjectNode details = (ObjectNode) current.path("details").deepCopy();
        details.setAll(detailPatch);
        try {
            return update(
                    """
                    UPDATE industrial_demo_process_record
                    SET status = :newStatus,
                        detail_json = :detailJson,
                        updated_at = :updatedAt
                    WHERE domain_code = :domain
                      AND process_code = :process
                      AND record_type = :recordType
                      AND record_no = :recordNo
                      AND status = :expectedStatus
                    """,
                    Map.of(
                            "newStatus", newStatus,
                            "detailJson", objectMapper.writeValueAsString(details),
                            "updatedAt", updatedAt,
                            "domain", domain,
                            "process", process,
                            "recordType", recordType,
                            "recordNo", recordNo,
                            "expectedStatus", expectedStatus
                    )
            );
        } catch (JsonProcessingException exception) {
            throw new IndustrialDemoQueryException(
                    "industrial_demo_record_invalid",
                    "工序记录 details 补丁无法序列化；这是后端缺陷而非业务冲突",
                    exception
            );
        }
    }

    /** 乐观更新需求状态；expectedState 不匹配返回 0。 */
    public int updateDemandState(
            String domain,
            String demandNo,
            String expectedState,
            String newState,
            String updatedAt
    ) {
        return update(
                """
                UPDATE industrial_demo_demand_order
                SET state = :newState, updated_at = :updatedAt
                WHERE domain_code = :domain
                  AND demand_no = :demandNo
                  AND state = :expectedState
                """,
                Map.of(
                        "newState", newState,
                        "updatedAt", updatedAt,
                        "domain", domain,
                        "demandNo", demandNo,
                        "expectedState", expectedState
                )
        );
    }

    /** 乐观更新计划状态/优先级；守护条件不满足返回 0。 */
    public int updatePlanState(
            String domain,
            String planNo,
            String expectedStatus,
            String newStatus,
            String priority,
            String updatedAt
    ) {
        return update(
                """
                UPDATE industrial_demo_production_plan
                SET status = :newStatus, priority = :priority
                WHERE domain_code = :domain
                  AND plan_no = :planNo
                  AND status = :expectedStatus
                  AND completed_batches = 0
                """,
                Map.of(
                        "newStatus", newStatus,
                        "priority", priority,
                        "domain", domain,
                        "planNo", planNo,
                        "expectedStatus", expectedStatus
                )
        );
    }

    /** 按主键读单条质量异常；不存在返回 null。 */
    public ObjectNode findQualityException(
            String domain,
            String exceptionNo
    ) {
        List<ObjectNode> rows = query(
                """
                SELECT exception_no AS exceptionNo, item_code AS itemCode,
                       item_name AS itemName,
                       source_record_no AS sourceRecordNo,
                       defect_category AS defectCategory,
                       affected_quantity AS affectedQuantity,
                       status, disposition, version,
                       opened_at AS openedAt, updated_at AS updatedAt
                FROM industrial_demo_quality_exception
                WHERE domain_code = :domain AND exception_no = :exceptionNo
                LIMIT 1
                """,
                Map.of("domain", domain, "exceptionNo", exceptionNo)
        );
        return rows.isEmpty() ? null : rows.get(0);
    }

    /** 乐观处置质量异常；version 不匹配或已不是 open 返回 0。 */
    public int disposeQualityException(
            String domain,
            String exceptionNo,
            String disposition,
            int expectedVersion,
            String updatedAt
    ) {
        return update(
                """
                UPDATE industrial_demo_quality_exception
                SET status = 'disposed',
                    disposition = :disposition,
                    version = version + 1,
                    updated_at = :updatedAt
                WHERE domain_code = :domain
                  AND exception_no = :exceptionNo
                  AND status = 'open'
                  AND version = :expectedVersion
                """,
                Map.of(
                        "disposition", disposition,
                        "updatedAt", updatedAt,
                        "domain", domain,
                        "exceptionNo", exceptionNo,
                        "expectedVersion", expectedVersion
                )
        );
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
        try {
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
        } catch (DataAccessException exception) {
            throw dataFailure("只读 SQL 查询", exception);
        }
    }

    private int update(
            String sql,
            Map<String, Object> parameters
    ) {
        try {
            return jdbc.sql(sql).params(parameters).update();
        } catch (DataAccessException exception) {
            throw dataFailure("写入 SQL 执行", exception);
        }
    }

    private IndustrialDemoQueryException dataFailure(
            String operation,
            DataAccessException exception
    ) {
        Throwable cause = exception.getMostSpecificCause();
        String diagnostic = cause.getMessage() == null
                ? cause.getClass().getSimpleName()
                : cause.getMessage().replaceAll("\\s+", " ").trim();
        if (diagnostic.length() > 400) {
            diagnostic = diagnostic.substring(0, 400);
        }
        return new IndustrialDemoQueryException(
                "industrial_demo_sql_unavailable",
                "工业域的" + operation + "失败；无需原样重试参数，"
                        + "请确认后端 SQLite schema 已初始化。环境反馈："
                        + diagnostic,
                exception
        );
    }

    private ObjectNode withStage(ObjectNode row, String stage) {
        row.put("stage", stage);
        return row;
    }

    private static int stageOrder(String stage) {
        if (stage.startsWith("aps")) {
            return 5;
        }
        if (stage.equals("plan") || stage.endsWith("_plan")) {
            return 10;
        }
        if (stage.equals("batch")) {
            return 20;
        }
        if (stage.startsWith("mixing")
                || stage.equals("consumption")
                || stage.equals("feeding")) {
            return 30;
        }
        if (stage.startsWith("quality")) {
            return 40;
        }
        if (stage.startsWith("semifinished")) {
            return 50;
        }
        if (stage.startsWith("forming")) {
            return 60;
        }
        if (stage.startsWith("curing")) {
            return 70;
        }
        if (stage.startsWith("warehouse") || stage.equals("shipment")) {
            return 80;
        }
        return 90;
    }

    /** Map.of 最多 10 对；写操作参数更多时用变长构造。 */
    private static Map<String, Object> mapOf(Object... keyValues) {
        Map<String, Object> map = new LinkedHashMap<>();
        for (int index = 0; index < keyValues.length; index += 2) {
            map.put((String) keyValues[index], keyValues[index + 1]);
        }
        return map;
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

    private void expandDetails(ObjectNode row) {
        String json = row.path("detailJson").asText();
        row.remove("detailJson");
        try {
            row.set("details", objectMapper.readTree(json));
        } catch (JsonProcessingException exception) {
            throw new IndustrialDemoQueryException(
                    "industrial_demo_record_invalid",
                    "工业模拟记录的 details 不是合法 JSON；该记录不能作为业务证据，"
                            + "请修复模拟数据后再查询",
                    exception
            );
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
        result.put("dataset", "iris-industrial");
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
                                ? "没有符合条件的记录；可放宽筛选条件"
                                : "已返回当前筛选范围内的全部记录"
        );
        return result;
    }
}
