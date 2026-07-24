package com.iris.agent.model;

import com.fasterxml.jackson.databind.ObjectMapper;
import com.iris.agent.model.provider.AnthropicStreamMapper;
import com.iris.agent.model.provider.OpenAiCompatibleStreamMapper;
import com.iris.agent.model.ModelStreamEvent.BlockCompleted;
import com.iris.agent.model.ModelStreamEvent.BlockDelta;
import com.iris.agent.model.ModelStreamEvent.BlockKind;
import com.iris.agent.model.ModelStreamEvent.BlockStarted;
import com.iris.agent.model.ModelStreamEvent.FragmentMode;
import com.iris.agent.model.ModelStreamEvent.MessageCompleted;
import com.iris.agent.model.ModelStreamEvent.MessageStarted;
import org.junit.jupiter.api.Test;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

class ModelStreamAssemblerTest {
    private final ObjectMapper objectMapper = new ObjectMapper();

    @Test
    void assemblesInterleavedBlocksAndExplicitCumulativeArguments() {
        ModelStreamAssembler assembler =
                new ModelStreamAssembler("attempt_1", objectMapper);
        assembler.accept(new MessageStarted("message_1", "model_1"));
        assembler.accept(new BlockStarted(0, BlockKind.TEXT, null, null));
        assembler.accept(new BlockDelta(
                0,
                "先查时间。",
                FragmentMode.APPEND
        ));
        assembler.accept(new BlockCompleted(0));
        assembler.accept(new BlockStarted(
                2,
                BlockKind.TOOL_CALL,
                "provider_call_1",
                "current_time"
        ));
        assembler.accept(new BlockDelta(
                2,
                "{\"zone\":",
                FragmentMode.APPEND
        ));
        assembler.accept(new BlockDelta(
                2,
                "{\"zone\":\"UTC\"}",
                FragmentMode.CUMULATIVE
        ));
        assembler.accept(new BlockCompleted(2));
        assembler.accept(new MessageCompleted("tool_use", 10, 5));

        ModelAttemptResult result = assembler.finish();

        assertThat(result.blocks()).extracting(
                ModelAttemptResult.ContentBlock::index
        ).containsExactly(0, 2);
        assertThat(result.toolCalls()).hasSize(1);
        assertThat(result.toolCalls().getFirst().arguments().path("zone")
                .asText()).isEqualTo("UTC");
    }

    @Test
    void rejectsIncompleteToolArgumentsInsteadOfInventingAnEmptyObject() {
        ModelStreamAssembler assembler =
                new ModelStreamAssembler("attempt_2", objectMapper);
        assembler.accept(new MessageStarted("message_2", "model_1"));
        assembler.accept(new BlockStarted(
                0,
                BlockKind.TOOL_CALL,
                "provider_call_2",
                "current_time"
        ));
        assembler.accept(new BlockDelta(
                0,
                "{\"zone\":",
                FragmentMode.APPEND
        ));
        assembler.accept(new BlockCompleted(0));
        assembler.accept(new MessageCompleted("tool_use", 10, 5));

        assertThatThrownBy(assembler::finish)
                .isInstanceOf(ModelProtocolException.class)
                .hasMessageContaining("不是完整 JSON");
    }

    @Test
    void rejectsCumulativeFragmentsThatLoseTheAcceptedPrefix() {
        ModelStreamAssembler assembler =
                new ModelStreamAssembler("attempt_3", objectMapper);
        assembler.accept(new MessageStarted("message_3", "model_1"));
        assembler.accept(new BlockStarted(0, BlockKind.TEXT, null, null));
        assembler.accept(new BlockDelta(
                0,
                "accepted prefix",
                FragmentMode.APPEND
        ));

        assertThatThrownBy(() -> assembler.accept(new BlockDelta(
                0,
                "different cumulative value",
                FragmentMode.CUMULATIVE
        )))
                .isInstanceOf(ModelProtocolException.class)
                .hasMessageContaining("没有包含已接收前缀");
    }

    @Test
    void mapsAnthropicEventsWithoutLeakingProviderShapeIntoTheAssembler()
            throws Exception {
        AnthropicStreamMapper mapper = new AnthropicStreamMapper();
        ModelStreamAssembler assembler =
                new ModelStreamAssembler("attempt_anthropic", objectMapper);
        String[] events = {
                """
                {"type":"message_start","message":{"id":"msg_a","model":"claude-test","usage":{"input_tokens":11,"output_tokens":0}}}
                """,
                """
                {"type":"content_block_start","index":0,"content_block":{"type":"tool_use","id":"call_a","name":"current_time"}}
                """,
                """
                {"type":"content_block_delta","index":0,"delta":{"type":"input_json_delta","partial_json":"{\\"zone\\":\\"UTC\\"}"}}
                """,
                """
                {"type":"content_block_stop","index":0}
                """,
                """
                {"type":"message_delta","delta":{"stop_reason":"tool_use"},"usage":{"output_tokens":7}}
                """
        };
        for (String event : events) {
            mapper.map(objectMapper.readTree(event)).forEach(assembler::accept);
        }

        ModelAttemptResult result = assembler.finish();

        assertThat(result.modelId()).isEqualTo("claude-test");
        assertThat(result.toolCalls().getFirst().providerCallId())
                .isEqualTo("call_a");
        assertThat(result.usage().inputTokens()).isEqualTo(11);
        assertThat(result.usage().outputTokens()).isEqualTo(7);
    }

    @Test
    void mapsOpenAiCompatibleCumulativeToolArguments() throws Exception {
        OpenAiCompatibleStreamMapper mapper =
                new OpenAiCompatibleStreamMapper(FragmentMode.CUMULATIVE);
        ModelStreamAssembler assembler =
                new ModelStreamAssembler("attempt_openai", objectMapper);
        String[] chunks = {
                """
                {"id":"msg_o","model":"openai-test","choices":[{"delta":{"tool_calls":[{"index":0,"id":"call_o","function":{"name":"current_time","arguments":"{\\"zone\\":"}}]},"finish_reason":null}]}
                """,
                """
                {"id":"msg_o","model":"openai-test","choices":[{"delta":{"tool_calls":[{"index":0,"function":{"arguments":"{\\"zone\\":\\"UTC\\"}"}}]},"finish_reason":"tool_calls"}],"usage":{"prompt_tokens":13,"completion_tokens":8}}
                """
        };
        for (String chunk : chunks) {
            mapper.map(objectMapper.readTree(chunk)).forEach(assembler::accept);
        }

        ModelAttemptResult result = assembler.finish();

        assertThat(result.stopReason()).isEqualTo("tool_calls");
        assertThat(result.toolCalls().getFirst().arguments().path("zone")
                .asText()).isEqualTo("UTC");
        assertThat(result.usage().inputTokens()).isEqualTo(13);
        assertThat(result.usage().outputTokens()).isEqualTo(8);
    }
}
