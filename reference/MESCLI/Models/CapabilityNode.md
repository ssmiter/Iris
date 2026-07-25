using System.Text.Json.Nodes;

namespace AIGateway.Models;

/// <summary>
/// 能力目录树中的节点：可以是目录（folder）或工具（tool）。
/// 注意：节点只暴露可读名称和描述，不暴露内部工具 ID 或执行信息。
/// </summary>
public class CapabilityNode
{
    /// <summary>节点短名称，例如 "query_products"。</summary>
    public string Name { get; set; } = string.Empty;

    /// <summary>节点完整路径，例如 "/demo/query_products"。</summary>
    public string Path { get; set; } = string.Empty;

    /// <summary>节点类型：folder / tool / code_runtime。</summary>
    public string Kind { get; set; } = "tool";

    /// <summary>一句话描述。</summary>
    public string Description { get; set; } = string.Empty;

    /// <summary>工具层级（仅 tool 类型有效）。</summary>
    public ToolTier? Tier { get; set; }

    /// <summary>分类（仅 tool 类型有效）。</summary>
    public string? Category { get; set; }

    /// <summary>
    /// 目录节点的子节点名称列表（仅 folder 类型有效）。
    /// 这里只返回下一层名称，不递归展开。
    /// </summary>
    public List<string>? Children { get; set; }

    /// <summary>
    /// 目录节点下（含所有子层）的可见工具总数（仅 folder 类型有效）。
    /// 是模型判断"这段流程有多少工具"的导航信号。
    /// </summary>
    public int? ToolCount { get; set; }
}
