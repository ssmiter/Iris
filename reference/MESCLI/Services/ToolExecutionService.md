using System.Runtime.CompilerServices;
using System.Text.Json;
using System.Text.Json.Nodes;
using System.Text.RegularExpressions;
using System.Threading.Channels;
using AIGateway.Models;
using AIGateway.Services.Audit;
using AIGateway.Tools;

namespace AIGateway.Services;

/// <summary>
/// 无状态、流式、可中断、可审计、带幂等判断与错误分类的工具执行服务。
/// 每个工具调用返回一个 ToolResultChunk 序列：progress / result / error / cancelled。
/// </summary>
public interface IToolExecutionService
{
    IAsyncEnumerable<ToolResultChunk> ExecuteAsync(ToolInvokeRequest request, ToolContext userContext, CancellationToken ct = default);
}

public class ToolExecutionService : IToolExecutionService
{
    private readonly ToolRegistry _toolRegistry;
    private readonly CapabilityService _capabilityService;
    private readonly IToolAuthorizationService _authorizationService;
    private readonly IToolExecutionAuditService _auditService;
    private readonly IToolExecutionStateService _stateService;
    private readonly IToolApprovalService _approvalService;
    private readonly ILogger<ToolExecutionService> _logger;

    private const int DefaultMaxResultSizeChars = 15000;
    private const int DefaultHeadRows = 50;
    private const int ResultSummaryMaxChars = 4000;
    private static readonly TimeSpan ApprovalTimeout = TimeSpan.FromMinutes(5);

    public ToolExecutionService(
        ToolRegistry toolRegistry,
        CapabilityService capabilityService,
        IToolAuthorizationService authorizationService,
        IToolExecutionAuditService auditService,
        IToolExecutionStateService stateService,
        IToolApprovalService approvalService,
        ILogger<ToolExecutionService> logger)
    {
        _toolRegistry = toolRegistry;
        _capabilityService = capabilityService;
        _authorizationService = authorizationService;
        _auditService = auditService;
        _stateService = stateService;
        _approvalService = approvalService;
        _logger = logger;
    }

    /// <summary>
    /// 流式执行单个工具。
    /// </summary>
    public async IAsyncEnumerable<ToolResultChunk> ExecuteAsync(
        ToolInvokeRequest request,
        ToolContext userContext,
        [EnumeratorCancellation] CancellationToken ct = default)
    {
        var executionId = $"exec_{Guid.NewGuid():N}";
        var toolUseId = request.ToolUseId ?? Guid.NewGuid().ToString("N");
        request.ToolUseId = toolUseId;
        var toolName = request.ToolName;
        var startedAt = DateTime.UtcNow;

        ToolCatalogItem? metadata = null;
        ToolExecutionRecord? auditRecord = null;
        string? fatalError = null;
        ToolErrorCategory? fatalCategory = null;
        string? fatalSuggestedFix = null;

        try
        {
            metadata = ResolveMetadata(toolName);
            if (metadata == null)
            {
                fatalError = $"Tool '{toolName}' not found.";
                fatalCategory = ToolErrorCategory.ResourceNotFound;
                fatalSuggestedFix = "请确认工具名称正确或检查能力目录。";
            }
            else
            {
                // 执行期域隔离（fail-close）：能力目录按域隐藏只是体验层，
                // 真正的边界是执行拒绝——防止跨域工具被按名直接调用。
                var resolvedTool = _toolRegistry.GetTool(toolName);
                if (resolvedTool != null
                    && !DomainCatalog.IsToolVisibleToSystem(resolvedTool, userContext.SystemCode))
                {
                    fatalError = $"工具 '{toolName}' 不属于当前登录域（{userContext.SystemCode}），已按域隔离策略拒绝执行。";
                    fatalCategory = ToolErrorCategory.PermissionDenied;
                    fatalSuggestedFix = "请通过 list_capabilities 查看当前域可用工具；如需其他域能力，请切换登录的系统代码。";
                }
            }

            if (metadata != null && fatalError == null)
            {
                var idempotencyKey = BuildIdempotencyKey(request);

                // 幂等性/重复调用判断
                var prior = await _auditService.GetByIdempotencyKeyAsync(toolName, idempotencyKey, ct);
                if (prior != null)
                {
                    if (metadata.Idempotent == true && prior.Status == ToolExecutionStatus.Succeeded)
                    {
                        _logger.LogInformation(
                            "Tool '{ToolName}' idempotent hit for key {Key}; returning cached result {ExecutionId}",
                            toolName, idempotencyKey, prior.ExecutionId);
                        yield return CachedResultChunk(prior, toolUseId);
                        yield break;
                    }

                    if (prior.Status != ToolExecutionStatus.Failed)
                    {
                        fatalError = $"重复调用：工具 '{toolName}' 的幂等键 '{idempotencyKey}' 已存在且状态为 {prior.Status}。";
                        fatalCategory = ToolErrorCategory.ResourceConflict;
                        fatalSuggestedFix = "该工具非幂等或已执行成功，请勿重复提交；如需重试，请更换 ToolUseId 或 IdempotencyKey。";
                    }
                }
            }

            // 提前解析参数，供校验与审计使用
            JsonObject args;
            if (fatalError == null)
            {
                try
                {
                    args = ParseArguments(request.Arguments);
                }
                catch (Exception ex)
                {
                    _logger.LogWarning(ex, "Failed to parse tool arguments: {ToolName}", toolName);
                    fatalError = $"参数 JSON 解析失败：{ex.Message}";
                    fatalCategory = ToolErrorCategory.ValidationError;
                    fatalSuggestedFix = "请检查模型生成的工具参数是否为合法 JSON。";
                    args = new JsonObject();
                }
            }
            else
            {
                args = new JsonObject();
            }

            // 参数 Schema 校验
            if (fatalError == null && metadata != null)
            {
                var validation = ValidateArguments(args, metadata);
                if (validation != null)
                {
                    fatalError = validation;
                    fatalCategory = ToolErrorCategory.ValidationError;
                    fatalSuggestedFix = "请补齐必填参数并确保类型正确。";
                }
            }

            // 启动审计
            auditRecord = await _auditService.StartAsync(request, userContext, executionId, ct);

            if (fatalError != null)
            {
                await CompleteAuditAsync(auditRecord, ToolExecutionStatus.Failed, null, null, fatalError, startedAt, ct);
                yield return ErrorChunk(executionId, toolUseId, toolName, fatalError, fatalCategory, fatalSuggestedFix);
                yield break;
            }

            // 注册可取消状态（贯穿授权等待与执行）
            var linkedCt = _stateService.Register(executionId, ct);

            // 授权校验
            var tool = _toolRegistry.GetTool(toolName)!;
            var authResult = await _authorizationService.AuthorizeAsync(request, userContext, tool, metadata!, linkedCt);

            if (authResult.Decision == ToolAuthorizationDecision.Deny)
            {
                var reason = authResult.Reason ?? $"工具 '{toolName}' 未通过授权校验。";
                await CompleteAuditAsync(auditRecord, ToolExecutionStatus.Failed, null, null, reason, startedAt, ct);
                _stateService.Remove(executionId);
                yield return ErrorChunk(
                    executionId,
                    toolUseId,
                    toolName,
                    reason,
                    ToolErrorCategory.PermissionDenied,
                    "请确认当前用户/角色具备相应权限。");
                yield break;
            }

            if (authResult.Decision == ToolAuthorizationDecision.Ask)
            {
                var reason = authResult.Reason ?? $"工具 '{toolName}' 需要用户审批后方可执行。";
                var impactStatement = RenderImpactStatement(metadata?.ImpactStatement, args)
                    ?? reason;
                await _auditService.UpdateStatusAsync(executionId, ToolExecutionStatus.PendingApproval, ct);
                yield return new ToolResultChunk
                {
                    Type = "approval_required",
                    ExecutionId = executionId,
                    Status = ToolExecutionStatus.PendingApproval,
                    ToolUseId = toolUseId,
                    ToolName = toolName,
                    Data = reason,
                    ResultSummary = reason,
                    ImpactStatement = impactStatement,
                    RawParams = args?.DeepClone(),
                    RiskLevel = metadata?.RiskLevel,
                    ExpiresAt = DateTimeOffset.UtcNow.Add(ApprovalTimeout).ToUnixTimeMilliseconds()
                };

                ApprovalDecision? decision = null;
                bool approvalWaitCancelled = false;
                bool approvalWaitTimedOut = false;
                try
                {
                    using var approvalCts = new CancellationTokenSource(ApprovalTimeout);
                    var approvalCt = CancellationTokenSource.CreateLinkedTokenSource(linkedCt, approvalCts.Token).Token;
                    decision = await _approvalService.WaitForApprovalAsync(executionId, approvalCt);
                }
                catch (OperationCanceledException)
                {
                    approvalWaitCancelled = true;
                    approvalWaitTimedOut = !linkedCt.IsCancellationRequested;
                }

                if (approvalWaitCancelled)
                {
                    var status = approvalWaitTimedOut ? ToolExecutionStatus.TimedOut : ToolExecutionStatus.Cancelled;
                    var message = approvalWaitTimedOut ? "审批等待超时（5分钟），已自动取消。" : "审批等待被取消。";
                    await CompleteAuditAsync(auditRecord, status, null, null, message, startedAt, ct);
                    _stateService.Remove(executionId);
                    yield return ErrorChunk(executionId, toolUseId, toolName, message, approvalWaitTimedOut ? ToolErrorCategory.Timeout : ToolErrorCategory.FatalError, "请重新调用工具并尽快完成审批。");
                    yield break;
                }

                yield return new ToolResultChunk
                {
                    Type = "approval_result",
                    ExecutionId = executionId,
                    Status = decision!.Approved ? ToolExecutionStatus.Running : ToolExecutionStatus.Failed,
                    ToolUseId = toolUseId,
                    ToolName = toolName,
                    Data = decision.Approved ? "审批通过，继续执行。" : (decision.Reason ?? "审批被拒绝。"),
                    ResultSummary = decision.Approved ? "审批通过，继续执行。" : (decision.Reason ?? "审批被拒绝。"),
                    StructuredData = new JsonObject { ["approved"] = decision.Approved, ["reason"] = decision.Reason }
                };

                if (!decision.Approved)
                {
                    var rejectReason = decision.Reason ?? $"工具 '{toolName}' 已被用户拒绝。";
                    await CompleteAuditAsync(auditRecord, ToolExecutionStatus.Failed, null, null, rejectReason, startedAt, ct);
                    _stateService.Remove(executionId);
                    yield return ErrorChunk(executionId, toolUseId, toolName, rejectReason, ToolErrorCategory.PermissionDenied, "如需执行，请重新调用工具并确认审批。");
                    yield break;
                }
            }

            await _auditService.UpdateStatusAsync(executionId, ToolExecutionStatus.Running, ct);

            var maxChars = metadata!.MaxResultSizeChars ?? DefaultMaxResultSizeChars;
            var truncationStrategy = metadata!.DefaultTruncation;
            var timeoutMs = metadata!.DefaultTimeoutMs ?? 30000;
            using var timeoutCts = new CancellationTokenSource(TimeSpan.FromMilliseconds(timeoutMs));
            var executionCt = CancellationTokenSource.CreateLinkedTokenSource(linkedCt, timeoutCts.Token).Token;

            var channel = Channel.CreateUnbounded<ToolResultChunk>();
            var progressCtx = new ToolContext
            {
                UserId = userContext.UserId,
                UserName = userContext.UserName,
                RoleId = userContext.RoleId,
                FactoryId = userContext.FactoryId,
                DepartmentId = userContext.DepartmentId,
                WorkshopId = userContext.WorkshopId,
                ConversationId = request.ConversationId ?? userContext.ConversationId,
                SystemCode = userContext.SystemCode,
                LastUserMessage = userContext.LastUserMessage,
                ToolCallId = toolUseId,
                ExecutionId = executionId,
                CancellationToken = executionCt,
                OnProgressAsync = async msg =>
                {
                    try
                    {
                        await channel.Writer.WriteAsync(
                            new ToolResultChunk
                            {
                                Type = "progress",
                                ExecutionId = executionId,
                                Status = ToolExecutionStatus.Running,
                                ToolUseId = toolUseId,
                                ToolName = toolName,
                                Data = msg,
                                ProgressMessage = msg
                            },
                            CancellationToken.None);
                    }
                    catch (ChannelClosedException)
                    {
                        // 消费者已断开，忽略后续 progress
                    }
                }
            };

            var invokeTask = Task.Run(async () =>
            {
                try
                {
                    return await _toolRegistry.InvokeAsync(toolName, args, progressCtx);
                }
                catch (Exception ex)
                {
                    _logger.LogError(ex, "Tool invocation failed: {ToolName}", toolName);
                    return ToolResult.Fail($"Tool execution error: {ex.Message}");
                }
                finally
                {
                    channel.Writer.Complete();
                }
            }, CancellationToken.None);

            await foreach (var chunk in channel.Reader.ReadAllAsync(executionCt))
            {
                yield return chunk;
            }

            if (executionCt.IsCancellationRequested)
            {
                _logger.LogInformation("Tool execution cancelled: {ToolName}", toolName);
                var cancelStatus = timeoutCts.IsCancellationRequested ? ToolExecutionStatus.TimedOut : ToolExecutionStatus.Cancelled;
                await CompleteAuditAsync(auditRecord, cancelStatus, null, null,
                    cancelStatus == ToolExecutionStatus.TimedOut ? "工具执行超时。" : "工具执行已取消。",
                    startedAt, ct);
                _stateService.Remove(executionId);
                yield return new ToolResultChunk
                {
                    Type = cancelStatus == ToolExecutionStatus.TimedOut ? "error" : "cancelled",
                    ExecutionId = executionId,
                    Status = cancelStatus,
                    ToolUseId = toolUseId,
                    ToolName = toolName,
                    Data = cancelStatus == ToolExecutionStatus.TimedOut ? "工具执行超时。" : null,
                    Error = cancelStatus == ToolExecutionStatus.TimedOut ? "工具执行超时。" : null,
                    IsError = cancelStatus == ToolExecutionStatus.TimedOut
                };
                yield break;
            }

            var result = await invokeTask;
            if (result.Success)
            {
                var (data, isTruncated, totalCount, appliedStrategy) = ApplyTruncation(
                    result.Data,
                    maxChars,
                    truncationStrategy);

                await CompleteAuditAsync(auditRecord, ToolExecutionStatus.Succeeded, data, result.StructuredData, null, startedAt, ct);
                _stateService.Remove(executionId);
                yield return new ToolResultChunk
                {
                    Type = "result",
                    ExecutionId = executionId,
                    Status = ToolExecutionStatus.Succeeded,
                    ToolUseId = toolUseId,
                    ToolName = toolName,
                    Data = data,
                    ResultData = data,
                    ResultSummary = data,
                    StructuredData = result.StructuredData,
                    IsTruncated = isTruncated,
                    TotalCount = totalCount,
                    TruncationStrategy = appliedStrategy
                };
            }
            else
            {
                var (category, suggestedFix) = ClassifyError(result.Error);
                await CompleteAuditAsync(auditRecord, ToolExecutionStatus.Failed, null, result.StructuredData, result.Error, startedAt, ct);
                _stateService.Remove(executionId);
                yield return ErrorChunk(executionId, toolUseId, toolName, result.Error ?? "Unknown tool error", category, suggestedFix, result.StructuredData);
            }
        }
        finally
        {
            _stateService.Remove(executionId);
        }
    }

    private ToolCatalogItem? ResolveMetadata(string toolName)
    {
        var tool = _toolRegistry.GetTool(toolName);
        if (tool == null)
            return null;
        return _capabilityService.GetToolMetadata(tool);
    }

    private static string BuildIdempotencyKey(ToolInvokeRequest request)
    {
        return !string.IsNullOrWhiteSpace(request.IdempotencyKey)
            ? request.IdempotencyKey
            : request.ToolUseId ?? Guid.NewGuid().ToString("N");
    }

    private static JsonObject ParseArguments(string? arguments)
    {
        if (string.IsNullOrWhiteSpace(arguments))
            return new JsonObject();

        var node = JsonNode.Parse(arguments);
        return node as JsonObject ?? new JsonObject { ["value"] = node };
    }

    /// <summary>
    /// 渲染影响陈述句模板。支持 {paramName} 占位符，缺失时保留占位符。
    /// </summary>
    private static string? RenderImpactStatement(string? template, JsonObject? args)
    {
        if (string.IsNullOrWhiteSpace(template))
            return null;

        return Regex.Replace(template, @"\{(\w+)\}", m =>
        {
            var key = m.Groups[1].Value;
            if (args != null && args.TryGetPropertyValue(key, out var node) && node != null)
                return node.ToString();
            return m.Value;
        });
    }

    private static string? ValidateArguments(JsonObject args, ToolCatalogItem metadata)
    {
        var schema = metadata.Parameters;
        if (schema == null)
            return null;

        if (!schema.TryGetPropertyValue("required", out var requiredNode) || requiredNode is not JsonArray requiredArray)
            return null;

        var missing = new List<string>();
        foreach (var item in requiredArray)
        {
            if (item is not JsonValue value)
                continue;
            var name = value.GetValue<string?>();
            if (string.IsNullOrWhiteSpace(name))
                continue;
            if (!args.ContainsKey(name) || args[name] is null ||
                (args[name] is JsonValue jv && jv.GetValueKind() == JsonValueKind.Null))
            {
                missing.Add(name);
            }
        }

        if (missing.Count > 0)
            return $"缺少必填参数: {string.Join(", ", missing)}";

        // 基础类型校验
        if (schema.TryGetPropertyValue("properties", out var propertiesNode) && propertiesNode is JsonObject properties)
        {
            foreach (var prop in args)
            {
                if (prop.Value == null || !properties.TryGetPropertyValue(prop.Key, out var propSchemaNode) || propSchemaNode is not JsonObject propSchema)
                    continue;

                if (propSchema.TryGetPropertyValue("type", out var typeNode) && typeNode is JsonValue typeValue)
                {
                    var expectedType = typeValue.GetValue<string?>();
                    if (!IsTypeMatch(prop.Value, expectedType))
                    {
                        return $"参数 '{prop.Key}' 类型应为 {expectedType}。";
                    }
                }
            }
        }

        return null;
    }

    private static bool IsTypeMatch(JsonNode node, string? expectedType)
    {
        if (string.IsNullOrWhiteSpace(expectedType))
            return true;

        return expectedType.ToLowerInvariant() switch
        {
            "string" => node is JsonValue v && v.GetValueKind() == JsonValueKind.String,
            "integer" => node is JsonValue iv && iv.GetValueKind() == JsonValueKind.Number
                && (iv.TryGetValue<int>(out _) || iv.TryGetValue<long>(out _)),
            "number" => node is JsonValue nv && nv.GetValueKind() == JsonValueKind.Number,
            "boolean" => node is JsonValue bv && (bv.GetValueKind() == JsonValueKind.True || bv.GetValueKind() == JsonValueKind.False),
            "array" => node is JsonArray,
            "object" => node is JsonObject,
            _ => true
        };
    }

    private async Task CompleteAuditAsync(
        ToolExecutionRecord record,
        ToolExecutionStatus status,
        string? resultSummary,
        JsonNode? structuredData,
        string? errorMessage,
        DateTime startedAt,
        CancellationToken ct)
    {
        record.Status = status;
        var durationMs = (int)(DateTime.UtcNow - startedAt).TotalMilliseconds;
        await _auditService.CompleteAsync(
            record.ExecutionId,
            status,
            Truncate(resultSummary, ResultSummaryMaxChars),
            structuredData,
            errorMessage,
            durationMs,
            ct);
    }

    private static ToolResultChunk CachedResultChunk(ToolExecutionRecord prior, string toolUseId)
    {
        return new ToolResultChunk
        {
            Type = "result",
            ExecutionId = prior.ExecutionId,
            Status = ToolExecutionStatus.Succeeded,
            ToolUseId = toolUseId,
            ToolName = prior.ToolName,
            Data = prior.ResultSummary,
            ResultData = prior.ResultSummary,
            ResultSummary = prior.ResultSummary,
            StructuredData = prior.GetStructuredDataNode(),
            IsTruncated = false
        };
    }

    private static (string Data, bool IsTruncated, int? TotalCount, ResultTruncationStrategy Strategy) ApplyTruncation(
        string? data,
        int maxChars,
        ResultTruncationStrategy? strategy)
    {
        var effectiveStrategy = strategy ?? ResultTruncationStrategy.HeadWithCount;

        if (string.IsNullOrEmpty(data))
            return (string.Empty, false, null, effectiveStrategy);

        if (effectiveStrategy == ResultTruncationStrategy.None)
        {
            if (data.Length <= maxChars)
                return (data, false, null, effectiveStrategy);

            // None 但超出预算时，安全降级为 HeadWithCount
            effectiveStrategy = ResultTruncationStrategy.HeadWithCount;
        }

        var lines = data.Split(new[] { "\r\n", "\n", "\r" }, StringSplitOptions.None);
        var totalCount = lines.Length;
        string result;
        bool truncated;

        if (effectiveStrategy == ResultTruncationStrategy.Summarized)
        {
            // MVP 阶段不做 LLM 总结，降级为 HeadWithCount
            effectiveStrategy = ResultTruncationStrategy.HeadWithCount;
        }

        if (lines.Length > DefaultHeadRows)
        {
            result = string.Join("\n", lines.Take(DefaultHeadRows));
            truncated = true;
        }
        else
        {
            result = data;
            truncated = false;
        }

        if (result.Length > maxChars)
        {
            result = result[..maxChars];
            truncated = true;
        }

        var suffix = truncated
            ? $"\n\n[结果已截断。原始共 {totalCount} 行，保留前 {DefaultHeadRows} 行；超出 {maxChars} 字符预算部分已省略。]"
            : string.Empty;

        return ($"{result}{suffix}", truncated, totalCount, effectiveStrategy);
    }

    private static ToolResultChunk ErrorChunk(
        string executionId,
        string toolUseId,
        string toolName,
        string error,
        ToolErrorCategory? category,
        string? suggestedFix,
        JsonNode? structuredData = null)
    {
        return new ToolResultChunk
        {
            Type = "error",
            ExecutionId = executionId,
            Status = ToolExecutionStatus.Failed,
            ToolUseId = toolUseId,
            ToolName = toolName,
            Data = error,
            Error = error,
            ErrorCategory = category,
            SuggestedFix = suggestedFix,
            StructuredData = structuredData,
            IsError = true
        };
    }

    private static (ToolErrorCategory Category, string SuggestedFix) ClassifyError(string? error)
    {
        if (string.IsNullOrWhiteSpace(error))
            return (ToolErrorCategory.FatalError, "发生未知错误，请联系管理员。");

        var lower = error.ToLowerInvariant();

        if (lower.Contains("timeout") || lower.Contains("timed out") || lower.Contains("超时"))
            return (ToolErrorCategory.Timeout, "操作超时，请稍后重试或缩短查询范围。");

        if (lower.Contains("permission") || lower.Contains("unauthorized") || lower.Contains("access denied") || lower.Contains("denied") || lower.Contains("权限"))
            return (ToolErrorCategory.PermissionDenied, "请确认当前用户/角色具备相应权限，或请求管理员审批。");

        if (lower.Contains("not found") || lower.Contains("找不到") || lower.Contains("不存在") || lower.Contains("不存在"))
            return (ToolErrorCategory.ResourceNotFound, "请确认目标资源存在且标识正确。");

        if (lower.Contains("conflict") || lower.Contains("already") || lower.Contains("already_executed") || lower.Contains("重复") || lower.Contains("已存在"))
            return (ToolErrorCategory.ResourceConflict, "该操作可能已经执行过，请避免重复调用或更换幂等键。");

        if (lower.Contains("validation") || lower.Contains("invalid") || lower.Contains("缺少") || lower.Contains("required") || lower.Contains("参数") || lower.Contains("schema"))
            return (ToolErrorCategory.ValidationError, "请检查工具参数是否完整且符合 schema 要求。");

        if (lower.Contains("business") || lower.Contains("rule") || lower.Contains("cannot") || lower.Contains("不允许") || lower.Contains("已关闭") || lower.Contains("状态"))
            return (ToolErrorCategory.BusinessRuleViolation, "请确认业务规则允许当前操作（如状态、时间、数量等）。");

        if (lower.Contains("external") || lower.Contains("mes") || lower.Contains("erp") || lower.Contains("database") || lower.Contains("sql") || lower.Contains("api") || lower.Contains("服务"))
            return (ToolErrorCategory.ExternalSystemError, "外部系统异常，请稍后重试或联系管理员。");

        if (lower.Contains("transient") || lower.Contains("network") || lower.Contains("retry") || lower.Contains("临时"))
            return (ToolErrorCategory.TransientError, "瞬态错误，建议重试。");

        return (ToolErrorCategory.FatalError, "发生不可恢复错误，请联系管理员。");
    }

    private static string? Truncate(string? value, int maxLength)
    {
        if (string.IsNullOrEmpty(value) || value.Length <= maxLength)
            return value;
        return value[..maxLength];
    }
}
