package com.weave.tools.core;

import com.fasterxml.jackson.databind.JsonNode;

/**
 * 工具统一契约（docs/03 §2）。前后端同形状：
 * 后端工具由 ToolRegistry 扫描注册，前端本地工具走同一 JSON 形状经 /api/tools/invoke 调用。
 *
 * 铁律：
 * - name 全局唯一 snake_case；
 * - description 是发现阶段唯一线索，必须写清"做什么 + 何时用"；
 * - path 不由实现者手写——由 DomainCatalog 按包路径推断（文件目录即能力树路径）；
 * - 写操作必须重写 describeImpact，产出一句人话的影响陈述。
 */
public interface Tool {

    String name();

    String description();

    RiskLevel riskLevel();

    /** 参数 JSON Schema（发现阶段按需读取；每个属性都应有 description） */
    JsonNode parametersSchema();

    /** 执行。参数已经过 schema 校验；超时与取消经 ctx 传播。 */
    ToolResult execute(JsonNode args, ToolContext ctx) throws Exception;

    /** 写操作必实现：用一句人话说清这次调用会改变什么（审批条直接展示）。 */
    default String describeImpact(JsonNode args) {
        return description();
    }

    /** 超时（秒），默认 60。 */
    default int timeoutSec() {
        return 60;
    }
}
