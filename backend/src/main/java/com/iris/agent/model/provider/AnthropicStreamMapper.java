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

import java.util.List;

/**
 * 一个 Anthropic Messages stream 对应一个 mapper 实例。
 */
public final class AnthropicStreamMapper {
    private int inputTokens;
    private int outputTokens;
    private int cacheReadTokens;
    private int cacheMissTokens;
    private boolean messageStarted;

    public List<ModelStreamEvent> map(JsonNode event) {
        String type = event.path("type").asText();
        return switch (type) {
            case "message_start" -> mapMessageStart(event);
            case "content_block_start" -> mapBlockStart(event);
            case "content_block_delta" -> List.of(mapBlockDelta(event));
            case "content_block_stop" -> List.of(
                    new BlockCompleted(requireIndex(event))
            );
            case "message_delta" -> List.of(mapMessageDelta(event));
            case "message_stop", "ping" -> List.of();
            default -> throw new ModelProtocolException(
                    "unsupported_anthropic_event",
                    "不支持的 Anthropic stream event: " + type
            );
        };
    }

    private List<ModelStreamEvent> mapMessageStart(JsonNode event) {
        if (messageStarted) {
            throw new ModelProtocolException(
                    "anthropic_message_started_twice",
                    "Anthropic message_start 重复"
            );
        }
        JsonNode message = event.path("message");
        String model = requiredText(message, "model");
        updateUsage(message.path("usage"));
        messageStarted = true;
        return List.of(new MessageStarted(
                nullableText(message, "id"),
                model
        ));
    }

    private List<ModelStreamEvent> mapBlockStart(JsonNode event) {
        requireMessageStarted();
        int index = requireIndex(event);
        JsonNode block = event.path("content_block");
        String type = requiredText(block, "type");
        BlockKind kind = switch (type) {
            case "thinking" -> BlockKind.THINKING;
            case "text" -> BlockKind.TEXT;
            case "tool_use" -> BlockKind.TOOL_CALL;
            default -> throw new ModelProtocolException(
                    "unsupported_anthropic_block",
                    "不支持的 Anthropic content block: " + type
            );
        };
        BlockStarted started = new BlockStarted(
                index,
                kind,
                kind == BlockKind.TOOL_CALL
                        ? nullableText(block, "id")
                        : null,
                kind == BlockKind.TOOL_CALL
                        ? requiredText(block, "name")
                        : null
        );
        if (kind != BlockKind.TOOL_CALL
                || !block.has("input")
                || !block.path("input").isObject()
                || block.path("input").isEmpty()) {
            return List.of(started);
        }
        return List.of(
                started,
                new BlockDelta(
                        index,
                        block.path("input").toString(),
                        FragmentMode.APPEND
                )
        );
    }

    private BlockDelta mapBlockDelta(JsonNode event) {
        requireMessageStarted();
        JsonNode delta = event.path("delta");
        String type = requiredText(delta, "type");
        String fragment = switch (type) {
            case "text_delta" -> delta.path("text").asText("");
            case "thinking_delta" -> delta.path("thinking").asText("");
            case "input_json_delta" -> delta.path("partial_json").asText("");
            default -> throw new ModelProtocolException(
                    "unsupported_anthropic_delta",
                    "不支持的 Anthropic content delta: " + type
            );
        };
        return new BlockDelta(
                requireIndex(event),
                fragment,
                FragmentMode.APPEND
        );
    }

    private MessageCompleted mapMessageDelta(JsonNode event) {
        requireMessageStarted();
        String stopReason = requiredText(event.path("delta"), "stop_reason");
        JsonNode usage = event.path("usage");
        updateUsage(usage);
        return new MessageCompleted(
                stopReason,
                inputTokens,
                outputTokens,
                cacheReadTokens,
                cacheMissTokens,
                0
        );
    }

    private void updateUsage(JsonNode usage) {
        if (usage == null || usage.isMissingNode()) {
            return;
        }
        int uncached = usage.has("input_tokens")
                ? usage.path("input_tokens").asInt()
                : Math.max(0, cacheMissTokens);
        int created = usage.path("cache_creation_input_tokens").asInt(0);
        if (usage.has("cache_read_input_tokens")) {
            cacheReadTokens = usage.path("cache_read_input_tokens").asInt();
        }
        cacheMissTokens = uncached + created;
        inputTokens = cacheMissTokens + cacheReadTokens;
        if (usage.has("output_tokens")) {
            outputTokens = usage.path("output_tokens").asInt();
        }
    }

    private int requireIndex(JsonNode event) {
        if (!event.has("index") || !event.path("index").canConvertToInt()) {
            throw new ModelProtocolException(
                    "anthropic_block_index_missing",
                    "Anthropic block event 缺少 index"
            );
        }
        return event.path("index").asInt();
    }

    private void requireMessageStarted() {
        if (!messageStarted) {
            throw new ModelProtocolException(
                    "anthropic_message_not_started",
                    "Anthropic block event 早于 message_start"
            );
        }
    }

    private String requiredText(JsonNode node, String field) {
        String value = node.path(field).asText();
        if (value.isBlank()) {
            throw new ModelProtocolException(
                    "anthropic_field_missing",
                    "Anthropic event 缺少 " + field
            );
        }
        return value;
    }

    private String nullableText(JsonNode node, String field) {
        if (!node.has(field) || node.path(field).isNull()) {
            return null;
        }
        String value = node.path(field).asText();
        return value.isBlank() ? null : value;
    }
}
