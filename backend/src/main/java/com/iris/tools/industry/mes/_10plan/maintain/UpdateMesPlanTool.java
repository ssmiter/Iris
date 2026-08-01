package com.iris.tools.industry.mes._10plan.maintain;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.node.ObjectNode;
import com.iris.industry.demo.IndustrialDemoRepository;
import com.iris.tools.core.CommittedOperation;
import com.iris.tools.core.PreparedOperation;
import com.iris.tools.core.PreparedOperation.ResourceClaim;
import com.iris.tools.core.ToolContext;
import com.iris.tools.core.ToolOutcome;
import com.iris.tools.core.VerificationResult;
import com.iris.tools.industry.mes.AbstractMesWriteTool;
import org.springframework.stereotype.Component;

import java.time.Instant;
import java.util.List;
import java.util.Set;

/**
 * 维护生产计划：下达（scheduled→running）、取消（scheduled→cancelled）、
 * 调整优先级（docs/27 §5.3）。
 *
 * <p>锁定规则：已有完成量（completed_batches &gt; 0）的计划不可取消、
 * 不可调整，守护条件在 SQL 层兜底（status = expected AND
 * completed_batches = 0），守护不过返回 0 即抛冲突。</p>
 */
@Component
public class UpdateMesPlanTool extends AbstractMesWriteTool {
    private static final Set<String> ACTIONS = Set.of(
            "start",
            "cancel",
            "set_priority"
    );
    private static final Set<String> PRIORITIES = Set.of(
            "high",
            "normal"
    );

    public UpdateMesPlanTool(
            ObjectMapper objectMapper,
            IndustrialDemoRepository repository
    ) {
        super(
                objectMapper,
                repository,
                writeManifest(
                        "iris.industry.mes.update_plan",
                        "update_mes_plan",
                        "维护 MES 域生产计划：start=下达（scheduled→running）、cancel=取消（scheduled→cancelled）、set_priority=调整优先级；已有完成量的计划按锁定规则拒绝；计划状态调整时使用",
                        inputSchema(objectMapper),
                        outputSchema(objectMapper)
                )
        );
    }

    @Override
    public PreparedOperation prepare(JsonNode input, ToolContext context) {
        String planNo = requireText(input, "plan_no", 60);
        String action = requireEnum(input, "action", ACTIONS);
        ObjectNode plan = repository.findPlan(domain(), planNo);
        if (plan == null) {
            throw invalid("计划不存在：" + planNo);
        }
        String status = plan.path("status").asText();
        double completed = plan.path("completedBatches").asDouble();
        if (!"scheduled".equals(status)) {
            throw invalid(
                    "计划状态为 " + status
                            + "，只有 scheduled 状态可以下达、取消或调整"
            );
        }
        if (completed > 0) {
            throw invalid(
                    "计划已有完成量 " + completed
                            + "，按锁定规则不可取消或调整"
            );
        }
        String priority = plan.path("priority").asText();
        if ("set_priority".equals(action)) {
            priority = requireEnum(input, "priority", PRIORITIES);
        }
        ObjectNode normalized = objectMapper.createObjectNode();
        normalized.put("plan_no", planNo);
        normalized.put("action", action);
        normalized.put("priority", priority);
        String impact = switch (action) {
            case "start" -> "将下达计划 " + planNo
                    + "（scheduled→running），机台 "
                    + plan.path("equipmentCode").asText() + " 于 "
                    + plan.path("planDate").asText() + " 开始执行";
            case "cancel" -> "将取消计划 " + planNo
                    + "（scheduled→cancelled），释放机台 "
                    + plan.path("equipmentCode").asText() + " 于 "
                    + plan.path("planDate").asText() + " 的产能";
            default -> "将把计划 " + planNo + " 的优先级从 "
                    + plan.path("priority").asText() + " 调整为 "
                    + priority;
        };
        return new PreparedOperation(
                normalized,
                impact,
                List.of(new ResourceClaim(
                        "industrial_demo_plan",
                        planNo,
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
        JsonNode normalized = operation.normalizedInput();
        String planNo = normalized.path("plan_no").asText();
        String action = normalized.path("action").asText();
        checkCancelled(context, "任务已停止，计划尚未变更");
        ObjectNode plan = repository.findPlan(domain(), planNo);
        if (plan == null) {
            throw conflict("计划在审批期间被移除");
        }
        String status = plan.path("status").asText();
        String newStatus = switch (action) {
            case "start" -> "running";
            case "cancel" -> "cancelled";
            default -> status;
        };
        String priority = "set_priority".equals(action)
                ? normalized.path("priority").asText()
                : plan.path("priority").asText();
        int updated = repository.updatePlanState(
                domain(),
                planNo,
                status,
                newStatus,
                priority,
                now()
        );
        if (updated == 0) {
            throw conflict(
                    "计划状态已变化或已有完成量，操作被锁定规则拒绝"
            );
        }
        ObjectNode output = objectMapper.createObjectNode();
        output.put("planNo", planNo);
        output.put("action", action);
        output.put("previousStatus", status);
        output.put("newStatus", newStatus);
        output.put("priority", priority);
        return ToolOutcome.succeeded(output);
    }

    @Override
    public VerificationResult verify(
            ToolOutcome outcome,
            CommittedOperation operation,
            ToolContext context
    ) {
        String planNo = outcome.output().path("planNo").asText();
        ObjectNode plan = repository.findPlan(domain(), planNo);
        if (plan == null
                || !outcome.output()
                        .path("newStatus")
                        .asText()
                        .equals(plan.path("status").asText())
                || !outcome.output()
                        .path("priority")
                        .asText()
                        .equals(plan.path("priority").asText())) {
            return new VerificationResult(
                    VerificationResult.Status.UNKNOWN,
                    List.of(),
                    "计划维护已返回，但最新状态无法确认"
            );
        }
        return VerificationResult.confirmed(List.of(
                new VerificationResult.Evidence(
                        "industrial_demo_plan",
                        planNo,
                        "计划状态 " + plan.path("status").asText()
                                + "，优先级 "
                                + plan.path("priority").asText()
                )
        ));
    }

    private static ObjectNode inputSchema(ObjectMapper mapper) {
        ObjectNode schema = mapper.createObjectNode();
        schema.put("type", "object");
        schema.put("additionalProperties", false);
        ObjectNode properties = schema.putObject("properties");
        properties.putObject("plan_no")
                .put("type", "string")
                .put(
                        "description",
                        "目标生产计划号；先用 query_mes_mixing_plans 等查到 scheduled 状态的计划"
                );
        ObjectNode action = properties.putObject("action");
        action.put("type", "string");
        action.put(
                "description",
                "操作：start=下达（scheduled→running），cancel=取消（scheduled→cancelled），set_priority=调整优先级"
        );
        var actionChoices = action.putArray("enum");
        ACTIONS.stream().sorted().forEach(actionChoices::add);
        ObjectNode priority = properties.putObject("priority");
        priority.put("type", "string");
        priority.put(
                "description",
                "新优先级；仅 action=set_priority 时必填"
        );
        var priorityChoices = priority.putArray("enum");
        PRIORITIES.stream().sorted().forEach(priorityChoices::add);
        schema.putArray("required").add("plan_no").add("action");
        return schema;
    }

    private static ObjectNode outputSchema(ObjectMapper mapper) {
        ObjectNode schema = mapper.createObjectNode();
        schema.put("type", "object");
        schema.put("additionalProperties", false);
        ObjectNode properties = schema.putObject("properties");
        properties.putObject("planNo")
                .put("type", "string")
                .put("description", "被维护的计划号");
        properties.putObject("action")
                .put("type", "string")
                .put("description", "实际执行的操作");
        properties.putObject("previousStatus")
                .put("type", "string")
                .put("description", "操作前状态");
        properties.putObject("newStatus")
                .put("type", "string")
                .put("description", "操作后状态");
        properties.putObject("priority")
                .put("type", "string")
                .put("description", "操作后优先级");
        schema.putArray("required")
                .add("planNo")
                .add("action")
                .add("previousStatus")
                .add("newStatus")
                .add("priority");
        return schema;
    }
}
