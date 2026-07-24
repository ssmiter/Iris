package com.iris.agent.model.provider;

import com.fasterxml.jackson.databind.JsonNode;
import com.iris.agent.model.ModelProtocolException;
import com.iris.agent.model.ModelStreamEvent;
import com.iris.agent.model.ModelStreamEvent.BlockCompleted;
import com.iris.agent.model.ModelStreamEvent.BlockDelta;
import com.iris.agent.model.ModelStreamEvent.BlockKind;
import com.iris.agent.model.ModelStreamEvent.BlockStarted;
import com.iris.agent.model.ModelStreamEvent.FragmentMode;
import com.iris.agent.model.ModelStreamEvent.MessageCompleted;
import com.iris.agent.model.ModelStreamEvent.MessageStarted;

import java.util.ArrayList;
import java.util.Comparator;
import java.util.HashMap;
import java.util.List;
import java.util.Map;

/**
 * Chat Completions 风格 stream mapper。一个 stream 对应一个实例。
 */
public final class OpenAiCompatibleStreamMapper {
    private final FragmentMode argumentMode;
    private final Map<Integer, ToolBlock> tools = new HashMap<>();
    private boolean messageStarted;
    private boolean textStarted;
    private boolean textCompleted;
    private int inputTokens;
    private int outputTokens;
    private String finishReason;
    private boolean usageSeen;
    private boolean messageCompleted;

    public OpenAiCompatibleStreamMapper(FragmentMode argumentMode) {
        this.argumentMode = argumentMode;
    }

    public List<ModelStreamEvent> map(JsonNode chunk) {
        List<ModelStreamEvent> events = new ArrayList<>();
        if (!messageStarted) {
            String model = chunk.path("model").asText();
            if (model.isBlank()) {
                throw new ModelProtocolException(
                        "openai_model_missing",
                        "OpenAI-compatible 首个 chunk 缺少 model"
                );
            }
            events.add(new MessageStarted(
                    nullableText(chunk, "id"),
                    model
            ));
            messageStarted = true;
        }

        JsonNode choices = chunk.path("choices");
        if (!choices.isArray() || choices.isEmpty()) {
            updateUsage(chunk);
            if (finishReason != null && usageSeen && !messageCompleted) {
                events.add(completeMessage());
            }
            return events;
        }
        JsonNode choice = choices.get(0);
        JsonNode delta = choice.path("delta");
        if (delta.has("content") && !delta.path("content").isNull()) {
            if (!textStarted) {
                events.add(new BlockStarted(
                        0,
                        BlockKind.TEXT,
                        null,
                        null
                ));
                textStarted = true;
            }
            events.add(new BlockDelta(
                    0,
                    delta.path("content").asText(""),
                    FragmentMode.APPEND
            ));
        }

        JsonNode toolCalls = delta.path("tool_calls");
        if (toolCalls.isArray()) {
            for (JsonNode toolDelta : toolCalls) {
                int providerIndex = requireToolIndex(toolDelta);
                ToolBlock block = tools.computeIfAbsent(
                        providerIndex,
                        ignored -> new ToolBlock(providerIndex + 1)
                );
                String id = nullableText(toolDelta, "id");
                if (id != null) {
                    if (block.providerId != null
                            && !block.providerId.equals(id)) {
                        throw new ModelProtocolException(
                                "openai_tool_id_changed",
                                "同一 tool index 的 provider id 发生变化"
                        );
                    }
                    block.providerId = id;
                }
                JsonNode function = toolDelta.path("function");
                String name = nullableText(function, "name");
                if (name != null) {
                    if (block.name != null && !block.name.equals(name)) {
                        throw new ModelProtocolException(
                                "openai_tool_name_changed",
                                "同一 tool index 的 name 发生变化"
                        );
                    }
                    block.name = name;
                }
                String arguments = nullableText(function, "arguments");
                if (!block.started && block.name != null) {
                    events.add(new BlockStarted(
                            block.canonicalIndex,
                            BlockKind.TOOL_CALL,
                            block.providerId,
                            block.name
                    ));
                    block.started = true;
                    for (String pending : block.pendingArguments) {
                        events.add(new BlockDelta(
                                block.canonicalIndex,
                                pending,
                                argumentMode
                        ));
                    }
                    block.pendingArguments.clear();
                }
                if (arguments != null) {
                    if (block.started) {
                        events.add(new BlockDelta(
                                block.canonicalIndex,
                                arguments,
                                argumentMode
                        ));
                    } else {
                        block.pendingArguments.add(arguments);
                    }
                }
            }
        }

        updateUsage(chunk);
        String finishReason = nullableText(choice, "finish_reason");
        if (finishReason != null) {
            if (this.finishReason != null
                    && !this.finishReason.equals(finishReason)) {
                throw new ModelProtocolException(
                        "openai_finish_reason_changed",
                        "OpenAI-compatible finish reason 发生变化"
                );
            }
            this.finishReason = finishReason;
            if (textStarted && !textCompleted) {
                events.add(new BlockCompleted(0));
                textCompleted = true;
            }
            tools.values().stream()
                    .sorted(Comparator.comparingInt(
                            block -> block.canonicalIndex
                    ))
                    .forEach(block -> {
                        if (!block.started || block.name == null) {
                            throw new ModelProtocolException(
                                    "openai_tool_call_incomplete",
                                    "OpenAI-compatible tool call 在结束时仍缺 name"
                            );
                        }
                        if (!block.completed) {
                            events.add(new BlockCompleted(
                                    block.canonicalIndex
                            ));
                            block.completed = true;
                        }
                    });
            if (usageSeen && !messageCompleted) {
                events.add(completeMessage());
            }
        }
        return events;
    }

    public List<ModelStreamEvent> finish() {
        if (finishReason == null) {
            throw new ModelProtocolException(
                    "openai_finish_reason_missing",
                    "OpenAI-compatible stream 结束但没有 finish reason"
            );
        }
        if (messageCompleted) {
            return List.of();
        }
        return List.of(completeMessage());
    }

    private void updateUsage(JsonNode chunk) {
        JsonNode usage = chunk.path("usage");
        if (usage.has("prompt_tokens")) {
            inputTokens = usage.path("prompt_tokens").asInt();
            usageSeen = true;
        }
        if (usage.has("completion_tokens")) {
            outputTokens = usage.path("completion_tokens").asInt();
            usageSeen = true;
        }
    }

    private MessageCompleted completeMessage() {
        messageCompleted = true;
        return new MessageCompleted(
                normalizeFinishReason(finishReason),
                inputTokens,
                outputTokens
        );
    }

    private int requireToolIndex(JsonNode toolDelta) {
        if (!toolDelta.has("index")
                || !toolDelta.path("index").canConvertToInt()
                || toolDelta.path("index").asInt() < 0) {
            throw new ModelProtocolException(
                    "openai_tool_index_missing",
                    "OpenAI-compatible tool delta 缺少 index"
            );
        }
        return toolDelta.path("index").asInt();
    }

    private String normalizeFinishReason(String reason) {
        return switch (reason) {
            case "stop" -> "end_turn";
            case "length" -> "max_tokens";
            default -> reason;
        };
    }

    private String nullableText(JsonNode node, String field) {
        if (!node.has(field) || node.path(field).isNull()) {
            return null;
        }
        String value = node.path(field).asText();
        return value.isBlank() ? null : value;
    }

    private static final class ToolBlock {
        private final int canonicalIndex;
        private final List<String> pendingArguments = new ArrayList<>();
        private String providerId;
        private String name;
        private boolean started;
        private boolean completed;

        private ToolBlock(int canonicalIndex) {
            this.canonicalIndex = canonicalIndex;
        }
    }
}
