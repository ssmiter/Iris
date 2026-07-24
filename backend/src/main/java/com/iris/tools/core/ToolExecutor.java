package com.iris.tools.core;

import com.fasterxml.jackson.databind.JsonNode;
import org.springframework.stereotype.Service;

/**
 * 工具执行器（docs/03 §8）：风险检查 → 审批（如需）→ 执行 → 审计 → 截断。
 * 所有工具调用的唯一入口。
 */
@Service
public class ToolExecutor {

    /** 结果截断上限（字符）。防一次查询把上下文塞爆；截断必须明示。 */
    private static final int RESULT_LIMIT = 16_000;

    private final ToolRegistry registry;
    private final ApprovalGate approvalGate;

    public ToolExecutor(ToolRegistry registry, ApprovalGate approvalGate) {
        this.registry = registry;
        this.approvalGate = approvalGate;
    }

    public ToolResult invoke(String toolCallId, String name, JsonNode args, ToolContext ctx) {
        Tool tool = registry.find(name)
                .orElse(null);
        if (tool == null) {
            return ToolResult.error("工具不存在: " + name + "（先用 tool_search 或 list_capabilities 查找正确名称）");
        }

        // 审批闸门：elevated/destructive 挂起等待决定（fail-close）
        if (tool.riskLevel() == RiskLevel.ELEVATED || tool.riskLevel() == RiskLevel.DESTRUCTIVE) {
            boolean approved = approvalGate.awaitApproval(toolCallId, tool, args, ctx.sessionId());
            if (!approved) {
                return ToolResult.error("用户未批准或审批已超时");
            }
        }

        try {
            ToolResult result = tool.execute(args, ctx);
            // TODO: 审计日志（时间/工具/参数摘要/结果大小/批准人）→ SQLite 单表
            return truncate(result);
        } catch (Exception e) {
            return ToolResult.error("执行失败: " + e.getMessage());
        }
    }

    private ToolResult truncate(ToolResult result) {
        if (result.result() instanceof String s && s.length() > RESULT_LIMIT) {
            return ToolResult.ok(s.substring(0, RESULT_LIMIT)
                    + "\n…（已截断，共 " + s.length() + " 字符）");
        }
        return result;
    }
}
