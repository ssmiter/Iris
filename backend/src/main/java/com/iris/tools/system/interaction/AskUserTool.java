package com.iris.tools.system.interaction;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.node.ArrayNode;
import com.fasterxml.jackson.databind.node.ObjectNode;
import com.iris.tools.core.CommittedOperation;
import com.iris.tools.core.PreparedOperation;
import com.iris.tools.core.RiskLevel;
import com.iris.tools.core.ToolContext;
import com.iris.tools.core.ToolManifest;
import com.iris.tools.core.ToolOutcome;
import com.iris.tools.core.ToolRuntimeException;
import com.iris.tools.core.UserInputTool;
import com.iris.tools.core.VerificationResult;
import org.springframework.stereotype.Component;

import java.time.Instant;
import java.time.temporal.ChronoUnit;
import java.util.ArrayList;
import java.util.HashSet;
import java.util.List;
import java.util.Set;

/** Pauses the current ToolCall for one material user choice. */
@Component
public class AskUserTool implements UserInputTool {
    private static final int MAX_QUESTION_LENGTH = 500;
    private static final int MAX_OPTION_LENGTH = 160;

    private final ObjectMapper objectMapper;
    private final ToolManifest manifest;

    public AskUserTool(ObjectMapper objectMapper) {
        this.objectMapper = objectMapper;
        this.manifest = new ToolManifest(
                "iris.system.interaction.ask_user",
                "1",
                "ask_user",
                "当关键歧义会改变求解路径且无法通过客观观察消除时，向用户提出一个带 2 到 5 个选项的问题并暂停当前任务",
                inputSchema(),
                outputSchema(),
                RiskLevel.STANDARD,
                ToolManifest.SideEffect.INTERNAL_STATE,
                10,
                4_000,
                ToolManifest.IdempotencySemantics.IDEMPOTENT_WITH_KEY,
                ToolManifest.EvidencePolicy.REQUIRED,
                ToolManifest.ContextRetention.PINNED,
                ToolManifest.ConcurrencySemantics.SERIAL,
                ToolManifest.CancellationSemantics.COMMIT_BOUNDARY
        );
    }

    @Override
    public ToolManifest manifest() {
        return manifest;
    }

    @Override
    public PreparedOperation prepare(JsonNode input, ToolContext context) {
        String question = requiredText(
                input.path("question").asText(),
                "question",
                MAX_QUESTION_LENGTH
        );
        JsonNode optionsNode = input.path("options");
        if (!optionsNode.isArray()
                || optionsNode.size() < 2
                || optionsNode.size() > 5) {
            throw ToolRuntimeException.beforeCommit(
                    "invalid_user_input_options",
                    "options 必须包含 2 到 5 个互斥选项"
            );
        }
        ArrayNode options = objectMapper.createArrayNode();
        Set<String> unique = new HashSet<>();
        for (JsonNode item : optionsNode) {
            String label = requiredText(
                    item.asText(),
                    "option",
                    MAX_OPTION_LENGTH
            );
            if (!unique.add(label)) {
                throw ToolRuntimeException.beforeCommit(
                        "duplicate_user_input_option",
                        "ask_user 的选项不能重复"
                );
            }
            options.add(label);
        }
        int recommended = input.has("recommended_index")
                ? input.path("recommended_index").asInt(-1)
                : -1;
        if (recommended < -1 || recommended >= options.size()) {
            throw ToolRuntimeException.beforeCommit(
                    "invalid_recommended_option",
                    "recommended_index 必须指向一个现有选项"
            );
        }
        ObjectNode normalized = objectMapper.createObjectNode();
        normalized.put("question", question);
        normalized.set("options", options);
        if (recommended >= 0) {
            normalized.put("recommended_index", recommended);
        }
        return new PreparedOperation(
                normalized,
                question,
                List.of(new PreparedOperation.ResourceClaim(
                        "user_clarification",
                        context.runId(),
                        context.roundId()
                )),
                Instant.now().plus(1, ChronoUnit.DAYS)
        );
    }

    @Override
    public UserInputPrompt prompt(
            PreparedOperation operation,
            ToolContext context
    ) {
        JsonNode input = operation.normalizedInput();
        List<Option> options = new ArrayList<>();
        for (int index = 0; index < input.path("options").size(); index++) {
            options.add(new Option(
                    "option_" + (index + 1),
                    input.path("options").path(index).asText(),
                    null
            ));
        }
        int recommended = input.path("recommended_index").asInt(-1);
        return new UserInputPrompt(
                input.path("question").asText(),
                options,
                recommended >= 0 ? "option_" + (recommended + 1) : null
        );
    }

    @Override
    public ToolOutcome resolve(
            CommittedOperation operation,
            UserInputAnswer answer,
            ToolContext context
    ) {
        ObjectNode output = objectMapper.createObjectNode();
        output.put(
                "question",
                operation.normalizedInput().path("question").asText()
        );
        output.put("answer", answer.value());
        if (answer.optionId() != null) {
            output.put("optionId", answer.optionId());
        }
        output.put("inputRequestId", answer.inputRequestId());
        return ToolOutcome.succeeded(output);
    }

    @Override
    public VerificationResult verify(
            ToolOutcome outcome,
            CommittedOperation operation,
            ToolContext context
    ) {
        String answer = outcome.output().path("answer").asText("").trim();
        if (answer.isBlank()) {
            return new VerificationResult(
                    VerificationResult.Status.FAILED,
                    List.of(),
                    "用户响应为空"
            );
        }
        return VerificationResult.confirmed(List.of(
                new VerificationResult.Evidence(
                        "user_response",
                        outcome.output().path("inputRequestId").asText(),
                        "用户已回答：" + answer
                )
        ));
    }

    private JsonNode inputSchema() {
        ObjectNode schema = objectSchema();
        ObjectNode properties = schema.putObject("properties");
        properties.putObject("question")
                .put("type", "string")
                .put("description", "一个会实质改变后续路径的聚焦问题")
                .put("minLength", 1)
                .put("maxLength", MAX_QUESTION_LENGTH);
        ObjectNode options = properties.putObject("options");
        options.put("type", "array")
                .put("description", "2 到 5 个互斥且能直接作答的选项")
                .put("minItems", 2)
                .put("maxItems", 5)
                .put("uniqueItems", true);
        options.putObject("items")
                .put("type", "string")
                .put("minLength", 1)
                .put("maxLength", MAX_OPTION_LENGTH);
        properties.putObject("recommended_index")
                .put("type", "integer")
                .put("description", "可选：推荐选项的零基下标")
                .put("minimum", 0)
                .put("maximum", 4);
        schema.putArray("required").add("question").add("options");
        return schema;
    }

    private JsonNode outputSchema() {
        ObjectNode schema = objectSchema();
        ObjectNode properties = schema.putObject("properties");
        properties.putObject("question")
                .put("type", "string")
                .put("description", "原始澄清问题");
        properties.putObject("answer")
                .put("type", "string")
                .put("description", "用户最终选择的可读答案");
        properties.putObject("optionId")
                .put("type", "string")
                .put("description", "若命中预设选项，其稳定选项 ID");
        properties.putObject("inputRequestId")
                .put("type", "string")
                .put("description", "已持久化用户输入请求的稳定 ID");
        schema.putArray("required")
                .add("question").add("answer").add("inputRequestId");
        return schema;
    }

    private ObjectNode objectSchema() {
        ObjectNode schema = objectMapper.createObjectNode();
        schema.put("type", "object");
        schema.put("additionalProperties", false);
        return schema;
    }

    private String requiredText(String raw, String field, int maximum) {
        String value = raw == null ? "" : raw.trim();
        if (value.isBlank() || value.length() > maximum) {
            throw ToolRuntimeException.beforeCommit(
                    "invalid_user_input_" + field,
                    field + " 必须是 1 到 " + maximum + " 个字符"
            );
        }
        return value;
    }
}
