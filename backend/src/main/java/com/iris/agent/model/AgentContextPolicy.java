package com.iris.agent.model;

import com.iris.agent.model.ModelContextAssembler.ContextSeed;
import com.iris.tools.core.ToolRegistry;
import org.springframework.jdbc.core.simple.JdbcClient;
import org.springframework.stereotype.Service;

import java.util.ArrayList;
import java.util.LinkedHashSet;
import java.util.List;

/**
 * Builds a bounded lease from durable discovery observations.
 */
@Service
public class AgentContextPolicy {
    private static final int RECENT_ACTIVATION_LIMIT = 12;
    private static final List<String> DISCOVERY_PRIMITIVES = List.of(
            "list_capabilities",
            "tool_search",
            "read_capability"
    );
    private static final String SYSTEM_INSTRUCTION = """
            你是 Iris，一个面向个人真实任务的本地 AI 助手。

            先理解目标，再行动。能力 schema 不会全部预装：不知道工具时先用
            list_capabilities 或 tool_search 找到卡片，再用 read_capability
            读取精确定义；只有下一轮明确进入 schema lease 的工具才能调用。
            不凭名字猜参数。

            只读操作可以直接执行。任何写文件、提交表单、发送请求或改变外部状态的
            操作都会停在审批快照前；不要声称未获批准的动作已经发生。
            outcome_unknown 表示结果无法证明，必须先核验证据，不得自动重试同一写入。

            回答应直接、自然、具体。需要工具时继续工作；目标已经完成或确实需要用户
            补充时，再给出清楚的阶段或最终答复。
            """;

    private final JdbcClient jdbc;
    private final ToolRegistry tools;

    public AgentContextPolicy(JdbcClient jdbc, ToolRegistry tools) {
        this.jdbc = jdbc;
        this.tools = tools;
    }

    public ContextSeed seedFor(String runId) {
        LinkedHashSet<String> leased =
                new LinkedHashSet<>(DISCOVERY_PRIMITIVES);
        for (String path : recentInspectedPaths(runId)) {
            tools.all().stream()
                    .filter(binding ->
                            binding.capabilityPath().equals(path))
                    .findFirst()
                    .ifPresent(binding ->
                            leased.add(binding.manifest().name()));
        }
        return new ContextSeed(
                SYSTEM_INSTRUCTION,
                new ArrayList<>(leased)
        );
    }

    private List<String> recentInspectedPaths(String runId) {
        return jdbc.sql("""
                SELECT json_extract(tc.arguments_json, '$.path') AS path
                FROM model_tool_call tc
                JOIN model_attempt ma ON ma.attempt_id = tc.attempt_id
                JOIN tool_observation o ON o.tool_call_id = tc.tool_call_id
                WHERE ma.run_id = :runId
                  AND tc.tool_name = 'read_capability'
                  AND o.outcome_kind = 'succeeded'
                ORDER BY o.created_at DESC
                LIMIT :limit
                """)
                .param("runId", runId)
                .param("limit", RECENT_ACTIVATION_LIMIT)
                .query(String.class)
                .list();
    }
}
