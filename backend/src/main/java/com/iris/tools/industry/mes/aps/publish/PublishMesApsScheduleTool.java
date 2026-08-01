package com.iris.tools.industry.mes.aps.publish;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.node.ArrayNode;
import com.fasterxml.jackson.databind.node.ObjectNode;
import com.iris.industry.demo.IndustrialDemoRepository;
import com.iris.tools.core.CommittedOperation;
import com.iris.tools.core.PreparedOperation;
import com.iris.tools.core.PreparedOperation.ResourceClaim;
import com.iris.tools.core.ToolContext;
import com.iris.tools.core.ToolOutcome;
import com.iris.tools.core.ToolManifest;
import com.iris.tools.core.VerificationResult;
import com.iris.tools.industry.mes.AbstractMesWriteTool;
import org.springframework.stereotype.Component;
import org.springframework.transaction.PlatformTransactionManager;
import org.springframework.transaction.support.TransactionTemplate;

import java.time.Instant;
import java.util.ArrayList;
import java.util.List;
import java.util.Set;

/**
 * 把已评估的 APS 班次排程发布为生产计划（docs/27 §5.3）。
 *
 * <p>排程记录 details.plans 逐行冲突检查后落库 scheduled 计划；
 * 排程记录乐观翻转为 published（状态机即幂等闸：重复发布必被拒），
 * 关联需求回写 scheduled。锁定规则：目标机台同日已有 running/completed
 * 或有完成量的计划时，block 策略必拒，append 策略跳过冲突行。</p>
 */
@Component
public class PublishMesApsScheduleTool extends AbstractMesWriteTool {
    private static final Set<String> CONFLICT_POLICIES = Set.of(
            "block",
            "append"
    );
    private static final Set<String> PUBLISHABLE = Set.of(
            "feasible",
            "accepted"
    );
    private static final Set<String> LOCKED_STATUSES = Set.of(
            "running",
            "completed"
    );
    private final TransactionTemplate transactions;

    public PublishMesApsScheduleTool(
            ObjectMapper objectMapper,
            IndustrialDemoRepository repository,
            PlatformTransactionManager transactionManager
    ) {
        super(
                objectMapper,
                repository,
                writeManifest(
                        "iris.industry.mes.publish_aps_schedule",
                        "publish_mes_aps_schedule",
                        "把已评估的 APS 班次排程发布为生产计划：逐行冲突检查后落库 scheduled 计划，排程标记 published，关联需求回写 scheduled；目标机台同日已有执行中/已完成计划时 block（默认）必拒并列出冲突明细、append 跳过冲突行；重复发布同一排程被幂等拦截并返回原计划号；排产落地时使用",
                        inputSchema(objectMapper),
                        outputSchema(objectMapper),
                        ToolManifest.IdempotencySemantics.IDEMPOTENT_WITH_KEY
                )
        );
        this.transactions = new TransactionTemplate(transactionManager);
    }

    @Override
    public PreparedOperation prepare(JsonNode input, ToolContext context) {
        String recordNo = requireText(input, "schedule_record_no", 60);
        String policy = requireEnum(
                input,
                "conflict_policy",
                CONFLICT_POLICIES
        );
        ObjectNode record = findSchedule(recordNo);
        String status = record.path("status").asText();
        String demandNo = record.path("details")
                .path("demandNo")
                .asText("")
                .trim();
        ObjectNode normalized = objectMapper.createObjectNode();
        normalized.put("schedule_record_no", recordNo);
        normalized.put("conflict_policy", policy);
        normalized.put("demand_no", demandNo);
        if ("published".equals(status)) {
            // 幂等拦截（对齐真实发布语义）：重复发布不报错、不重复写入。
            normalized.put("already_published", true);
            return new PreparedOperation(
                    normalized,
                    "排程 " + recordNo
                            + " 此前已发布，本次不会重复写入（幂等拦截）",
                    List.of(new ResourceClaim(
                            "industrial_demo_record",
                            "mes/aps/schedule/" + recordNo,
                            status
                    )),
                    Instant.now().plusSeconds(300)
            );
        }
        if (!PUBLISHABLE.contains(status)) {
            throw invalid(
                    "排程状态为 " + status
                            + "，只有 feasible/accepted 可发布"
            );
        }
        JsonNode plans = record.path("details").path("plans");
        if (!plans.isArray() || plans.isEmpty()) {
            throw invalid("排程记录未包含可发布的计划行（details.plans）");
        }
        normalized.put("already_published", false);
        String impact = "将把排程 " + recordNo + " 发布为 " + plans.size()
                + " 条生产计划（状态 scheduled，冲突策略 " + policy
                + "），排程记录标记为 published"
                + (demandNo.isBlank()
                        ? ""
                        : "，需求 " + demandNo + " 回写为 scheduled");
        return new PreparedOperation(
                normalized,
                impact,
                List.of(new ResourceClaim(
                        "industrial_demo_record",
                        "mes/aps/schedule/" + recordNo,
                        status
                )),
                Instant.now().plusSeconds(300)
        );
    }

    @Override
    public ToolOutcome execute(
            CommittedOperation operation,
            ToolContext context
    ) {
        checkCancelled(context, "任务已停止，排程尚未发布");
        ToolOutcome outcome = transactions.execute(
                ignored -> publish(operation, context)
        );
        if (outcome == null) {
            throw conflict("排程发布事务未返回结果");
        }
        return outcome;
    }

    private ToolOutcome publish(
            CommittedOperation operation,
            ToolContext context
    ) {
        JsonNode normalized = operation.normalizedInput();
        String recordNo = normalized.path("schedule_record_no").asText();
        String policy = normalized.path("conflict_policy").asText();
        ObjectNode record = findSchedule(recordNo);
        String status = record.path("status").asText();
        if ("published".equals(status)
                || normalized.path("already_published").asBoolean(false)) {
            return alreadyPublishedOutcome(recordNo, record);
        }
        if (!PUBLISHABLE.contains(status)) {
            throw conflict(
                    "排程状态已变为 " + status + "，无法发布"
            );
        }
        JsonNode plans = record.path("details").path("plans");
        // 第一遍：逐行冲突检查并收集明细。block 遇锁定即整单拒绝并列出冲突；
        // append 全冲突也拒绝，两种拒绝都发生在任何写入之前。
        List<Boolean> locked = new ArrayList<>();
        List<String> conflictDetails = new ArrayList<>();
        for (JsonNode row : plans) {
            String detail = lockDetail(recordNo, row);
            locked.add(detail != null);
            if (detail != null) {
                conflictDetails.add(detail);
            }
        }
        if (!conflictDetails.isEmpty() && "block".equals(policy)) {
            throw conflict(
                    "以下计划行与锁定计划（执行中/已完成/已有完成量）冲突："
                            + String.join("；", conflictDetails)
                            + "。block 策略整单拒绝；可改用 append 跳过冲突行"
            );
        }
        if (conflictDetails.size() == plans.size()) {
            throw conflict("所有计划行均与锁定计划冲突，未发布任何计划");
        }
        checkCancelled(context, "任务已停止，排程尚未发布");
        // 排程状态、计划行和需求状态在同一事务内提交；任何一步失败都会整体回滚。
        // 状态翻转仍是并发发布的乐观闸门。
        ArrayNode planNos = objectMapper.createArrayNode();
        int index = 0;
        for (JsonNode row : plans) {
            index++;
            if (!locked.get(index - 1)) {
                planNos.add("PLAN-" + recordNo + "-" + index);
            }
        }
        ObjectNode patch = objectMapper.createObjectNode();
        patch.put("publishedAt", now());
        patch.set("publishedPlanNos", planNos);
        int flipped = repository.updateProcessRecordStatus(
                domain(),
                "aps",
                "schedule",
                recordNo,
                status,
                "published",
                patch,
                now()
        );
        if (flipped == 0) {
            throw conflict("排程已被并发发布或状态已变化");
        }
        index = 0;
        List<String> inserted = new ArrayList<>();
        List<String> skipped = new ArrayList<>();
        double totalBatches = 0;
        double totalWeight = 0;
        for (JsonNode row : plans) {
            index++;
            if (locked.get(index - 1)) {
                skipped.add(
                        row.path("equipmentCode").asText()
                                + "@" + row.path("planDate").asText()
                );
                continue;
            }
            String planNo = "PLAN-" + recordNo + "-" + index;
            int insertedRows = repository.insertProductionPlan(
                    domain(),
                    planNo,
                    row.path("processCode").asText("curing"),
                    row.path("planDate").asText(),
                    row.path("equipmentCode").asText(),
                    record.path("itemCode").asText(),
                    record.path("itemName").asText(),
                    row.path("plannedBatches").asInt(),
                    row.path("plannedWeight").asDouble(0),
                    row.path("shiftCode").asText("day"),
                    record.path("priority").asText("normal"),
                    "scheduled"
            );
            if (insertedRows != 1) {
                throw conflict("生产计划 " + planNo + " 未能完整落库");
            }
            inserted.add(planNo);
            totalBatches += row.path("plannedBatches").asDouble();
            totalWeight += row.path("plannedWeight").asDouble(0);
        }
        String demandNo = normalized.path("demand_no").asText();
        boolean demandUpdated = false;
        if (!demandNo.isBlank()) {
            demandUpdated = repository.updateDemandState(
                    domain(),
                    demandNo,
                    "unscheduled",
                    "scheduled",
                    now()
            ) == 1;
            if (!demandUpdated) {
                throw conflict(
                        "关联需求 " + demandNo
                                + " 已不存在或状态不再是 unscheduled，发布已整体回滚"
                );
            }
        }
        ObjectNode output = objectMapper.createObjectNode();
        output.put("scheduleRecordNo", recordNo);
        output.put("alreadyPublished", false);
        ArrayNode insertedNode = output.putArray("publishedPlanNos");
        inserted.forEach(insertedNode::add);
        ArrayNode skippedNode = output.putArray("skippedConflicts");
        skipped.forEach(skippedNode::add);
        output.put("demandNo", demandNo);
        output.put("demandUpdated", demandUpdated);
        output.put("totalPlannedBatches", totalBatches);
        output.put("totalPlannedWeight", totalWeight);
        return ToolOutcome.succeeded(output);
    }

    /** 幂等拦截：重复发布返回原计划号，不重复写入。 */
    private ToolOutcome alreadyPublishedOutcome(
            String recordNo,
            ObjectNode record
    ) {
        ObjectNode output = objectMapper.createObjectNode();
        output.put("scheduleRecordNo", recordNo);
        output.put("alreadyPublished", true);
        ArrayNode planNos = output.putArray("publishedPlanNos");
        record.path("details")
                .path("publishedPlanNos")
                .forEach(planNos::add);
        output.putArray("skippedConflicts");
        output.put(
                "demandNo",
                record.path("details").path("demandNo").asText("")
        );
        output.put("demandUpdated", false);
        output.put("totalPlannedBatches", 0);
        output.put("totalPlannedWeight", 0);
        return ToolOutcome.succeeded(output);
    }

    @Override
    public VerificationResult verify(
            ToolOutcome outcome,
            CommittedOperation operation,
            ToolContext context
    ) {
        String recordNo = outcome.output()
                .path("scheduleRecordNo")
                .asText();
        String firstPlanNo = outcome.output()
                .path("publishedPlanNos")
                .path(0)
                .asText();
        ObjectNode record = repository.findProcessRecord(
                domain(),
                "aps",
                "schedule",
                recordNo
        );
        boolean alreadyPublished = outcome.output()
                .path("alreadyPublished")
                .asBoolean(false);
        if (alreadyPublished) {
            if (record != null
                    && "published".equals(record.path("status").asText())) {
                return VerificationResult.confirmed(List.of(
                        new VerificationResult.Evidence(
                                "industrial_demo_record",
                                "mes/aps/schedule/" + recordNo,
                                "排程此前已发布，本次幂等拦截未重复写入"
                        )
                ));
            }
            return new VerificationResult(
                    VerificationResult.Status.UNKNOWN,
                    List.of(),
                    "幂等拦截已返回，但排程状态无法确认"
            );
        }
        ObjectNode plan = firstPlanNo.isBlank()
                ? null
                : repository.findPlan(domain(), firstPlanNo);
        if (record == null
                || !"published".equals(record.path("status").asText())
                || plan == null) {
            return new VerificationResult(
                    VerificationResult.Status.UNKNOWN,
                    List.of(),
                    "发布已返回，但排程状态或首条计划无法确认"
            );
        }
        return VerificationResult.confirmed(List.of(
                new VerificationResult.Evidence(
                        "industrial_demo_record",
                        "mes/aps/schedule/" + recordNo,
                        "排程已标记为 published，本次发布 "
                                + outcome.output()
                                        .path("publishedPlanNos")
                                        .size()
                                + " 条计划"
                ),
                new VerificationResult.Evidence(
                        "industrial_demo_plan",
                        firstPlanNo,
                        "首条计划已落库，状态 "
                                + plan.path("status").asText()
                )
        ));
    }

    private ObjectNode findSchedule(String recordNo) {
        ObjectNode record = repository.findProcessRecord(
                domain(),
                "aps",
                "schedule",
                recordNo
        );
        if (record == null) {
            throw invalid("排程记录不存在：" + recordNo);
        }
        return record;
    }

    /**
     * 返回该计划行的冲突明细（机台@日期 + 锁定计划号与状态），
     * 无锁定冲突返回 null。
     */
    private String lockDetail(String recordNo, JsonNode row) {
        String equipment = row.path("equipmentCode").asText().trim();
        String planDate = row.path("planDate").asText().trim();
        if (equipment.isBlank() || planDate.isBlank()) {
            throw invalid(
                    "排程 " + recordNo
                            + " 的计划行缺少 equipmentCode/planDate"
            );
        }
        List<String> lockingPlans = repository
                .findPlansForEquipmentDate(domain(), equipment, planDate)
                .stream()
                .filter(plan ->
                        plan.path("completedBatches").asDouble() > 0
                                || LOCKED_STATUSES.contains(
                                        plan.path("status").asText()
                                ))
                .map(plan -> plan.path("planNo").asText()
                        + "(" + plan.path("status").asText() + ")")
                .toList();
        if (lockingPlans.isEmpty()) {
            return null;
        }
        return "机台 " + equipment + "@" + planDate + " 已有 "
                + String.join("、", lockingPlans);
    }

    private static ObjectNode inputSchema(ObjectMapper mapper) {
        ObjectNode schema = mapper.createObjectNode();
        schema.put("type", "object");
        schema.put("additionalProperties", false);
        ObjectNode properties = schema.putObject("properties");
        properties.putObject("schedule_record_no")
                .put("type", "string")
                .put(
                        "description",
                        "要发布的 APS 排程记录号；先用 query_mes_aps_demand_schedule 查到 feasible/accepted 状态的记录"
                );
        ObjectNode policy = properties.putObject("conflict_policy");
        policy.put("type", "string");
        policy.put(
                "description",
                "目标机台同日已有计划时的处理：block=遇锁定计划整单拒绝，append=跳过冲突行发布其余"
        );
        var choices = policy.putArray("enum");
        CONFLICT_POLICIES.stream().sorted().forEach(choices::add);
        schema.putArray("required")
                .add("schedule_record_no")
                .add("conflict_policy");
        return schema;
    }

    private static ObjectNode outputSchema(ObjectMapper mapper) {
        ObjectNode schema = mapper.createObjectNode();
        schema.put("type", "object");
        schema.put("additionalProperties", false);
        ObjectNode properties = schema.putObject("properties");
        properties.putObject("scheduleRecordNo")
                .put("type", "string")
                .put("description", "已发布的排程记录号");
        properties.putObject("alreadyPublished")
                .put("type", "boolean")
                .put(
                        "description",
                        "是否为幂等拦截（排程此前已发布，本次未重复写入）"
                );
        properties.putObject("publishedPlanNos")
                .put("type", "array")
                .put("description", "落库（或此前已发布）的生产计划号列表");
        properties.putObject("skippedConflicts")
                .put("type", "array")
                .put("description", "append 策略下被跳过的冲突行（机台@日期）");
        properties.putObject("demandNo")
                .put("type", "string")
                .put("description", "关联需求单号；无关联则为空串");
        properties.putObject("demandUpdated")
                .put("type", "boolean")
                .put("description", "关联需求是否由本次发布回写为 scheduled");
        properties.putObject("totalPlannedBatches")
                .put("type", "number")
                .put("description", "本次落库计划的计划量合计");
        properties.putObject("totalPlannedWeight")
                .put("type", "number")
                .put("description", "本次落库计划的计划重量合计");
        schema.putArray("required")
                .add("scheduleRecordNo")
                .add("alreadyPublished")
                .add("publishedPlanNos")
                .add("skippedConflicts")
                .add("demandNo")
                .add("demandUpdated")
                .add("totalPlannedBatches")
                .add("totalPlannedWeight");
        return schema;
    }
}
