package com.iris.agent.run;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.iris.agent.model.ModelStreamAssembler;
import com.iris.agent.model.ModelStreamEvent;
import com.iris.agent.model.ModelStreamEvent.BlockCompleted;
import com.iris.agent.model.ModelStreamEvent.BlockDelta;
import com.iris.agent.model.ModelStreamEvent.BlockKind;
import com.iris.agent.model.ModelStreamEvent.BlockStarted;
import com.iris.agent.model.ModelStreamEvent.FragmentMode;
import com.iris.agent.run.AgentRunContextRepository.RunContext;
import com.iris.agent.run.RunRoundRepository.RunRow;
import com.iris.tools.core.ToolContext;
import com.iris.tools.core.ToolExecutionViews.Invocation;
import com.iris.tools.core.ToolRuntime;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import reactor.core.scheduler.Schedulers;

import java.nio.file.Path;
import java.util.HashMap;
import java.util.Map;
import java.util.concurrent.Semaphore;
import java.util.function.BooleanSupplier;

/**
 * 流式投机执行器（docs/36 M17）。每个 ModelAttempt 一个实例，与
 * ModelStreamAssembler 平行消费同一事件流：TOOL_CALL block 参数一完整
 * （BlockCompleted）就提前调用同一个 ToolRuntime.invoke。toolCallId
 * 走 ModelStreamAssembler.toolCallIdFor 的确定性公式，正式提交后由
 * findByToolCall 幂等早退对账。
 *
 * 铁律：投机失败永不影响主流——accept 内全部异常转 log。
 * close() 是 commit 成功的正常结束；discard() 在 attempt 失败/失效/
 * 取消时阻止新投机并跳过尚未开始的排队任务（已开始执行的只读调用
 * 任其完成，孤儿 execution 行按设计不回收）。
 */
public final class StreamingToolSpeculator {
    private static final Logger log = LoggerFactory.getLogger(
            StreamingToolSpeculator.class
    );

    private final ToolRuntime toolRuntime;
    private final RunCancellationRegistry cancellations;
    private final AgentRunContextRepository runContexts;
    private final ObjectMapper objectMapper;
    private final boolean enabled;
    private final Semaphore permits;
    private final String attemptId;
    private final RunRow run;
    private final String roundId;
    private final Path workspaceRoot;
    private final boolean initiallyCancelled;
    private final Map<Integer, SpeculativeBlock> blocks = new HashMap<>();
    private volatile boolean closed;
    private volatile boolean discarded;

    public StreamingToolSpeculator(
            ToolRuntime toolRuntime,
            RunCancellationRegistry cancellations,
            AgentRunContextRepository runContexts,
            ObjectMapper objectMapper,
            boolean enabled,
            int maxParallel,
            String attemptId,
            RunRow run,
            String roundId,
            Path workspaceRoot,
            boolean initiallyCancelled
    ) {
        if (maxParallel < 1 || maxParallel > 16) {
            throw new IllegalArgumentException(
                    "speculation max-parallel must be between 1 and 16"
            );
        }
        this.toolRuntime = toolRuntime;
        this.cancellations = cancellations;
        this.runContexts = runContexts;
        this.objectMapper = objectMapper;
        this.enabled = enabled;
        this.permits = new Semaphore(maxParallel);
        this.attemptId = attemptId;
        this.run = run;
        this.roundId = roundId;
        this.workspaceRoot = workspaceRoot;
        this.initiallyCancelled = initiallyCancelled;
    }

    public void accept(ModelStreamEvent event) {
        try {
            if (event instanceof BlockStarted started
                    && started.kind() == BlockKind.TOOL_CALL) {
                if (started.toolName() != null
                        && !started.toolName().isBlank()) {
                    blocks.put(
                            started.index(),
                            new SpeculativeBlock(started.toolName())
                    );
                }
            } else if (event instanceof BlockDelta delta) {
                SpeculativeBlock block = blocks.get(delta.index());
                if (block != null && !appendDelta(block, delta)) {
                    // 协议异常由 assembler 权威判定并让 attempt 失败；
                    // 投机侧只需放弃这个 block。
                    blocks.remove(delta.index());
                }
            } else if (event instanceof BlockCompleted completed) {
                SpeculativeBlock block = blocks.remove(completed.index());
                if (block != null) {
                    maybeSpeculate(completed.index(), block);
                }
            }
        } catch (Exception exception) {
            log.warn(
                    "Streaming speculation dropped an event for attempt {}",
                    attemptId,
                    exception
            );
        }
    }

    /** commit 成功路径的正常结束：不再接受新投机，排队任务继续执行。 */
    public void close() {
        closed = true;
    }

    /** attempt 失败/失效/取消：阻止新投机，尚未开始的排队任务直接跳过。 */
    public void discard() {
        closed = true;
        discarded = true;
    }

    private boolean appendDelta(SpeculativeBlock block, BlockDelta delta) {
        if (delta.fragment() == null || delta.mode() == null) {
            return false;
        }
        if (delta.mode() == FragmentMode.CUMULATIVE) {
            String current = block.buffer.toString();
            if (!delta.fragment().startsWith(current)) {
                return false;
            }
            block.buffer.setLength(0);
            block.buffer.append(delta.fragment());
        } else {
            block.buffer.append(delta.fragment());
        }
        return true;
    }

    private void maybeSpeculate(int blockIndex, SpeculativeBlock block) {
        if (!enabled || closed || discarded) {
            return;
        }
        JsonNode arguments;
        try {
            arguments = objectMapper.readTree(block.buffer.toString());
        } catch (Exception exception) {
            // 参数不是完整 JSON：assembler 会让 attempt 失败，投机静默跳过。
            return;
        }
        if (arguments == null || !arguments.isObject()) {
            return;
        }
        Invocation invocation = new Invocation(
                ModelStreamAssembler.toolCallIdFor(attemptId, blockIndex),
                block.toolName
        );
        ToolContext context = context();
        if (!toolRuntime.speculationEligible(invocation, arguments, context)) {
            return;
        }
        if (!permits.tryAcquire()) {
            return;
        }
        try {
            Schedulers.boundedElastic().schedule(() -> {
                try {
                    if (!discarded) {
                        toolRuntime.invoke(invocation, arguments, context);
                    }
                } catch (Exception exception) {
                    log.warn(
                            "Speculative Tool invocation {} failed; "
                                    + "the formal path stays authoritative",
                            invocation.toolCallId(),
                            exception
                    );
                } finally {
                    permits.release();
                }
            });
        } catch (Exception exception) {
            permits.release();
            log.warn(
                    "Speculative Tool submission {} failed",
                    invocation.toolCallId(),
                    exception
            );
        }
    }

    private ToolContext context() {
        BooleanSupplier cancellation = () -> initiallyCancelled
                || cancellations.isCancelled(run.runId());
        boolean externalWritesAllowed = runContexts.find(run.runId())
                .map(RunContext::externalWritesAllowed)
                .orElse(true);
        return new SpeculativeToolContext(
                run.conversationId(),
                run.turnId(),
                run.runId(),
                roundId,
                workspaceRoot,
                cancellation,
                externalWritesAllowed
        );
    }

    private static final class SpeculativeBlock {
        private final String toolName;
        private final StringBuilder buffer = new StringBuilder();

        private SpeculativeBlock(String toolName) {
            this.toolName = toolName;
        }
    }

    private record SpeculativeToolContext(
            String conversationId,
            String turnId,
            String runId,
            String roundId,
            Path workspaceRoot,
            BooleanSupplier cancellation,
            boolean externalWritesAllowed
    ) implements ToolContext {
        @Override
        public boolean cancelled() {
            return cancellation.getAsBoolean();
        }
    }
}
