package com.weave.tools.life.notes;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.node.ObjectNode;
import com.weave.tools.core.RiskLevel;
import com.weave.tools.core.Tool;
import com.weave.tools.core.ToolContext;
import com.weave.tools.core.ToolResult;
import org.springframework.stereotype.Component;

import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.StandardOpenOption;

/**
 * 示例工具：向工作区笔记追加一行。
 * 演示契约要点：schema、风险等级、人话 impact、路径围栏（正式实现应复用 workspace 模块的围栏工具方法）。
 */
@Component
public class AppendNoteTool implements Tool {

    private static final ObjectMapper MAPPER = new ObjectMapper();

    @Override
    public String name() {
        return "append_note";
    }

    @Override
    public String description() {
        return "向工作区中的笔记文件追加一行文本；需要记录想法、待办、账本等持续累积的信息时使用";
    }

    @Override
    public RiskLevel riskLevel() {
        return RiskLevel.ELEVATED; // 写文件 → 审批
    }

    @Override
    public JsonNode parametersSchema() {
        ObjectNode schema = MAPPER.createObjectNode();
        schema.put("type", "object");
        ObjectNode props = schema.putObject("properties");
        props.putObject("path").put("type", "string").put("description", "工作区内相对路径，如 notes/todo.md");
        props.putObject("line").put("type", "string").put("description", "要追加的一行文本");
        schema.putArray("required").add("path").add("line");
        return schema;
    }

    @Override
    public String describeImpact(JsonNode args) {
        return "将向 " + args.path("path").asText("?") + " 追加一行内容";
    }

    @Override
    public ToolResult execute(JsonNode args, ToolContext ctx) throws IOException {
        Path root = ctx.workspaceRoot().toRealPath();
        Path target = root.resolve(args.path("path").asText()).normalize().toRealPath();
        if (!target.startsWith(root)) {
            return ToolResult.error("路径越界：只能操作工作区内文件，请使用工作区相对路径");
        }
        Files.createDirectories(target.getParent());
        Files.writeString(target, args.path("line").asText() + "\n",
                StandardCharsets.UTF_8, StandardOpenOption.CREATE, StandardOpenOption.APPEND);
        return ToolResult.ok("已追加到 " + root.relativize(target));
    }
}
