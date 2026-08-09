package com.iris.agent.pipeline;

import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.node.ObjectNode;
import org.springframework.stereotype.Component;

import java.util.List;

/** System Pipeline: conversation facts -> short model title -> safe metadata publish. */
@Component
public class ConversationTitlePipeline implements PipelineDefinitionProvider {
    private final ObjectMapper objectMapper;

    public ConversationTitlePipeline(ObjectMapper objectMapper) {
        this.objectMapper = objectMapper;
    }

    @Override
    public PipelineDefinition definition() {
        ObjectNode input = objectMapper.createObjectNode();
        input.put("type", "object");
        input.put("additionalProperties", false);
        input.putObject("properties").putObject("text")
                .put("type", "string")
                .put("description", "首轮用户目标与回答摘要组成的标题依据")
                .put("minLength", 1)
                .put("maxLength", 12_000);
        input.putArray("required").add("text");

        ObjectNode output = objectMapper.createObjectNode();
        output.put("type", "object");
        output.put("additionalProperties", false);
        ObjectNode properties = output.putObject("properties");
        properties.putObject("title").put("type", "string");
        properties.putObject("published").put("type", "boolean");
        properties.putObject("summary").put("type", "string");
        properties.putObject("reason").put("type", "string");
        output.putArray("required")
                .add("title").add("published").add("summary").add("reason");

        return new PipelineDefinition(
                "iris.pipeline.conversation_title",
                "1",
                "conversation_title",
                "/system/pipelines/conversation_title",
                "根据首轮对话生成简短会话标题，并仅在用户尚未命名时发布为可见 metadata",
                input,
                output,
                90_000,
                PipelineDefinition.DeliveryPolicy.SILENT,
                List.of(
                        new PipelineDefinition.ModelTransformStep(
                                "generate_title",
                                "为这段对话生成一个准确、自然、便于稍后识别的短标题。使用主要对象和目标，不要写“关于”“用户想要”“对话”等套话；不要加引号、句号、Markdown 或解释；控制在 6 到 24 个中文字符或相当长度。",
                                "input:/text",
                                "只输出一行标题正文。",
                                60_000
                        ),
                        new PipelineDefinition.PublishConversationTitleStep(
                                "publish_title",
                                "step:generate_title:/summary"
                        )
                )
        );
    }
}
