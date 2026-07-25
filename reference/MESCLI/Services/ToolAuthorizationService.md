using System.Text.Json.Nodes;
using System.Text.RegularExpressions;
using AIGateway.Models;
using AIGateway.Tools;
using AIGateway.Tools.SchemaDiscovery;
using Microsoft.Extensions.DependencyInjection;

namespace AIGateway.Services;

/// <summary>
/// 统一工具授权服务：整合功能权限、参数级拒绝规则、审批决策与数据权限校验。
/// </summary>
public interface IToolAuthorizationService
{
    Task<ToolAuthorizationResult> AuthorizeAsync(
        ToolInvokeRequest request,
        ToolContext userContext,
        ITool tool,
        ToolCatalogItem metadata,
        CancellationToken ct = default);
}

public class ToolAuthorizationService : IToolAuthorizationService
{
    private readonly IServiceProvider _serviceProvider;
    private readonly IRuntimeModeResolver _runtimeModeResolver;
    private readonly ILogger<ToolAuthorizationService> _logger;

    public ToolAuthorizationService(
        IServiceProvider serviceProvider,
        IRuntimeModeResolver runtimeModeResolver,
        ILogger<ToolAuthorizationService> logger)
    {
        _serviceProvider = serviceProvider;
        _runtimeModeResolver = runtimeModeResolver;
        _logger = logger;
    }

    public async Task<ToolAuthorizationResult> AuthorizeAsync(
        ToolInvokeRequest request,
        ToolContext userContext,
        ITool tool,
        ToolCatalogItem metadata,
        CancellationToken ct = default)
    {
        // 1. 参数级拒绝规则（如 SQL 注入/危险操作）
        var denyReason = EvaluateDenyPatterns(request, metadata);
        if (denyReason != null)
        {
            _logger.LogWarning("Tool '{ToolName}' denied by pattern: {Reason}", tool.Name, denyReason);
            return ToolAuthorizationResult.Deny(denyReason);
        }

        // 2. Local 模式防御：只允许执行 Category = demo / local / code 的工具
        if (!string.IsNullOrEmpty(userContext.SystemCode)
            && userContext.SystemCode.Equals("local", StringComparison.OrdinalIgnoreCase)
            && metadata.Category?.Equals("demo", StringComparison.OrdinalIgnoreCase) != true
            && metadata.Category?.Equals("local", StringComparison.OrdinalIgnoreCase) != true
            && metadata.Category?.Equals("code", StringComparison.OrdinalIgnoreCase) != true)
        {
            return ToolAuthorizationResult.Deny("当前为 Local 模式，只能执行 Demo、本地或代码执行工具。");
        }

        // 3. Online 模式显式分支：允许执行 MES 业务领域工具，写操作由后续审批逻辑控制
        if (_runtimeModeResolver.IsOnlineMode(null))
        {
            _logger.LogDebug("Online mode: allowing domain tool '{ToolName}' (category={Category})", tool.Name, metadata.Category);
        }

        // 3. SQL 工具动态审批：读操作直接放行，写操作必须用户审批
        if (tool.Name.Equals("execute_sql_query", StringComparison.OrdinalIgnoreCase))
        {
            var sqlAuth = EvaluateSqlAuthorization(request);
            if (sqlAuth != null)
            {
                return sqlAuth;
            }
        }

        // 4. 显式审批要求
        if (metadata.RequiresApproval == true)
        {
            var approved = request.ApprovalDecisions?.Any(d =>
                d.ToolCallId.Equals(request.ToolUseId, StringComparison.OrdinalIgnoreCase) && d.Approved) == true;

            if (!approved)
            {
                return ToolAuthorizationResult.Ask($"工具 '{tool.Name}' 需要用户审批后方可执行。");
            }
        }

        // 3. 数据权限作用域
        var scopeResult = EvaluateDataScopes(userContext, metadata);
        if (scopeResult != null)
        {
            return ToolAuthorizationResult.Deny(scopeResult);
        }

        // 4. Tier 与功能权限
        var permissionResult = await EvaluateTierPermissionsAsync(userContext, metadata, ct);
        if (permissionResult != null)
        {
            return permissionResult;
        }

        return ToolAuthorizationResult.Allow();
    }

    private async Task<ToolAuthorizationResult?> EvaluateTierPermissionsAsync(ToolContext userContext, ToolCatalogItem metadata, CancellationToken ct)
    {
        var required = metadata.RequiredPermissions;
        if ((required == null || required.Count == 0) && metadata.Tier is not (ToolTier.Admin or ToolTier.Primitive))
        {
            return null;
        }

        try
        {
            using var scope = _serviceProvider.CreateScope();
            var permissionService = scope.ServiceProvider.GetRequiredService<IPermissionService>();
            var permissions = await permissionService.GetPermissionsAsync(
                new UserIdentity
                {
                    UserId = userContext.UserId,
                    RoleId = userContext.RoleId,
                    FactoryId = userContext.FactoryId,
                    DeptId = userContext.DepartmentId,
                    WorkshopId = userContext.WorkshopId,
                    SystemCode = userContext.SystemCode
                },
                ct);

            if (metadata.Tier == ToolTier.Admin && !permissions.IsAdmin)
            {
                return ToolAuthorizationResult.Deny("需要管理员权限（ai:admin）才能执行该工具。");
            }

            if (metadata.Tier == ToolTier.Primitive && !(permissions.IsAdmin || permissions.Features.Contains("ai:advanced")))
            {
                return ToolAuthorizationResult.Deny("需要高级工具权限（ai:advanced）才能执行该工具。");
            }

            if (required != null && required.Count > 0 && !permissions.IsAdmin)
            {
                var missing = required.Except(permissions.Features, StringComparer.OrdinalIgnoreCase).ToList();
                if (missing.Count > 0)
                {
                    return ToolAuthorizationResult.Deny($"缺少功能权限: {string.Join(", ", missing)}。");
                }
            }
        }
        catch (Exception ex)
        {
            _logger.LogWarning(ex, "Failed to evaluate tier permissions for tool {ToolName}; allowing by default", metadata.Name);
        }

        return null;
    }

    private static string? EvaluateDenyPatterns(ToolInvokeRequest request, ToolCatalogItem metadata)
    {
        var patterns = metadata.DenyPatterns;
        if (patterns == null || patterns.Count == 0)
            return null;

        var target = request.Arguments;
        foreach (var pattern in patterns)
        {
            try
            {
                if (Regex.IsMatch(target, pattern, RegexOptions.IgnoreCase, TimeSpan.FromMilliseconds(100)))
                {
                    return $"参数命中拒绝规则: {pattern}";
                }
            }
            catch (RegexMatchTimeoutException)
            {
                return $"拒绝规则超时: {pattern}";
            }
            catch
            {
                // 非法正则，忽略
            }
        }

        return null;
    }

    private static string? EvaluateDataScopes(ToolContext userContext, ToolCatalogItem metadata)
    {
        var scopes = metadata.RequiredDataScopes;
        if (scopes == null || scopes.Count == 0)
            return null;

        foreach (var scope in scopes)
        {
            var normalized = scope.ToLowerInvariant();
            switch (normalized)
            {
                case "factory":
                    if (!userContext.FactoryId.HasValue)
                        return "需要指定工厂权限（Factory）才能执行该工具。";
                    break;
                case "workshop":
                    if (!userContext.WorkshopId.HasValue)
                        return "需要指定车间权限（Workshop）才能执行该工具。";
                    break;
                case "department":
                    if (!userContext.DepartmentId.HasValue)
                        return "需要指定部门权限（Department）才能执行该工具。";
                    break;
            }
        }

        return null;
    }

    private static ToolAuthorizationResult? EvaluateSqlAuthorization(ToolInvokeRequest request)
    {
        string? sql = null;
        try
        {
            if (!string.IsNullOrWhiteSpace(request.Arguments))
            {
                var node = JsonNode.Parse(request.Arguments);
                if (node is JsonObject args)
                {
                    sql = args["sql"]?.GetValue<string>()?.Trim();
                }
            }
        }
        catch
        {
            // 参数解析失败时继续按空 SQL 处理，让执行层返回更具体的错误
        }

        if (string.IsNullOrWhiteSpace(sql))
        {
            return ToolAuthorizationResult.Deny("SQL 参数为空，无法判断操作类型。");
        }

        var classification = ExecuteSqlQueryTool.ClassifySql(sql);
        if (classification.IsReadOnly)
        {
            return null; // 读操作走后续正常授权逻辑
        }

        // 前端 Agentic 循环已对该写操作完成审批，后端不再重复询问
        if (request.ApprovalDecisions?.Any(d =>
            d.Approved &&
            string.Equals(d.ToolCallId, request.ToolUseId, StringComparison.OrdinalIgnoreCase)) == true)
        {
            return null;
        }

        var tables = classification.Tables.Count > 0
            ? string.Join(", ", classification.Tables)
            : "未知表";
        var reason = $"SQL 写操作（{classification.OperationLabel}）需要用户审批。涉及表：{tables}。";
        return ToolAuthorizationResult.Ask(reason);
    }
}
