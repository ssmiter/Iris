namespace AIGateway.Models;

public class ApprovalDecision
{
    public string ToolCallId { get; set; } = string.Empty;
    public bool Approved { get; set; }
    public string? Reason { get; set; }
}
