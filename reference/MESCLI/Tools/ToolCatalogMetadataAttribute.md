using AIGateway.Models;

namespace AIGateway.Tools;

/// <summary>
/// 工具目录元数据：将风险等级、并发/破坏语义、分类、延迟加载等信息声明为工具的第一公民。
/// 当工具实现未标注此 attribute 时，CapabilityService 会回退到约定推断。
/// </summary>
[AttributeUsage(AttributeTargets.Class, Inherited = false, AllowMultiple = false)]
public sealed class ToolCatalogMetadataAttribute : Attribute
{
    /// <summary>风险等级：safe / normal / dangerous。</summary>
    public string RiskLevel { get; set; } = "normal";

    /// <summary>是否为只读操作（不影响系统状态）。</summary>
    public bool IsReadOnly { get; set; }

    /// <summary>是否可在参数解析后被判定为并发安全。</summary>
    public bool IsConcurrencySafe { get; set; }

    /// <summary>是否会修改或删除关键状态。</summary>
    public bool IsDestructive { get; set; }

    /// <summary>工具分类，如 sql / export / workflow / iris / web 等。</summary>
    public string? Category { get; set; }

    /// <summary>
    /// 工具在能力目录中的路径，例如 "/demo/query_products"、"/code/python"。
    /// 未指定时由 CapabilityService 根据 Category 和名称推断。
    /// </summary>
    public string? Path { get; set; }

    /// <summary>
    /// 显式声明工具名（对应 ITool.Name）。
    /// 当提供时，ToolRegistry 可在不实例化工具的情况下按名称索引。
    /// </summary>
    public string? ToolName { get; set; }

    /// <summary>是否启用延迟加载（模型通过 tool_search 发现后再注入）。</summary>
    public bool Deferred { get; set; }

    /// <summary>是否始终注入到模型上下文中。</summary>
    public bool AlwaysLoad { get; set; }

    /// <summary>结果最大字符数，超过则截断并标记 IsTruncated。</summary>
    public int? MaxResultSizeChars { get; set; }

    /// <summary>需要的权限标识列表。</summary>
    public string[] RequiredPermissions { get; set; } = Array.Empty<string>();

    /// <summary>参数级拒绝规则（如 SQL 中的 DROP/DELETE 正则）。</summary>
    public string[] DenyPatterns { get; set; } = Array.Empty<string>();

    /// <summary>覆盖默认描述（可选）。</summary>
    public string? Description { get; set; }

    /// <summary>覆盖英文描述（可选）。</summary>
    public string? DescriptionEn { get; set; }

    /// <summary>OpenAI/Anthropic structured-output strict mode。</summary>
    public bool Strict { get; set; }

    /// <summary>
    /// 工具层级：domain / primitive / admin / workflow。
    /// </summary>
    public ToolTier Tier { get; set; } = ToolTier.DomainOperation;

    /// <summary>
    /// 工具加载策略：控制是否默认注入模型上下文。
    /// </summary>
    public ToolLoadStrategy LoadStrategy { get; set; } = ToolLoadStrategy.AlwaysLoad;

    /// <summary>该工具是否为幂等操作。</summary>
    public bool Idempotent { get; set; }

    /// <summary>操作类型：读 / 写 / 混合。</summary>
    public ToolOperationType OperationType { get; set; } = ToolOperationType.Read;

    /// <summary>审批模式：显式 / 隐式 / 自动。</summary>
    public ApprovalMode ApprovalMode { get; set; } = ApprovalMode.Explicit;

    /// <summary>需要的数据权限作用域，如 factory / workshop。</summary>
    public string[] RequiredDataScopes { get; set; } = Array.Empty<string>();

    /// <summary>默认结果截断策略。</summary>
    public ResultTruncationStrategy DefaultTruncation { get; set; } = ResultTruncationStrategy.HeadWithCount;

    /// <summary>默认超时（毫秒）。</summary>
    public int DefaultTimeoutMs { get; set; } = 30000;

    /// <summary>是否默认需要人工审批。</summary>
    public bool RequiresApproval { get; set; }

    /// <summary>
    /// 用户可读的影响陈述句模板，支持 {paramName} 占位符。
    /// 运行时由实际工具参数填充，用于审批卡片中的"影响陈述句"。
    /// </summary>
    public string? ImpactStatement { get; set; }

    /// <summary>受影响的实体类型，用于审计和影响面分析。</summary>
    public string[] AffectedEntityTypes { get; set; } = Array.Empty<string>();

    /// <summary>作用域标签。</summary>
    public string[] Scopes { get; set; } = Array.Empty<string>();

    /// <summary>标签。</summary>
    public string[] Tags { get; set; } = Array.Empty<string>();
}
