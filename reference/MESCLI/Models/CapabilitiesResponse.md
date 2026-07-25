namespace AIGateway.Models;

public class CapabilitiesResponse
{
    /// <summary>
    /// 默认加载的工具目录。为兼容现有客户端，当前仍返回全部工具；
    /// 目标形态为 domainTools + workflowTools。
    /// </summary>
    public List<ToolCatalogItem> Tools { get; set; } = new();

    /// <summary>
    /// 领域操作工具：每个工具对应一个完整业务意图，推荐默认注入模型上下文。
    /// </summary>
    public List<ToolCatalogItem> DomainTools { get; set; } = new();

    /// <summary>
    /// 原语/探索性工具：如 schema 发现、通用 SQL 查询，建议延迟加载或仅在管理员模式启用。
    /// </summary>
    public List<ToolCatalogItem> PrimitiveTools { get; set; } = new();

    /// <summary>
    /// 管理员/调试工具：需要更高权限，普通工厂现场操作默认不加载。
    /// </summary>
    public List<ToolCatalogItem> AdminTools { get; set; } = new();

    /// <summary>
    /// 工作流启动器：单独标识，便于前端按场景渲染工作流入口。
    /// </summary>
    public List<ToolCatalogItem> WorkflowTools { get; set; } = new();

    public List<string> Features { get; set; } = new();
    public string Version { get; set; } = "0.1.0";

    /// <summary>本次目录过滤所用的业务域（ykhm / iris / xyqz / sls / local）。</summary>
    public string? SystemCode { get; set; }

    /// <summary>当前域下可见工具总数（实时统计，随工具增删自动变化）。</summary>
    public int TotalToolCount { get; set; }

    /// <summary>
    /// 领域洞察：基于实时目录结构生成的宏观理解文本（组织方式、各段工具数、读写语义分布），
    /// 前端将其拼接到系统提示，让模型在浏览目录前就建立整体认知。
    /// </summary>
    public string? DomainInsight { get; set; }
}
