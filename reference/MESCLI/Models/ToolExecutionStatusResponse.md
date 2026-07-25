using System.Text.Json.Nodes;

namespace AIGateway.Models;

public class ToolExecutionStatusResponse
{
    public string ExecutionId { get; set; } = string.Empty;
    public string ToolUseId { get; set; } = string.Empty;
    public string ToolName { get; set; } = string.Empty;
    public ToolExecutionStatus Status { get; set; }
    public string? ResultSummary { get; set; }
    public JsonNode? StructuredData { get; set; }
    public string? Error { get; set; }
    public ToolErrorCategory? ErrorCategory { get; set; }
    public bool IsTruncated { get; set; }
    public DateTime StartedAt { get; set; }
    public DateTime? CompletedAt { get; set; }
}
