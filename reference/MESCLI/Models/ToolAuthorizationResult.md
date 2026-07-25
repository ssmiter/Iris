namespace AIGateway.Models;

public enum ToolAuthorizationDecision
{
    Allow,
    Deny,
    Ask
}

public class ToolAuthorizationResult
{
    public ToolAuthorizationDecision Decision { get; set; }
    public string? Reason { get; set; }

    public static ToolAuthorizationResult Allow() => new() { Decision = ToolAuthorizationDecision.Allow };
    public static ToolAuthorizationResult Deny(string reason) => new() { Decision = ToolAuthorizationDecision.Deny, Reason = reason };
    public static ToolAuthorizationResult Ask(string reason) => new() { Decision = ToolAuthorizationDecision.Ask, Reason = reason };
}
