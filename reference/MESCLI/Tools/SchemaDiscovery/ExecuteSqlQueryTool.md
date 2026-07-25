using System.Data.Common;
using System.IO;
using System.Text;
using System.Text.Json.Nodes;
using System.Text.RegularExpressions;
using AIGateway.Data.DbAccess;
using AIGateway.Data.Local;
using AIGateway.Models;
using AIGateway.Services;
using AIGateway.Tools;
using Dapper;
using Microsoft.Data.SqlClient;
using Microsoft.Data.Sqlite;

namespace AIGateway.Tools.SchemaDiscovery;

/// <summary>
/// SQL 操作类型分类，供授权层按读写动态决策。
/// </summary>
public enum SqlOperationKind
{
    Read,
    Write
}

/// <summary>
/// SQL 语句分类结果。
/// </summary>
public readonly record struct SqlClassification(
    SqlOperationKind Kind,
    string OperationLabel,
    IReadOnlyList<string> Tables)
{
    public bool IsReadOnly => Kind == SqlOperationKind.Read;
}

[ToolCatalogMetadata(
    RiskLevel = "elevated",
    IsReadOnly = false,
    IsConcurrencySafe = false,
    Idempotent = false,
    Tier = ToolTier.DomainOperation,
    Category = "code",
    Path = "/code/sql",
    OperationType = ToolOperationType.Mixed,
    RequiresApproval = false,
    ImpactStatement = "将在 {db_name} 上执行 SQL 写操作：{sql}",
    DenyPatterns = new string[0])]
public class ExecuteSqlQueryTool : ITool
{
    private readonly SqlConnectionFactory _factory;
    private readonly LocalDbConnectionFactory _localFactory;
    private readonly IWorkspaceFileService _workspaceFileService;
    private readonly ILogger<ExecuteSqlQueryTool> _logger;

    public string Name => "execute_sql_query";

    public string Description =>
        "执行 SQL 查询。读操作（SELECT / PRAGMA / EXPLAIN）直接执行；写操作（INSERT / UPDATE / DELETE / CREATE / DROP / ALTER 等）会触发用户前端审批。Local 模式下查询本地 SQLite Demo 数据库；Online 模式下按 db_name 路由到 MES/MENS/IRIS/IRISMIX/XYQZ/AIGateway 等生产库。查询全量执行不截断：完整结果集自动保存到 /workspace/outputs/{date}/sql_result_*.json，返回中只包含预览行（默认 50 行）+ 总行数 + 落盘路径。需要分析全量数据时用 execute_python_script 读取落盘文件，不要因为预览行数有限而重复查询。超时 30 秒。";

    public string DescriptionEn =>
        "Execute SQL queries. Read operations (SELECT / PRAGMA / EXPLAIN) run directly; write operations (INSERT / UPDATE / DELETE / CREATE / DROP / ALTER, etc.) require frontend user approval. In Local mode, queries the local SQLite Demo database; in Online mode, routes by db_name to MES/MENS/IRIS/IRISMIX/XYQZ/AIGateway production databases. Queries run in full without truncation: the complete result set is saved to /workspace/outputs/{date}/sql_result_*.json, and the response contains only preview rows (default 50) + total row count + the saved file path. Use execute_python_script on the saved file for full-data analysis instead of re-querying. 30-second timeout.";

    public ToolDefinition Parameters => new()
    {
        Type = "function",
        Function = new FunctionDefinition
        {
            Name = Name,
            Description = Description,
            Parameters = new JsonObject
            {
                ["type"] = "object",
                ["required"] = new JsonArray { "sql" },
                ["properties"] = new JsonObject
                {
                    ["sql"] = new JsonObject
                    {
                        ["type"] = "string",
                        ["description"] = "SQL 语句。不要包含分号或多条语句。读操作可直接执行，写操作会触发前端审批。Local 模式下可操作 DemoProducts、DemoWorkOrders、DemoProductionRecords 等示例表。"
                    },
                    ["db_name"] = new JsonObject
                    {
                        ["type"] = "string",
                        ["description"] = "目标数据库：MES(后工序：半制品/成型/硫化/设备)、MENS(密炼及原材料：物料/库存/采购/配方)、IRIS(IRIS生产)、IRISMIX(IRIS密炼)、XYQZ、SLS、AIGateway(Schema目录)。可选范围受当前登录域隔离限制（只能查本域数据库），缺省默认本域主库。Local 模式下忽略此参数。"
                    },
                    ["limit"] = new JsonObject
                    {
                        ["type"] = "integer",
                        ["description"] = "返回中预览的行数，默认 50，最大 200。不影响实际查询——查询始终全量执行，完整结果集自动落盘到工作区 JSON 文件，此参数只控制直接展示给模型的预览行数。"
                    }
                }
            }
        }
    };

    public ExecuteSqlQueryTool(SqlConnectionFactory factory, LocalDbConnectionFactory localFactory, IWorkspaceFileService workspaceFileService, ILogger<ExecuteSqlQueryTool> logger)
    {
        _factory = factory;
        _localFactory = localFactory;
        _workspaceFileService = workspaceFileService;
        _logger = logger;
    }

    public async Task<ToolResult> InvokeAsync(JsonObject args, ToolContext ctx)
    {
        try
        {
            var sql = args["sql"]?.GetValue<string>()?.Trim()
                ?? throw new ArgumentException("sql required");
            var limit = args["limit"]?.GetValue<int?>() ?? 50;
            if (limit > 200) limit = 200;
            if (limit < 1) limit = 1;

            var validation = ValidateSql(sql);
            if (!validation.Valid)
                return ToolResult.Fail($"SQL 安全检查失败: {validation.Error}");

            var isLocal = ctx.SystemCode.Equals("local", StringComparison.OrdinalIgnoreCase);
            string dbName;
            if (isLocal)
            {
                var requested = args["db_name"]?.GetValue<string>();
                if (!string.IsNullOrEmpty(requested) && !requested.Equals("local", StringComparison.OrdinalIgnoreCase))
                {
                    _logger.LogDebug("Local mode ignores db_name '{DbName}', using SQLite demo database", requested);
                }
                dbName = "local";
            }
            else
            {
                // 域隔离：缺省用本域主库；显式指定的 db_name 必须在本域白名单内，
                // 防止 sls 登录用户通过 db_name=IRIS 跨域直查其他域生产库。
                dbName = args["db_name"]?.GetValue<string>()?.Trim()
                    ?? DomainCatalog.GetDefaultSqlDatabase(ctx.SystemCode);
                var allowed = DomainCatalog.GetAllowedSqlDatabases(ctx.SystemCode);
                if (allowed != null && !allowed.Any(a => a.Equals(dbName, StringComparison.OrdinalIgnoreCase)))
                {
                    return ToolResult.Fail(
                        $"当前登录域（{ctx.SystemCode}）不允许访问数据库 {dbName}。" +
                        $"本域可访问：{string.Join("、", allowed)}。" +
                        "如需其他域数据，请切换登录的系统代码。");
                }
            }

            using DbConnection conn = isLocal
                ? _localFactory.CreateConnection()
                : dbName.ToUpperInvariant() switch
                {
                    "MENS" => _factory.CreateMENSConnection(),
                    "IRIS" => _factory.CreateIRISConnection(),
                    "IRISMIX" => _factory.CreateIRISMIXConnection(),
                    "XYQZ" => _factory.CreateXYQZConnection(),
                    "SLS" => _factory.CreateSLSConnection(),
                    "AIGateway" => _factory.CreateConnection("AIGateway"),
                    _ => _factory.CreateMESConnection()
                };

            // 全量执行，不在读取层截断（防回归：2026-07-24 前用 .Take(limit) 截断，
            // 导致落盘的"完整 JSON"也只有 ≤200 行，模型对截断结果不信任而反复重查）。
            // 仅保留安全上限防内存事故；超限时在结果中明确告知。
            const int MaxSafetyRows = 50000;
            var fetched = (await conn.QueryAsync(sql, commandTimeout: 30)).Take(MaxSafetyRows + 1).ToList();
            var hitSafetyCap = fetched.Count > MaxSafetyRows;
            var rows = hitSafetyCap ? fetched.Take(MaxSafetyRows).ToList() : fetched;

            if (rows.Count == 0)
                return ToolResult.Ok("查询成功，未返回任何行。如果预期有数据，请先用 COUNT(*) 配合 MIN/MAX(日期列) 确认目标表的数据时间范围，而不是变换条件反复试探。");

            var previewRows = rows.Take(limit).ToList();

            // 完整结果集（全量行）用于落盘
            var fullArray = new JsonArray();
            foreach (var row in rows)
            {
                var obj = new JsonObject();
                var dict = (IDictionary<string, object>)row;
                foreach (var kv in dict)
                {
                    var val = kv.Value;
                    if (val == null)
                        obj[kv.Key] = null;
                    else if (val is string s)
                        obj[kv.Key] = JsonStringUtil.Sanitize(s);
                    else if (val is DateTime dt)
                        obj[kv.Key] = dt.ToString("yyyy-MM-dd HH:mm:ss");
                    else if (val is DateTimeOffset dto)
                        obj[kv.Key] = dto.ToString("yyyy-MM-dd HH:mm:ss");
                    else
                        obj[kv.Key] = JsonValue.Create(val);
                }
                fullArray.Add(obj);
            }

            var firstRow = (IDictionary<string, object>)rows[0];
            var columns = firstRow.Keys.ToList();

            // 喂给模型的只是预览：前 limit 行 + 总行数 + 落盘路径（信心信号，避免截断不信任）
            var summary = $"查询返回共 {rows.Count} 行，{columns.Count} 列";
            if (hitSafetyCap)
                summary += $"（已达安全上限 {MaxSafetyRows} 行，结果可能不完整，请缩小查询范围或分段查询）";
            summary += previewRows.Count < rows.Count
                ? $"。以下为前 {previewRows.Count} 行预览：\n"
                : "：\n";
            summary += string.Join(" | ", columns) + "\n";
            foreach (var row in previewRows)
            {
                var dict = (IDictionary<string, object>)row;
                var values = columns.Select(c =>
                {
                    var v = dict[c];
                    if (v == null) return "NULL";
                    var s = v.ToString() ?? "";
                    if (s.Length > 100) s = s[..100] + "...";
                    return s;
                });
                summary += string.Join(" | ", values) + "\n";
            }

            // 完整结果集 JSON 落盘，模型可用 execute_python_script 读取做全量分析
            string? fullJsonPath = null;
            var fullStructured = new JsonObject
            {
                ["row_count"] = rows.Count,
                ["column_count"] = columns.Count,
                ["columns"] = JsonValue.Create(columns),
                ["rows"] = fullArray
            };
            try
            {
                var (virtualPath, _) = _workspaceFileService.ResolveGeneratedPath("json", "sql_result");
                var jsonContent = fullStructured.ToJsonString();
                var writeCtx = new WorkspaceWriteContext(Source: "execute_sql_query", ToolName: "execute_sql_query");
                await _workspaceFileService.WriteBytesAsync(virtualPath, Encoding.UTF8.GetBytes(jsonContent), writeCtx, append: false, ctx.CancellationToken);
                fullJsonPath = virtualPath;
            }
            catch (Exception ex)
            {
                _logger.LogWarning(ex, "SQL 结果 JSON 持久化到工作区失败");
            }

            // 模型侧 JSON 块只放预览行，附总行数与落盘路径
            var previewArray = new JsonArray();
            for (int i = 0; i < previewRows.Count; i++)
            {
                previewArray.Add(fullArray[i]?.DeepClone());
            }
            var modelJson = new JsonObject
            {
                ["row_count"] = rows.Count,
                ["column_count"] = columns.Count,
                ["columns"] = JsonValue.Create(columns),
                ["rows"] = previewArray,
                ["preview_rows"] = previewRows.Count,
                ["full_result_path"] = fullJsonPath,
                ["note"] = previewRows.Count < rows.Count
                    ? $"共 {rows.Count} 行，此处仅预览前 {previewRows.Count} 行。完整结果已保存到 {fullJsonPath ?? "工作区"}，需要全量分析请用 execute_python_script 读取该文件，不要重复执行本查询。"
                    : $"共 {rows.Count} 行，已完整展示。完整结果同时备份于 {fullJsonPath ?? "工作区"}。"
            };

            var structured = modelJson;

            var safeJson = modelJson.ToJsonString().Replace("-->", "--\\>");
            summary += $"\n完整结果共 {rows.Count} 行，已保存到 {fullJsonPath ?? "（持久化失败）"}。\n\n<!-- WONWORK_JSON_RESULT_START -->\n{safeJson}\n<!-- WONWORK_JSON_RESULT_END -->";

            return ToolResult.Ok(summary, structured);
        }
        catch (SqlException ex)
        {
            _logger.LogWarning(ex, "SQL execution error");
            return ToolResult.Fail($"SQL 执行错误: {ex.Message}");
        }
        catch (SqliteException ex)
        {
            _logger.LogWarning(ex, "SQLite execution error");
            return ToolResult.Fail($"SQLite 执行错误: {ex.Message}");
        }
        catch (Exception ex)
        {
            _logger.LogError(ex, "ExecuteSqlQuery failed");
            return ToolResult.Fail($"查询失败: {ex.Message}");
        }
    }

    /// <summary>
    /// 公开给授权层使用的 SQL 分类器。
    /// </summary>
    public static SqlClassification ClassifySql(string sql)
    {
        if (string.IsNullOrWhiteSpace(sql))
            return new SqlClassification(SqlOperationKind.Read, "empty", Array.Empty<string>());

        var upper = sql.ToUpperInvariant();

        // PRAGMA / EXPLAIN 视为读操作（schema 自省）
        if (Regex.IsMatch(sql, @"^\s*(PRAGMA|EXPLAIN)\b", RegexOptions.IgnoreCase))
            return new SqlClassification(SqlOperationKind.Read, "schema_inspection", ExtractTables(sql));

        // 写操作关键字（独立单词）
        var writeKeywords = new[] { "INSERT", "UPDATE", "DELETE", "DROP", "CREATE", "ALTER", "TRUNCATE", "MERGE", "REPLACE", "RENAME" };
        var writePattern = $"\\b({string.Join("|", writeKeywords)})\\b";
        var writeMatch = Regex.Match(sql, writePattern, RegexOptions.IgnoreCase);
        if (writeMatch.Success)
            return new SqlClassification(SqlOperationKind.Write, writeMatch.Value.ToUpperInvariant(), ExtractTables(sql));

        // 默认按只读处理（SELECT、WITH SELECT 等）
        return new SqlClassification(SqlOperationKind.Read, "query", ExtractTables(sql));
    }

    private static (bool Valid, string? Error) ValidateSql(string sql)
    {
        if (string.IsNullOrWhiteSpace(sql))
            return (false, "SQL 不能为空");

        // 禁止多语句
        if (sql.Contains(';'))
            return (false, "SQL 中不能包含分号");

        // 禁止注释（防止绕过检查）
        if (sql.Contains("--") || sql.Contains("/*") || sql.Contains("*/"))
            return (false, "SQL 中不能包含注释");

        return (true, null);
    }

    private static IReadOnlyList<string> ExtractTables(string sql)
    {
        // 粗略提取表名：FROM / JOIN / INTO / UPDATE / DELETE FROM / CREATE TABLE 后面的标识符
        var matches = Regex.Matches(sql, @"(?i)\b(FROM|JOIN|INTO|UPDATE|TABLE)\s+`?([A-Za-z_][A-Za-z0-9_]*)`?", RegexOptions.IgnoreCase);
        var tables = new List<string>();
        foreach (Match m in matches)
        {
            var name = m.Groups[2].Value;
            if (!string.IsNullOrWhiteSpace(name) && !tables.Contains(name, StringComparer.OrdinalIgnoreCase))
                tables.Add(name);
        }
        return tables;
    }
}
