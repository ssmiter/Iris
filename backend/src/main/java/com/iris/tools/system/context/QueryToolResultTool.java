package com.iris.tools.system.context;

import com.fasterxml.jackson.core.JsonPointer;
import com.fasterxml.jackson.core.JsonProcessingException;
import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.node.ArrayNode;
import com.fasterxml.jackson.databind.node.ObjectNode;
import com.iris.tools.core.CommittedOperation;
import com.iris.tools.core.PreparedOperation;
import com.iris.tools.core.RiskLevel;
import com.iris.tools.core.Tool;
import com.iris.tools.core.ToolContext;
import com.iris.tools.core.ToolManifest;
import com.iris.tools.core.ToolOutcome;
import com.iris.tools.core.ToolOutputPayloadService;
import com.iris.tools.core.ToolOutputPayloadService.JsonPayload;
import com.iris.tools.core.ToolRuntimeException;
import com.iris.tools.core.VerificationResult;
import org.springframework.stereotype.Component;

import java.time.Instant;
import java.util.Iterator;
import java.util.List;
import java.util.Map;

/**
 * 从同一对话的规范 JSON Tool output 中选择并分页一个节点。
 */
@Component
public class QueryToolResultTool implements Tool {

    private static final long MAX_JSON_BYTES = 16L * 1024 * 1024;
    private static final int DEFAULT_LIMIT = 100;
    private static final int MAX_LIMIT = 500;

    private final ObjectMapper objectMapper;
    private final ToolOutputPayloadService outputs;
    private final ToolManifest manifest;

    public QueryToolResultTool(
            ObjectMapper objectMapper,
            ToolOutputPayloadService outputs
    ) {
        this.objectMapper = objectMapper;
        this.outputs = outputs;
        this.manifest = new ToolManifest(
                "iris.system.context.query_tool_result",
                "1",
                "query_tool_result",
                "按 JSON Pointer 精确读取并分页同一对话中的完整工具结果；只需要大结果的一部分字段或条目时使用",
                inputSchema(),
                outputSchema(),
                RiskLevel.READ_ONLY,
                ToolManifest.SideEffect.NONE,
                15,
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
        String pointer = input.path("pointer").asText("");
        requirePointer(pointer);
        int offset = input.path("offset").asInt(0);
        int limit = input.path("limit").asInt(DEFAULT_LIMIT);
        if (offset < 0) {
            throw new ToolRuntimeException(
                    "invalid_tool_input",
                    "offset 不能小于 0"
            );
        }
        if (limit < 1 || limit > MAX_LIMIT) {
            throw new ToolRuntimeException(
                    "invalid_tool_input",
                    "limit 必须在 1 到 " + MAX_LIMIT + " 之间"
            );
        }
        ObjectNode normalized = objectMapper.createObjectNode();
        normalized.put("execution_id", executionId);
        normalized.put("pointer", pointer);
        normalized.put("offset", offset);
        normalized.put("limit", limit);
        return new PreparedOperation(
                normalized,
                "读取工具结果 " + executionId
                        + " 的 JSON 节点 " + (pointer.isEmpty() ? "/" : pointer)
                        + "，不改变任何外部状态",
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
        String pointer = input.path("pointer").asText();
        int offset = input.path("offset").asInt();
        int limit = input.path("limit").asInt();
        JsonPayload payload = outputs.findJson(
                context.conversationId(),
                executionId,
                MAX_JSON_BYTES
        ).orElse(null);
        if (payload == null) {
            return ToolOutcome.failed(
                    "tool_result_not_found",
                    "当前对话中没有这条完整工具结果；请核对 execution_id"
            );
        }
        if (context.cancelled()) {
            throw new ToolRuntimeException(
                    "tool_cancelled",
                    "结构化结果读取已停止"
            );
        }

        JsonNode root;
        try {
            root = objectMapper.readTree(payload.content());
        } catch (JsonProcessingException exception) {
            throw new IllegalStateException(
                    "规范 Tool output 不是合法 JSON",
                    exception
            );
        }
        JsonNode selected = root.at(JsonPointer.compile(pointer));
        if (selected.isMissingNode()) {
            return ToolOutcome.failed(
                    "tool_result_json_pointer_not_found",
                    "JSON Pointer 未找到节点：" + pointer
            );
        }
        Projection projection = project(selected, offset, limit);

        ObjectNode output = objectMapper.createObjectNode();
        output.put("executionId", executionId);
        output.put("contentHash", payload.contentHash());
        output.put("pointer", pointer);
        output.put("nodeType", selected.getNodeType().name().toLowerCase());
        output.put("totalItems", projection.totalItems());
        output.put("offset", projection.offset());
        output.put("returnedItems", projection.returnedItems());
        output.set("value", projection.value());
        output.put("truncated", projection.truncated());
        if (projection.nextOffset() == null) {
            output.putNull("nextOffset");
            output.put("guidance", "所选节点已完整返回");
        } else {
            output.put("nextOffset", projection.nextOffset());
            output.put(
                    "guidance",
                    "仍有条目；继续读取时把 offset 设为 "
                            + projection.nextOffset()
            );
        }
        return ToolOutcome.succeeded(output);
    }

    @Override
    public VerificationResult verify(
            ToolOutcome outcome,
            CommittedOperation operation,
            ToolContext context
    ) {
        return VerificationResult.confirmed(List.of(
                new VerificationResult.Evidence(
                        "tool_output_json_pointer",
                        operation.normalizedInput()
                                .path("execution_id").asText(),
                        "已从同一对话的规范 JSON payload 选择节点"
                )
        ));
    }

    private Projection project(JsonNode selected, int offset, int limit) {
        if (selected.isArray()) {
            int total = selected.size();
            requireOffset(offset, total);
            ArrayNode value = objectMapper.createArrayNode();
            int end = Math.min(total, offset + limit);
            for (int index = offset; index < end; index++) {
                value.add(selected.get(index));
            }
            return new Projection(
                    value,
                    total,
                    offset,
                    value.size(),
                    end < total,
                    end < total ? end : null
            );
        }
        if (selected.isObject()) {
            int total = selected.size();
            requireOffset(offset, total);
            ObjectNode value = objectMapper.createObjectNode();
            Iterator<Map.Entry<String, JsonNode>> fields =
                    selected.fields();
            int index = 0;
            int returned = 0;
            while (fields.hasNext() && returned < limit) {
                Map.Entry<String, JsonNode> field = fields.next();
                if (index++ < offset) {
                    continue;
                }
                value.set(field.getKey(), field.getValue());
                returned++;
            }
            int end = offset + returned;
            return new Projection(
                    value,
                    total,
                    offset,
                    returned,
                    end < total,
                    end < total ? end : null
            );
        }
        if (offset != 0) {
            throw new ToolRuntimeException(
                    "tool_result_scalar_offset_invalid",
                    "标量 JSON 节点只允许 offset=0"
            );
        }
        return new Projection(
                selected,
                1,
                0,
                1,
                false,
                null
        );
    }

    private void requireOffset(int offset, int total) {
        if (offset > total || (offset == total && total > 0)) {
            throw new ToolRuntimeException(
                    "tool_result_json_offset_out_of_range",
                    "offset " + offset + " 超过节点条目数 " + total
            );
        }
    }

    private void requirePointer(String pointer) {
        if (!pointer.isEmpty() && !pointer.startsWith("/")) {
            throw new ToolRuntimeException(
                    "invalid_tool_result_json_pointer",
                    "JSON Pointer 必须为空或以 / 开头"
            );
        }
        try {
            JsonPointer.compile(pointer);
        } catch (IllegalArgumentException exception) {
            throw new ToolRuntimeException(
                    "invalid_tool_result_json_pointer",
                    "JSON Pointer 格式无效：" + exception.getMessage()
            );
        }
    }

    private JsonNode inputSchema() {
        ObjectNode schema = objectMapper.createObjectNode();
        schema.put("type", "object");
        schema.put("additionalProperties", false);
        ObjectNode properties = schema.putObject("properties");
        properties.putObject("execution_id").put("type", "string")
                .put("description", "tool-result 引用中的 execution ID");
        properties.putObject("pointer").put("type", "string")
                .put("description", "RFC 6901 JSON Pointer；空字符串选择根节点");
        properties.putObject("offset").put("type", "integer")
                .put("minimum", 0)
                .put("description", "数组条目或对象字段的起始偏移；默认 0");
        properties.putObject("limit").put("type", "integer")
                .put("minimum", 1).put("maximum", MAX_LIMIT)
                .put("description", "最多返回的数组条目或对象字段数；默认 100");
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
        properties.putObject("contentHash").put("type", "string")
                .put("description", "完整规范 payload 的 SHA-256");
        properties.putObject("pointer").put("type", "string")
                .put("description", "实际选择的 JSON Pointer");
        properties.putObject("nodeType").put("type", "string")
                .put("description", "所选节点的 JSON 类型");
        properties.putObject("totalItems").put("type", "integer")
                .put("description", "数组条目数、对象字段数或标量的 1");
        properties.putObject("offset").put("type", "integer")
                .put("description", "本页起始偏移");
        properties.putObject("returnedItems").put("type", "integer")
                .put("description", "本页返回数量");
        properties.putObject("value")
                .put("description", "选择并按需分页后的 JSON 值");
        properties.putObject("truncated").put("type", "boolean")
                .put("description", "所选节点是否仍有后续条目");
        properties.putObject("nextOffset").put("type", "integer")
                .put("description", "下一页 offset；已完成时为 null");
        properties.putObject("guidance").put("type", "string")
                .put("description", "继续读取或已完成提示");
        schema.putArray("required")
                .add("executionId").add("contentHash").add("pointer")
                .add("nodeType").add("totalItems").add("offset")
                .add("returnedItems").add("value").add("truncated")
                .add("guidance");
        return schema;
    }

    private record Projection(
            JsonNode value,
            int totalItems,
            int offset,
            int returnedItems,
            boolean truncated,
            Integer nextOffset
    ) {
    }
}
