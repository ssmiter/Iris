package com.weave.tools.core;

/**
 * 工具风险等级（docs/03 §2）。判定只升不降——会话权限模式可以让行为更严格，
 * 但永远不能把工具自身声明的风险降级（fail-close）。
 */
public enum RiskLevel {
    /** 不改变任何外部状态：直接执行 */
    READ_ONLY,
    /** 常规操作（本地草稿等）：直接执行 + 审计 */
    STANDARD,
    /** 写操作（改文件/发请求/提交表单）：审批挂起 */
    ELEVATED,
    /** 删除/支付/不可逆：审批挂起 + 醒目标记 */
    DESTRUCTIVE
}
