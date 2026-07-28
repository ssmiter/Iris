package com.iris.tools.system.context;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.node.ObjectNode;
import com.iris.tools.core.CommittedOperation;
import com.iris.tools.core.PreparedOperation;
import com.iris.tools.core.RiskLevel;
import com.iris.tools.core.Tool;
import com.iris.tools.core.ToolContext;
import com.iris.tools.core.ToolManifest;
import com.iris.tools.core.ToolOutcome;
import com.iris.tools.core.ToolOutputPayloadService;
import com.iris.tools.core.ToolOutputPayloadService.OutputWindow;
import com.iris.tools.core.ToolRuntimeException;
import com.iris.tools.core.VerificationResult;
import org.springframework.stereotype.Component;

import java.time.Instant;
import java.util.List;

/**
 * 读取同一对话内已持久化的完整 Tool output。
 * package 自动形成 /system/context/read_tool_result。
 */
@Component
public class ReadToolResultTool implements Tool {

    private static final int DEFAULT_CHARACTER_COUNT = 20_000;
    private static final int MAX_CHARACTER_COUNT = 50_000;

    private final ObjectMapper objectMapper;
    private final ToolOutputPayloadService outputs;
    private final ToolManifest manifest;

    public ReadToolResultTool(
            ObjectMapper objectMapper,
            ToolOutputPayloadService outputs
    ) {
        this.objectMapper = objectMapper;
        this.outputs = outputs;
        this.manifest = new ToolManifest(
                "iris.system.context.read_tool_result",
                "2",
                "read_tool_result",
                "按窗口读回同一对话中被截断的完整工具结果；Observation 给出 tool-result 引用时使用",
                inputSchema(),
                outputSchema(),
                RiskLevel.READ_ONLY,
                ToolManifest.SideEffect.NONE,
                10,
                60_000,
                ToolManifest.IdempotencySemantics.IDEMPOTENT,
                ToolManifest.EvidencePolicy.SUMMARY,
                ToolManifest.ContextRetention.REFETCHABLE,
                ToolManifest.ConcurrencySemantics.PARALLEL_SAFE,
                ToolManifest.CancellationSemantics.COOPERATIVE
        );
    }

    @Override
    public ToolManifest manifest() {
        return manifest;
    }

    @Override
    public PreparedOperation prepare(JsonNode input, ToolContext context) {
        String executionId = input.path("execution_id").asText();
        if (executionId.isBlank()) {
            throw new ToolRuntimeException(
                    "invalid_tool_input",
                    "参数 execution_id 不能为空"
            );
        }
        int start = input.path("start_character").asInt(0);
        int count = input.path("character_count")
                .asInt(DEFAULT_CHARACTER_COUNT);
        if (start < 0) {
            throw new ToolRuntimeException(
                    "invalid_tool_input",
                    "start_character 不能小于 0"
            );
        }
        if (count < 1 || count > MAX_CHARACTER_COUNT) {
            throw new ToolRuntimeException(
                    "invalid_tool_input",
                    "character_count 必须在 1 到 "
                            + MAX_CHARACTER_COUNT + " 之间"
            );
        }
        ObjectNode normalized = objectMapper.createObjectNode();
        normalized.put("execution_id", executionId);
        normalized.put("start_character", start);
        normalized.put("character_count", count);
        return new PreparedOperation(
                normalized,
                "读回工具结果 " + executionId + " 的字符窗口，"
                        + "不改变任何外部状态",
                List.of(),
                Instant.now().plusSeconds(60)
        );
    }

    @Override
    public ToolOutcome execute(
            CommittedOperation operation,
            ToolContext context
    ) {
        JsonNode input = operation.normalizedInput();
        String executionId = input.path("execution_id").asText();
        int start = input.path("start_character").asInt();
        int requested = input.path("character_count").asInt();
        OutputWindow payload = outputs.findWindow(
                context.conversationId(),
                executionId,
                start,
                requested
        ).orElse(null);
        if (payload == null) {
            return ToolOutcome.failed(
                    "tool_result_not_found",
                    "当前对话中没有这条完整工具结果；请核对 execution_id"
            );
        }
        if (start >= payload.totalCharacters()
                && payload.totalCharacters() > 0) {
            return ToolOutcome.failed(
                    "tool_result_window_out_of_range",
                    "起点 " + start + " 超过结果长度 "
                            + payload.totalCharacters()
            );
        }
        String content = payload.content() == null ? "" : payload.content();
        int end = start + content.length();
        ObjectNode output = objectMapper.createObjectNode();
        output.put("executionId", executionId);
        output.put("format", "json");
        output.put("contentHash", payload.contentHash());
        output.put("totalCharacters", payload.totalCharacters());
        output.put("startCharacter", start);
        output.put("endCharacterExclusive", end);
        output.put("content", content);
        boolean truncated = end < payload.totalCharacters();
        output.put("truncated", truncated);
        if (truncated) {
            output.put("nextStartCharacter", end);
            output.put(
                    "guidance",
                    "仍有后文；继续读取时把 start_character 设为 " + end
            );
        } else {
            output.putNull("nextStartCharacter");
            output.put("guidance", "已到达完整工具结果末尾");
        }
        return ToolOutcome.succeeded(output);
    }

    @Override
    public VerificationResult verify(
            ToolOutcome outcome,
            CommittedOperation operation,
            ToolContext context
    ) {
        String executionId = operation.normalizedInput()
                .path("execution_id").asText();
        return VerificationResult.confirmed(List.of(
                new VerificationResult.Evidence(
                        "tool_output_payload",
                        executionId,
                        "已从同一对话的规范结果存储读取字符窗口"
                )
        ));
    }

    private JsonNode inputSchema() {
        ObjectNode schema = objectMapper.createObjectNode();
        schema.put("type", "object");
        schema.put("additionalProperties", false);
        ObjectNode properties = schema.putObject("properties");
        properties.putObject("execution_id").put("type", "string")
                .put("description", "tool-result 引用中的 execution ID");
        properties.putObject("start_character").put("type", "integer")
                .put("minimum", 0)
                .put("description", "字符窗口起点，0-based；默认 0");
        properties.putObject("character_count").put("type", "integer")
                .put("minimum", 1).put("maximum", MAX_CHARACTER_COUNT)
                .put("description", "最多读取字符数；默认 20000，上限 50000");
        schema.putArray("required").add("execution_id");
        return schema;
    }

    private JsonNode outputSchema() {
        ObjectNode schema = objectMapper.createObjectNode();
        schema.put("type", "object");
        schema.put("additionalProperties", false);
        ObjectNode properties = schema.putObject("properties");
        properties.putObject("executionId").put("type", "string")
                .put("description", "结果所属 ToolExecution");
        properties.putObject("format").put("type", "string")
                .put("description", "规范 payload 格式，首版固定为 json");
        properties.putObject("contentHash").put("type", "string")
                .put("description", "完整 payload 的 SHA-256");
        properties.putObject("totalCharacters").put("type", "integer")
                .put("description", "完整 payload 的字符数");
        properties.putObject("startCharacter").put("type", "integer")
                .put("description", "本窗口实际起点");
        properties.putObject("endCharacterExclusive").put("type", "integer")
                .put("description", "本窗口末尾的独占字符位置");
        properties.putObject("content").put("type", "string")
                .put("description", "JSON payload 的当前字符窗口");
        properties.putObject("truncated").put("type", "boolean")
                .put("description", "当前窗口之后是否仍有内容");
        properties.putObject("nextStartCharacter").put("type", "integer")
                .put("description", "下一窗口起点；已读完时为 null");
        properties.putObject("guidance").put("type", "string")
                .put("description", "继续读取或已完成提示");
        schema.putArray("required")
                .add("executionId").add("format").add("contentHash")
                .add("totalCharacters").add("startCharacter")
                .add("endCharacterExclusive").add("content")
                .add("truncated").add("guidance");
        return schema;
    }
}
