package com.iris.agent.model;

import com.iris.agent.model.ModelContextAssembler.ContextSeed;
import com.iris.agent.model.ModelContextWindowPlanner.ContextBudget;
import com.iris.agent.model.ProviderToolSurfacePlanner.SurfacePlan;
import com.iris.tools.core.ResidentToolSurface;
import com.iris.agent.run.AgentRunContextRepository;
import com.iris.agent.run.AgentRunContextRepository.RunContext;
import org.springframework.stereotype.Service;

/**
 * Builds the byte-stable provider tool surface for the primary agent.
 * Domain capabilities are inspected through the catalog and executed through
 * invoke_capability; they never mutate this resident schema set.
 */
@Service
public final class AgentContextPolicy {
    private static final int MAX_PROVIDER_TOOL_SCHEMA_TOKENS = 16_384;
    private static final String MODEL_TRANSFORM_INSTRUCTION = """
            你执行一次无工具的信息转换。严格遵守用户消息中的转换指令与交付契约，只使用给定原文中的事实。
            不补充原文没有的信息，不声称执行了外部动作，不输出分析过程、寒暄或完成宣告；直接输出可继续被系统使用的结果正文。
            """.strip();
    private final ProviderToolSurfacePlanner surfaces;
    private final AgentSystemPrompt systemPrompt;
    private final AgentRunContextRepository runContexts;

    public AgentContextPolicy(
            ProviderToolSurfacePlanner surfaces,
            AgentSystemPrompt systemPrompt,
            AgentRunContextRepository runContexts
    ) {
        this.surfaces = surfaces;
        this.systemPrompt = systemPrompt;
        this.runContexts = runContexts;
    }

    public ContextSeed seedFor(String runId, String currentRoundId) {
        RunContext runContext = runContexts.find(runId).orElse(null);
        java.util.List<String> requestedNames = runContext == null
                ? ResidentToolSurface.orderedNames()
                : runContext.modelTransform()
                        ? java.util.List.of()
                        : allowedChildSurface(runContext);
        SurfacePlan surface = surfaces.plan(
                requestedNames,
                MAX_PROVIDER_TOOL_SCHEMA_TOKENS
        );
        return new ContextSeed(
                runContext == null
                        ? systemPrompt.instruction()
                        : runContext.modelTransform()
                                ? MODEL_TRANSFORM_INSTRUCTION
                                : childInstruction(runContext),
                runContext == null
                        ? systemPrompt.definitionId()
                        : runContext.modelTransform()
                                ? "iris.pipeline.model_transform"
                                : "iris.agent.child",
                runContext == null ? systemPrompt.version() : 1,
                surface.toolNames(),
                ContextBudget.defaults(),
                surface.maxSchemaTokens(),
                surface.estimatedSchemaTokens(),
                0
        );
    }

    private java.util.List<String> allowedChildSurface(RunContext context) {
        java.util.LinkedHashSet<String> allowed = new java.util.LinkedHashSet<>(
                context.allowedTools().isEmpty()
                        ? ResidentToolSurface.childOrderedNames()
                        : context.allowedTools()
        );
        allowed.retainAll(ResidentToolSurface.childOrderedNames());
        if (allowed.isEmpty()) {
            throw new IllegalStateException(
                    "Child Agent has no valid resident tools"
            );
        }
        return ResidentToolSurface.childOrderedNames().stream()
                .filter(allowed::contains)
                .toList();
    }

    private String childInstruction(RunContext context) {
        return systemPrompt.instruction() + """

                ## 当前隔离任务
                这是一个边界明确的子任务，不是主对话。只根据下面的任务事实、你自己的工具观察和显式送达的消息工作；不要猜测父 Agent 的隐式思考。
                你不能继续委派 Agent。需要父任务决定的未知项如实写入结果，不要扩大职责。
                完成时给出有界结论、关键证据或 Artifact/Workspace 引用；未完成部分和风险必须明确说明。

                交付契约：
                """ + context.resultContract();
    }
}
