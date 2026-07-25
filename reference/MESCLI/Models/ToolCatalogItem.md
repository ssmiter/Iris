using System.Text.Json.Nodes;

namespace AIGateway.Models;

public class ToolCatalogItem
{
    public string Name { get; set; } = string.Empty;
    public string Description { get; set; } = string.Empty;
    public JsonObject? Parameters { get; set; }
    public string? RiskLevel { get; set; }
    public bool? IsReadOnly { get; set; }
    public bool? IsConcurrencySafe { get; set; }
    public bool? IsDestructive { get; set; }
    public List<string>? RequiredPermissions { get; set; }
    public int? MaxResultSizeChars { get; set; }
    public string? Category { get; set; }
    public bool? Deferred { get; set; }
    public bool? AlwaysLoad { get; set; }
    public bool? Strict { get; set; }

    /// <summary>
    /// 工具层级：domain / primitive / admin / workflow。
    /// </summary>
    public ToolTier? Tier { get; set; }

    /// <summary>
    /// 加载策略：控制是否默认注入模型上下文。
    /// </summary>
    public ToolLoadStrategy? LoadStrategy { get; set; }

    /// <summary>
    /// 参数级拒绝规则（如 SQL 中的 DROP/DELETE 正则）。
    /// </summary>
    public List<string>? DenyPatterns { get; set; }

    /// <summary>
    /// 是否幂等。
    /// </summary>
    public bool? Idempotent { get; set; }

    /// <summary>
    /// 操作类型：读 / 写 / 混合。
    /// </summary>
    public ToolOperationType? OperationType { get; set; }

    /// <summary>
    /// 审批模式：显式 / 隐式 / 自动。
    /// </summary>
    public ApprovalMode? ApprovalMode { get; set; }

    /// <summary>
    /// 数据权限作用域，如 factory / workshop。
    /// </summary>
    public List<string>? RequiredDataScopes { get; set; }

    /// <summary>
    /// 默认截断策略。
    /// </summary>
    public ResultTruncationStrategy? DefaultTruncation { get; set; }

    /// <summary>
    /// 默认超时（毫秒）。
    /// </summary>
    public int? DefaultTimeoutMs { get; set; }

    /// <summary>
    /// 是否需要前端审批。
    /// </summary>
    public bool? RequiresApproval { get; set; }

    /// <summary>
    /// 用户可读的影响陈述句模板（支持 {paramName} 占位符），
    /// 用于审批卡片中的"影响陈述句"。
    /// </summary>
    public string? ImpactStatement { get; set; }

    /// <summary>
    /// 受影响的实体类型，用于审计和影响面分析。
    /// </summary>
    public List<string>? AffectedEntityTypes { get; set; }

    /// <summary>
    /// 作用域标签。
    /// </summary>
    public List<string>? Scopes { get; set; }

    /// <summary>
    /// 标签。
    /// </summary>
    public List<string>? Tags { get; set; }

    /// <summary>
    /// 工具在能力目录中的路径，例如 "/demo/query_products"。
    /// </summary>
    public string? Path { get; set; }
}
