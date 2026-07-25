namespace AIGateway.Services;

/// <summary>
/// 对工作区文件的写意图类型，供授权层决策。
/// </summary>
public enum WriteIntent
{
    Create,
    Append,
    Overwrite,
    Delete
}

/// <summary>
/// 工作区文件写入的审计与授权上下文。
/// 所有写操作都应当携带此上下文，便于追溯和 future 审批网关接入。
/// </summary>
/// <param name="ConversationId">触发写入的对话 ID</param>
/// <param name="UserId">触发写入的用户 ID</param>
/// <param name="UserName">触发写入的用户名</param>
/// <param name="ToolName">触发写入的工具名</param>
/// <param name="ToolCallId">触发写入的工具调用 ID</param>
/// <param name="Source">文件来源标签，如 user/backend/execute_python_script</param>
public record WorkspaceWriteContext(
    string? ConversationId = null,
    string? UserId = null,
    string? UserName = null,
    string? ToolName = null,
    string? ToolCallId = null,
    string? Source = null
);
