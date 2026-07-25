using System.Text.Json;
using AIGateway.Middleware;
using AIGateway.Models;
using AIGateway.Services;
using AIGateway.Services.Audit;
using Microsoft.AspNetCore.Mvc;

namespace AIGateway.Controllers;

[ApiController]
[Route("api/[controller]")]
public class ToolsController : ControllerBase
{
    private readonly ToolExecutionService _toolExecutionService;
    private readonly CapabilityService _capabilityService;
    private readonly IToolExecutionAuditService _auditService;
    private readonly IToolExecutionStateService _stateService;
    private readonly IToolApprovalService _approvalService;
    private readonly ILogger<ToolsController> _logger;
    private static readonly JsonSerializerOptions _jsonOptions = new(JsonSerializerOptions.Web);

    public ToolsController(
        ToolExecutionService toolExecutionService,
        CapabilityService capabilityService,
        IToolExecutionAuditService auditService,
        IToolExecutionStateService stateService,
        IToolApprovalService approvalService,
        ILogger<ToolsController> logger)
    {
        _toolExecutionService = toolExecutionService;
        _capabilityService = capabilityService;
        _auditService = auditService;
        _stateService = stateService;
        _approvalService = approvalService;
        _logger = logger;
    }

    /// <summary>
    /// 流式执行单个工具，返回 SSE 格式的 ToolResultChunk 序列。
    /// </summary>
    [HttpPost("execute")]
    public async Task Execute([FromBody] ToolInvokeRequest request, CancellationToken ct = default)
    {
        Response.ContentType = "text/event-stream";
        Response.Headers.Append("Cache-Control", "no-cache");
        Response.Headers.Append("Connection", "keep-alive");

        // 域隔离：systemCode 以服务端认证身份为准，客户端请求体不再覆盖，
        // 防止伪造 systemCode 跨域执行工具。
        var userContext = HttpContext.GetRequiredUserIdentity().ToToolContext();
        userContext.LastUserMessage = request.UserMessage?.Trim() ?? string.Empty;

        try
        {
            await foreach (var chunk in _toolExecutionService.ExecuteAsync(request, userContext, ct))
            {
                var json = JsonSerializer.Serialize(chunk, _jsonOptions);
                await Response.WriteAsync($"data: {json}\n\n", ct);
                await Response.Body.FlushAsync(ct);
            }

            await Response.WriteAsync("data: [DONE]\n\n", ct);
            await Response.Body.FlushAsync(ct);
        }
        catch (OperationCanceledException)
        {
            _logger.LogDebug("Tool execution SSE: request canceled by client");
        }
        catch (Exception ex)
        {
            _logger.LogError(ex, "Tool execution SSE error");
            var errorMessage = $"服务异常: {ex.Message}";
            var errorJson = JsonSerializer.Serialize(new ToolResultChunk
            {
                Type = "error",
                ToolUseId = request.ToolUseId ?? string.Empty,
                ToolName = request.ToolName,
                Data = errorMessage,
                Error = errorMessage,
                IsError = true
            }, _jsonOptions);
            await Response.WriteAsync($"data: {errorJson}\n\n", ct);
            await Response.WriteAsync("data: [DONE]\n\n", ct);
            await Response.Body.FlushAsync(ct);
        }
    }

    /// <summary>
    /// 按关键词搜索工具，返回轻量名称/描述/tier/category 列表。
    /// </summary>
    [HttpPost("search")]
    public ActionResult<ToolSearchResponse> Search([FromBody] ToolSearchRequest request)
    {
        var user = HttpContext.GetRequiredUserIdentity();
        // 域隔离：已认证域身份的 systemCode 权威（客户端参数不可跨域）；
        // local 回退身份（未认证的 MESCLI Local / 开发调试）仍允许客户端指定。
        request.SystemCode = DomainCatalog.ResolveEffectiveSystemCode(user.SystemCode, request.SystemCode);
        // 域隔离：已认证域身份的 systemCode 权威（客户端参数不可跨域）；
        // local 回退身份（未认证的 MESCLI Local / 开发调试）仍允许客户端指定。
        request.SystemCode = DomainCatalog.ResolveEffectiveSystemCode(user.SystemCode, request.SystemCode);
        return Ok(_capabilityService.SearchTools(request));
    }

    /// <summary>
    /// 查询指定执行实例的当前状态与结果摘要。
    /// </summary>
    [HttpGet("executions/{executionId}/status")]
    public async Task<ActionResult<ToolExecutionStatusResponse>> GetExecutionStatus(string executionId, CancellationToken ct = default)
    {
        var record = await _auditService.GetByExecutionIdAsync(executionId, ct);
        if (record == null)
        {
            return NotFound();
        }

        return Ok(new ToolExecutionStatusResponse
        {
            ExecutionId = record.ExecutionId,
            ToolUseId = record.ToolUseId,
            ToolName = record.ToolName,
            Status = record.Status,
            ResultSummary = record.ResultSummary,
            StructuredData = record.GetStructuredDataNode(),
            Error = record.ErrorMessage,
            ErrorCategory = ClassifyRecordError(record),
            IsTruncated = false,
            StartedAt = record.StartedAt,
            CompletedAt = record.CompletedAt
        });
    }

    /// <summary>
    /// 取消指定执行实例。若实例不存在或已结束，返回 404。
    /// </summary>
    [HttpPost("executions/{executionId}/cancel")]
    public IActionResult CancelExecution(string executionId)
    {
        if (!_stateService.IsRegistered(executionId))
        {
            return NotFound(new { message = $"未找到正在运行的执行实例 '{executionId}'。" });
        }

        var cancelled = _stateService.TryCancel(executionId);
        if (!cancelled)
        {
            return BadRequest(new { message = "执行实例无法取消，可能已经已完成。" });
        }

        return Ok(new { executionId, cancelled = true });
    }

    /// <summary>
    /// 提交工具审批决策，恢复 backend-driven 审批闭环。
    /// </summary>
    [HttpPost("approval")]
    public IActionResult SubmitApproval([FromBody] SubmitToolApprovalRequest request)
    {
        if (string.IsNullOrWhiteSpace(request.ExecutionId))
        {
            return BadRequest(new { message = "ExecutionId 不能为空。" });
        }

        var matched = _approvalService.TryApprove(request.ExecutionId, new ApprovalDecision
        {
            ToolCallId = request.ToolUseId,
            Approved = request.Approved,
            Reason = request.Reason
        });

        if (!matched)
        {
            return NotFound(new { message = $"未找到等待审批的执行实例 '{request.ExecutionId}'，可能已超时或已处理。" });
        }

        return Ok(new { executionId = request.ExecutionId, approved = request.Approved });
    }

    private static ToolErrorCategory? ClassifyRecordError(ToolExecutionRecord record)
    {
        if (record.Status != ToolExecutionStatus.Failed || string.IsNullOrWhiteSpace(record.ErrorMessage))
            return null;

        var error = record.ErrorMessage.ToLowerInvariant();
        if (error.Contains("timeout") || error.Contains("超时"))
            return ToolErrorCategory.Timeout;
        if (error.Contains("权限") || error.Contains("permission") || error.Contains("denied"))
            return ToolErrorCategory.PermissionDenied;
        if (error.Contains("not found") || error.Contains("不存在") || error.Contains("找不到"))
            return ToolErrorCategory.ResourceNotFound;
        if (error.Contains("conflict") || error.Contains("already") || error.Contains("重复"))
            return ToolErrorCategory.ResourceConflict;
        if (error.Contains("validation") || error.Contains("invalid") || error.Contains("参数") || error.Contains("required"))
            return ToolErrorCategory.ValidationError;
        if (error.Contains("business") || error.Contains("rule") || error.Contains("不允许"))
            return ToolErrorCategory.BusinessRuleViolation;
        if (error.Contains("external") || error.Contains("mes") || error.Contains("database") || error.Contains("api"))
            return ToolErrorCategory.ExternalSystemError;
        return ToolErrorCategory.FatalError;
    }
}
