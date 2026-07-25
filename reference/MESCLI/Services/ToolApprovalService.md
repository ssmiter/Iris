using System.Collections.Concurrent;
using AIGateway.Models;

namespace AIGateway.Services;

/// <summary>
/// 工具审批状态服务：在 backend-driven 审批闭环中，持有等待用户决策的 TaskCompletionSource。
/// 单例，跨请求共享， keyed by executionId。
/// </summary>
public interface IToolApprovalService
{
    /// <summary>
    /// 阻塞等待指定执行实例的审批决策。
    /// </summary>
    Task<ApprovalDecision> WaitForApprovalAsync(string executionId, CancellationToken ct = default);

    /// <summary>
    /// 提交审批决策。若对应实例正在等待，则完成其 TaskCompletionSource。
    /// </summary>
    /// <returns>是否成功匹配到待审批实例</returns>
    bool TryApprove(string executionId, ApprovalDecision decision);

    /// <summary>
    /// 取消等待中的审批（如执行实例被外部取消或超时）。
    /// </summary>
    /// <returns>是否成功匹配到待审批实例</returns>
    bool TryCancel(string executionId);
}

public class ToolApprovalService : IToolApprovalService, IDisposable
{
    private readonly ConcurrentDictionary<string, TaskCompletionSource<ApprovalDecision>> _pending = new(StringComparer.OrdinalIgnoreCase);
    private readonly ILogger<ToolApprovalService> _logger;

    public ToolApprovalService(ILogger<ToolApprovalService> logger)
    {
        _logger = logger;
    }

    public Task<ApprovalDecision> WaitForApprovalAsync(string executionId, CancellationToken ct = default)
    {
        var tcs = new TaskCompletionSource<ApprovalDecision>(TaskCreationOptions.RunContinuationsAsynchronously);
        _pending[executionId] = tcs;

        var registration = ct.Register(() => TryCancel(executionId));

        // 在 Task 完成后释放 CancellationToken 注册，避免泄漏
        _ = tcs.Task.ContinueWith(
            _ => registration.Dispose(),
            CancellationToken.None,
            TaskContinuationOptions.ExecuteSynchronously,
            TaskScheduler.Default);

        _logger.LogDebug("[Approval] Waiting for approval on execution {ExecutionId}", executionId);
        return tcs.Task;
    }

    public bool TryApprove(string executionId, ApprovalDecision decision)
    {
        if (_pending.TryRemove(executionId, out var tcs))
        {
            var result = tcs.TrySetResult(decision);
            if (result)
            {
                _logger.LogInformation("[Approval] Execution {ExecutionId} approved={Approved}", executionId, decision.Approved);
            }
            return result;
        }

        _logger.LogWarning("[Approval] No pending approval found for execution {ExecutionId}", executionId);
        return false;
    }

    public bool TryCancel(string executionId)
    {
        if (_pending.TryRemove(executionId, out var tcs))
        {
            var result = tcs.TrySetCanceled();
            if (result)
            {
                _logger.LogInformation("[Approval] Execution {ExecutionId} approval cancelled", executionId);
            }
            return result;
        }

        return false;
    }

    public void Dispose()
    {
        foreach (var tcs in _pending.Values)
        {
            try
            {
                tcs.TrySetCanceled();
            }
            catch
            {
                // ignored
            }
        }

        _pending.Clear();
    }
}
