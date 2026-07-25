namespace AIGateway.Tools;

public class ToolContext
{
    public int UserId { get; set; }
    public string UserName { get; set; } = string.Empty;
    public int? RoleId { get; set; }
    public int? FactoryId { get; set; }
    public int? DepartmentId { get; set; }
    public long? ConversationId { get; set; }
    public string SystemCode { get; set; } = "ykhm";

    /// <summary>
    /// The latest actual user message for this chat request. Confirmation-sensitive tools use this
    /// value so an assistant cannot approve a draft in the same turn in which it was created.
    /// </summary>
    public string LastUserMessage { get; set; } = string.Empty;

    /// <summary>
    /// 车间 ID，用于数据权限校验。
    /// </summary>
    public int? WorkshopId { get; set; }

    /// <summary>LLM 生成的工具调用 ID（call_xxx），由 ToolExecutionService 注入，用于日志关联。</summary>
    public string? ToolCallId { get; set; }

    /// <summary>后端执行实例 ID（exec_xxx），由 ToolExecutionService 注入，用于日志关联。</summary>
    public string? ExecutionId { get; set; }

    /// <summary>
    /// 工具执行取消令牌，长运行工具应周期性检查此令牌并协作取消。
    /// </summary>
    public CancellationToken CancellationToken { get; set; }

    /// <summary>
    /// 进度报告回调，工具在执行过程中可通过此回调向客户端流式发送中间输出。
    /// </summary>
    public Func<string, Task>? OnProgressAsync { get; set; }
}
