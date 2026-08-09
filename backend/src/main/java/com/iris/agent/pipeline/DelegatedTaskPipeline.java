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
        input.putObject("properties")
                .putObject("task")
                .put("type", "string")
                .put("description", "交给隔离子 Agent 的自包含任务")
                .put("minLength", 1)
                .put("maxLength", 12_000);
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

        return new PipelineDefinition(
                "iris.pipeline.delegated_task",
                "1",
                "delegated_task",
                "/system/agents/delegated_task",
                "把一个可独立完成的明确子目标交给隔离的 Agentic child Run；适合并行探索、资料整理和不依赖父级隐式上下文的工作",
                input,
                output,
                600_000,
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
