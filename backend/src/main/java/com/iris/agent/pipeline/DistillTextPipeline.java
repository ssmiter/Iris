package com.iris.agent.pipeline;

import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.node.ObjectNode;
import org.springframework.stereotype.Component;

import java.util.List;

/** Button/system primitive for turning selected text into a concise durable result. */
@Component
public class DistillTextPipeline implements PipelineDefinitionProvider {
    private final ObjectMapper objectMapper;

    public DistillTextPipeline(ObjectMapper objectMapper) {
        this.objectMapper = objectMapper;
    }

    @Override
    public PipelineDefinition definition() {
        ObjectNode input = objectMapper.createObjectNode();
        input.put("type", "object");
        input.put("additionalProperties", false);
        ObjectNode properties = input.putObject("properties");
        properties.putObject("text")
                .put("type", "string")
                .put("description", "由按钮、右键选区或系统事实提供的原始文本")
                .put("minLength", 1)
                .put("maxLength", 40_000);
        input.putArray("required").add("text");

        ObjectNode output = objectMapper.createObjectNode();
        output.put("type", "object");
        output.put("additionalProperties", true);
        ObjectNode outputProperties = output.putObject("properties");
        outputProperties.putObject("runId").put("type", "string")
                .put("description", "执行一次模型变换的隔离 Run id");
        outputProperties.putObject("summary").put("type", "string")
                .put("description", "忠于来源且可继续使用的精炼文本");

        return new PipelineDefinition(
                "iris.pipeline.distill_text",
                "1",
                "distill_text",
                "/system/pipelines/distill_text",
                "把已选中的一段文本一次性精炼为忠于来源、可继续编辑或交给后续 Pipeline 的短文本；不使用工具，也不把结果自动发布成记忆或 Skill",
                input,
                output,
                90_000,
                PipelineDefinition.DeliveryPolicy.NOTIFY_PARENT,
                List.of(new PipelineDefinition.ModelTransformStep(
                        "distill",
                        "只根据给定原文提炼关键信息。保留明确事实、约束、决定和未决项；删除重复、口头填充和无信息量表述。不要补充原文没有的事实，直接输出精炼正文。",
                        "input:/text",
                        "输出一段可独立阅读的精炼正文；不得声称完成原文未证明的动作。",
                        90_000
                ))
        );
    }
}
