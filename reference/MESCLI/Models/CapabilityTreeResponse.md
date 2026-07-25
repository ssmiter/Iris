namespace AIGateway.Models;

/// <summary>
/// GET /api/capabilities/tree 响应：返回指定路径下的目录和工具入口。
/// </summary>
public class CapabilityTreeResponse
{
    /// <summary>当前路径，例如 "/demo"。</summary>
    public string Path { get; set; } = "/";

    /// <summary>当前路径下的节点列表。</summary>
    public List<CapabilityNode> Nodes { get; set; } = new();

    /// <summary>可选提示，例如未登录时的权限说明。</summary>
    public string? Note { get; set; }

    /// <summary>当前路径下（含所有子层）的可见工具总数。</summary>
    public int TotalTools { get; set; }
}
