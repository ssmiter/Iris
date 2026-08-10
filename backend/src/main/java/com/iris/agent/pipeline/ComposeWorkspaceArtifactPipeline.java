package com.iris.agent.pipeline;

import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.node.ObjectNode;
import com.iris.tools.core.ToolRegistry;
import com.iris.tools.system.artifacts.PresentArtifactTool;
import com.iris.tools.system.files.WriteFileTool;
import org.springframework.stereotype.Component;

import java.util.List;

/** Model composition -> approved workspace write -> user-facing Artifact. */
@Component
public class ComposeWorkspaceArtifactPipeline
        implements PipelineDefinitionProvider {
    private final ObjectMapper objectMapper;
    private final ToolRegistry.ToolBinding writeFile;
    private final ToolRegistry.ToolBinding presentArtifact;

    public ComposeWorkspaceArtifactPipeline(
            ObjectMapper objectMapper,
            WriteFileTool writeFile,
            PresentArtifactTool presentArtifact
    ) {
        this.objectMapper = objectMapper;
        this.writeFile = ToolRegistry.describe(writeFile, objectMapper);
        this.presentArtifact = ToolRegistry.describe(
                presentArtifact,
                objectMapper
        );
    }

    @Override
    public PipelineDefinition definition() {
        ObjectNode input = objectMapper.createObjectNode();
        input.put("type", "object");
        input.put("additionalProperties", false);
        ObjectNode properties = input.putObject("properties");
        properties.putObject("brief")
                .put("type", "string")
                .put("description", "成品的内容依据、用户要求与必须保留的约束")
                .put("minLength", 1)
                .put("maxLength", 80_000);
        properties.putObject("path")
                .put("type", "string")
                .put("description", "工作区内的 UTF-8 文本成品路径，例如 reports/result.md")
                .put("minLength", 1)
                .put("maxLength", 500);
        properties.putObject("caption")
                .put("type", "string")
                .put("description", "呈现给用户的一句话成果标题")
                .put("minLength", 1)
                .put("maxLength", 500);
        input.putArray("required").add("brief").add("path").add("caption");

        ObjectNode output = objectMapper.createObjectNode();
        output.put("type", "object");
        output.put("additionalProperties", true);
        ObjectNode outputProperties = output.putObject("properties");
        outputProperties.putObject("artifactId")
                .put("type", "string")
                .put("description", "已呈现 Artifact 的稳定 ID");
        outputProperties.putObject("artifactRef")
                .put("type", "string")
                .put("description", "可供后续对话读取的版本化 Artifact 引用");
        outputProperties.putObject("version")
                .put("type", "integer")
                .put("description", "不可变 Artifact 版本");
        outputProperties.putObject("visibility")
                .put("type", "array")
                .put("description", "成果当前可见范围")
                .putObject("items").put("type", "string");
        output.putArray("required")
                .add("artifactId").add("artifactRef")
                .add("version").add("visibility");

        ObjectNode writeInput = objectMapper.createObjectNode();
        writeInput.put("path", "input:/path");
        writeInput.put("content", "step:compose:/summary");
        ObjectNode presentInput = objectMapper.createObjectNode();
        presentInput.put("path", "input:/path");
        presentInput.put("caption", "input:/caption");

        return new PipelineDefinition(
                "iris.pipeline.compose_workspace_artifact",
                "1",
                "compose_workspace_artifact",
                "/system/pipelines/compose_workspace_artifact",
                "根据明确 brief 生成一个完整 UTF-8 文本成品，经工作区写入审批后冻结并呈现为 Artifact；适合 Markdown、HTML、JSON、CSV 等文本成果，不适合二进制文件",
                input,
                output,
                180_000,
                PipelineDefinition.DeliveryPolicy.NOTIFY_PARENT,
                List.of(
                        new PipelineDefinition.ModelTransformStep(
                                "compose",
                                "严格按照 brief 生成可直接保存的完整成品正文。保留事实、约束、链接和数据，不解释生成过程，不使用 Markdown 代码围栏包裹全文；目标格式由 brief 与目标路径共同约束。",
                                "input:/brief",
                                "只输出目标文件的完整 UTF-8 正文，不声称执行写入或发布动作。",
                                120_000
                        ),
                        new PipelineDefinition.ToolStep(
                                "write",
                                writeFile.manifest().name(),
                                writeFile.capabilityPath(),
                                writeFile.manifestHash(),
                                writeInput
                        ),
                        new PipelineDefinition.ToolStep(
                                "present",
                                presentArtifact.manifest().name(),
                                presentArtifact.capabilityPath(),
                                presentArtifact.manifestHash(),
                                presentInput
                        )
                )
        );
    }
}
