namespace AIGateway.Models;

public class ToolInvokeRequest
{
    public string ToolName { get; set; } = string.Empty;
    public string Arguments { get; set; } = string.Empty;
    public string? ToolUseId { get; set; }

    /// <summary>
    /// 业务层幂等键。默认使用 ToolUseId。
    /// </summary>
    public string? IdempotencyKey { get; set; }

    public long? ConversationId { get; set; }
    public string? SystemCode { get; set; }
    public string? UserMessage { get; set; }
    public string? ParentAgentId { get; set; }

    /// <summary>
    /// 全链路追踪 ID。
    /// </summary>
    public string? TraceId { get; set; }

    /// <summary>
    /// 前端已做出的审批决策（M3 审批模式）。
    /// </summary>
    public List<ApprovalDecision>? ApprovalDecisions { get; set; }
}
