using System.Runtime.Serialization;

namespace AIGateway.Models;

/// <summary>
/// 工具层级：用于 CapabilityService 按场景返回不同工具集。
/// - DomainOperation：完成一个完整业务意图，默认暴露。
/// - Primitive：通用原语/探索性工具，建议延迟加载。
/// - Admin：需要特殊权限的管理员/调试工具。
/// - Workflow：工作流启动器，单独标识。
/// </summary>
public enum ToolTier
{
    [EnumMember(Value = "domain_operation")]
    DomainOperation,

    [EnumMember(Value = "primitive")]
    Primitive,

    [EnumMember(Value = "admin")]
    Admin,

    [EnumMember(Value = "workflow")]
    Workflow
}

/// <summary>
/// 工具执行状态机。
/// </summary>
public enum ToolExecutionStatus
{
    [EnumMember(Value = "queued")]
    Queued,

    [EnumMember(Value = "running")]
    Running,

    [EnumMember(Value = "pending_approval")]
    PendingApproval,

    [EnumMember(Value = "succeeded")]
    Succeeded,

    [EnumMember(Value = "failed")]
    Failed,

    [EnumMember(Value = "cancelled")]
    Cancelled,

    [EnumMember(Value = "timed_out")]
    TimedOut
}

/// <summary>
/// 工具错误分类，帮助前端与模型决定重试、修正还是停止。
/// </summary>
public enum ToolErrorCategory
{
    [EnumMember(Value = "validation_error")]
    ValidationError,

    [EnumMember(Value = "permission_denied")]
    PermissionDenied,

    [EnumMember(Value = "business_rule_violation")]
    BusinessRuleViolation,

    [EnumMember(Value = "resource_not_found")]
    ResourceNotFound,

    [EnumMember(Value = "resource_conflict")]
    ResourceConflict,

    [EnumMember(Value = "external_system_error")]
    ExternalSystemError,

    [EnumMember(Value = "timeout")]
    Timeout,

    [EnumMember(Value = "transient_error")]
    TransientError,

    [EnumMember(Value = "fatal_error")]
    FatalError
}

/// <summary>
/// 结果截断策略。
/// </summary>
public enum ResultTruncationStrategy
{
    [EnumMember(Value = "none")]
    None,

    [EnumMember(Value = "head_only")]
    HeadOnly,

    [EnumMember(Value = "head_with_count")]
    HeadWithCount,

    [EnumMember(Value = "summarized")]
    Summarized
}

/// <summary>
/// 工具加载策略：控制工具默认是否注入模型上下文。
/// </summary>
public enum ToolLoadStrategy
{
    [EnumMember(Value = "always_load")]
    AlwaysLoad,

    [EnumMember(Value = "category_load")]
    CategoryLoad,

    [EnumMember(Value = "deferred")]
    Deferred
}

/// <summary>
/// 工具操作类型：读 / 写 / 混合。
/// </summary>
public enum ToolOperationType
{
    [EnumMember(Value = "read")]
    Read,

    [EnumMember(Value = "write")]
    Write,

    [EnumMember(Value = "mixed")]
    Mixed
}

/// <summary>
/// 审批模式：显式 / 隐式 / 自动。
/// </summary>
public enum ApprovalMode
{
    [EnumMember(Value = "explicit")]
    Explicit,

    [EnumMember(Value = "implicit")]
    Implicit,

    [EnumMember(Value = "auto")]
    Auto
}
