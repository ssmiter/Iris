package com.iris.agent.pipeline;

import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.node.ObjectNode;
import org.springframework.stereotype.Component;

import java.util.List;

/** First real Pipeline: one bounded child Agentic segment. */
@Component
public class DelegatedTaskPipeline implements PipelineDefinitionProvider {
    private final ObjectMapper objectMapper;

    public DelegatedTaskPipeline(ObjectMapper objectMapper) {
        this.objectMapper = objectMapper;
    }

    @Override
    public PipelineDefinition definition() {
        ObjectNode input = objectMapper.createObjectNode();
        input.put("type", "object");
        input.put("additionalProperties", false);
        ObjectNode inputProperties = input.putObject("properties");
        inputProperties.putObject("task")
                .put("type", "string")
                .put("description", "交给隔离子 Agent 的自包含任务")
                .put("minLength", 1)
                .put("maxLength", 12_000);
        inputProperties.putObject("context")
                .put("type", "string")
                .put("description", "完成判断必需的背景、已排除方向和稳定引用；不复制整段父对话")
                .put("maxLength", 8_000);
        inputProperties.putObject("deliverable")
                .put("type", "string")
                .put("description", "期望交付物与验收标准；省略时返回有界结论、证据和未决项")
                .put("maxLength", 4_000);
        inputProperties.putObject("constraints")
                .put("type", "array")
                .put("description", "子任务必须遵守的职责边界和限制")
                .put("maxItems", 12)
                .putObject("items")
                .put("type", "string")
                .put("minLength", 1)
                .put("maxLength", 1_000);
        inputProperties.putObject("work_mode")
                .put("type", "string")
                .put("description", "observe 只能观察；workspace 才可在工作区内产生变更")
                .putArray("enum")
                .add("observe")
                .add("workspace");
        input.putArray("required").add("task");

        ObjectNode output = objectMapper.createObjectNode();
        output.put("type", "object");
        output.put("additionalProperties", true);
        ObjectNode outputProperties = output.putObject("properties");
        outputProperties.putObject("runId")
                .put("type", "string")
                .put("description", "实际执行任务的 child Run id");
        outputProperties.putObject("summary")
                .put("type", "string")
                .put("description", "子 Agent 的有界最终结论");
        outputProperties.putObject("status")
                .put("type", "string")
                .put("description", "子 Agent 的终态");
        outputProperties.putObject("outputRef")
                .put("type", "string")
                .put("description", "需要继续读取时使用的稳定结果引用");
        outputProperties.putObject("evidenceRefs")
                .put("type", "array")
                .put("description", "从真实工具验证事实汇集的证据引用")
                .putObject("items")
                .put("type", "string");

        return new PipelineDefinition(
                "iris.pipeline.delegated_task",
                "2",
                "delegated_task",
                "/system/agents/delegated_task",
                "把一个可独立完成的明确子目标交给隔离的 Agentic child Run；适合并行探索、资料整理和不依赖父级隐式上下文的工作",
                input,
                output,
                600_000,
                PipelineDefinition.DeliveryPolicy.NOTIFY_PARENT,
                List.of(new PipelineDefinition.ChildAgentStep(
                        "perform_task",
                        "input:/task",
                        "返回简洁结论、关键证据或 Artifact/Workspace 引用；未完成项与风险必须明确说明。",
                        List.of(),
                        20,
                        600_000
                ))
        );
    }
}
