package com.iris.agent.model;

import com.fasterxml.jackson.core.JsonProcessingException;
import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.iris.agent.model.ModelAttemptResult.ContentBlock;
import com.iris.agent.model.ModelAttemptResult.ToolCall;
import com.iris.agent.model.ModelAttemptResult.Usage;
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
import java.util.HashSet;
import java.util.List;
import java.util.Map;
import java.util.Set;

/**
 * 单个 ModelAttempt 的严格流组装器。实例不可跨 attempt 复用。
 */
public final class ModelStreamAssembler {
    private final String attemptId;
    private final ObjectMapper objectMapper;
    private final Map<Integer, MutableBlock> blocks = new HashMap<>();
    private MessageStarted start;
    private MessageCompleted completion;

    public ModelStreamAssembler(String attemptId, ObjectMapper objectMapper) {
        if (attemptId == null || attemptId.isBlank()) {
            throw new IllegalArgumentException("attemptId cannot be blank");
        }
        this.attemptId = attemptId;
        this.objectMapper = objectMapper;
    }

    public void accept(ModelStreamEvent event) {
        if (event == null) {
            fail("null_event", "模型流事件不能为空");
        }
        if (completion != null) {
            fail("event_after_message_completed", "消息完成后仍收到模型流事件");
        }
        switch (event) {
            case MessageStarted value -> start(value);
            case BlockStarted value -> startBlock(value);
            case BlockDelta value -> append(value);
            case BlockCompleted value -> completeBlock(value);
            case MessageCompleted value -> completeMessage(value);
        }
    }

    public ModelAttemptResult finish() {
        if (start == null) {
            fail("message_not_started", "模型流缺少 message_started");
        }
        if (completion == null) {
            fail("message_not_completed", "模型流缺少 message_completed");
        }
        List<MutableBlock> ordered = blocks.values().stream()
                .sorted(Comparator.comparingInt(block -> block.index))
                .toList();
        if (ordered.stream().anyMatch(block -> !block.completed)) {
            fail("block_not_completed", "仍有 content block 未完成");
        }
        Set<String> providerCallIds = new HashSet<>();
        List<ContentBlock> content = new ArrayList<>();
        List<ToolCall> toolCalls = new ArrayList<>();
        int toolOrdinal = 0;
        for (MutableBlock block : ordered) {
            if (block.kind == BlockKind.TOOL_CALL) {
                JsonNode arguments = parseArguments(block);
                if (block.providerBlockId != null
                        && !providerCallIds.add(block.providerBlockId)) {
                    fail(
                            "duplicate_provider_tool_call_id",
                            "模型返回了重复的 tool call id"
                    );
                }
                String toolCallId = "toolcall_" + attemptId + "_" + block.index;
                content.add(new ContentBlock(
                        block.index,
                        block.kind,
                        block.providerBlockId,
                        null,
                        block.toolName,
                        arguments
                ));
                toolCalls.add(new ToolCall(
                        toolCallId,
                        block.providerBlockId,
                        block.toolName,
                        arguments,
                        toolOrdinal++
                ));
            } else {
                content.add(new ContentBlock(
                        block.index,
                        block.kind,
                        block.providerBlockId,
                        block.buffer.toString(),
                        null,
                        null
                ));
            }
        }
        return new ModelAttemptResult(
                start.providerMessageId(),
                start.modelId(),
                content,
                toolCalls,
                completion.stopReason(),
                new Usage(
                        completion.inputTokens(),
                        completion.outputTokens()
                )
        );
    }

    private void start(MessageStarted event) {
        if (start != null) {
            fail("message_started_twice", "模型消息重复开始");
        }
        if (event.modelId() == null || event.modelId().isBlank()) {
            fail("model_id_missing", "模型消息缺少 model id");
        }
        start = event;
    }

    private void startBlock(BlockStarted event) {
        requireStarted();
        if (event.index() < 0 || blocks.containsKey(event.index())) {
            fail("invalid_block_index", "content block index 重复或小于 0");
        }
        if (event.kind() == null) {
            fail("block_kind_missing", "content block 缺少 kind");
        }
        if (event.kind() == BlockKind.TOOL_CALL
                && (event.toolName() == null || event.toolName().isBlank())) {
            fail("tool_name_missing", "tool call 缺少工具名");
        }
        blocks.put(event.index(), new MutableBlock(event));
    }

    private void append(BlockDelta event) {
        requireStarted();
        MutableBlock block = requireOpenBlock(event.index());
        if (event.fragment() == null || event.mode() == null) {
            fail("invalid_block_delta", "content block delta 不完整");
        }
        if (event.mode() == FragmentMode.CUMULATIVE) {
            String current = block.buffer.toString();
            if (!event.fragment().startsWith(current)) {
                fail(
                        "cumulative_delta_regressed",
                        "累计片段没有包含已接收前缀"
                );
            }
            block.buffer.setLength(0);
            block.buffer.append(event.fragment());
        } else {
            block.buffer.append(event.fragment());
        }
    }

    private void completeBlock(BlockCompleted event) {
        MutableBlock block = requireOpenBlock(event.index());
        block.completed = true;
    }

    private void completeMessage(MessageCompleted event) {
        requireStarted();
        if (event.stopReason() == null || event.stopReason().isBlank()) {
            fail("stop_reason_missing", "模型消息缺少 stop reason");
        }
        if (blocks.values().stream().anyMatch(block -> !block.completed)) {
            fail(
                    "message_completed_with_open_blocks",
                    "模型消息结束时仍有 content block 未完成"
            );
        }
        if (event.inputTokens() < 0 || event.outputTokens() < 0) {
            fail("invalid_usage", "模型 token usage 不能为负数");
        }
        completion = event;
    }

    private JsonNode parseArguments(MutableBlock block) {
        try {
            JsonNode parsed = objectMapper.readTree(block.buffer.toString());
            if (parsed == null || !parsed.isObject()) {
                fail(
                        "tool_arguments_not_object",
                        "工具参数必须是一个 JSON object"
                );
            }
            return parsed;
        } catch (JsonProcessingException exception) {
            fail(
                    "tool_arguments_invalid_json",
                    "工具参数不是完整 JSON，不能静默替换为空对象"
            );
            throw new IllegalStateException("unreachable", exception);
        }
    }

    private MutableBlock requireOpenBlock(int index) {
        MutableBlock block = blocks.get(index);
        if (block == null) {
            fail("block_not_started", "收到未开始 content block 的事件");
        }
        if (block.completed) {
            fail("block_already_completed", "content block 完成后仍收到事件");
        }
        return block;
    }

    private void requireStarted() {
        if (start == null) {
            fail("message_not_started", "content block 早于 message_started");
        }
    }

    private void fail(String code, String message) {
        throw new ModelProtocolException(code, message);
    }

    private static final class MutableBlock {
        private final int index;
        private final BlockKind kind;
        private final String providerBlockId;
        private final String toolName;
        private final StringBuilder buffer = new StringBuilder();
        private boolean completed;

        private MutableBlock(BlockStarted start) {
            this.index = start.index();
            this.kind = start.kind();
            this.providerBlockId = start.providerBlockId();
            this.toolName = start.toolName();
        }
    }
}
