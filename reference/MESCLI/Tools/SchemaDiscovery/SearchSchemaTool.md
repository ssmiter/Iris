using System.Text.Json.Nodes;
using AIGateway.Data.DbAccess;
using Dapper;

namespace AIGateway.Tools.SchemaDiscovery;

public class SearchSchemaTool : ITool
{
    private readonly SqlConnectionFactory _factory;
    private readonly ILogger<SearchSchemaTool> _logger;

    public string Name => "search_schema";

    public string Description =>
        "在 Schema 目录中按关键词搜索表或列。支持搜索表名、列名、中文名、描述。返回匹配的表和列列表。";

    public string DescriptionEn =>
        "Search tables or columns in the schema catalog by keyword. Matches table names, column names, Chinese names, and descriptions.";

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
                ["required"] = new JsonArray { "keyword" },
                ["properties"] = new JsonObject
                {
                    ["keyword"] = new JsonObject
                    {
                        ["type"] = "string",
                        ["description"] = "搜索关键词，支持模糊匹配"
                    },
                    ["db_name"] = new JsonObject
                    {
                        ["type"] = "string",
                        ["description"] = "数据库名过滤：MES(后工序-ykhm)、MENS(密炼及原材料-ykhm)、IRIS(后工序-IRIS)、IRISMIX(密炼及原材料-IRIS)、XYQZ(DataCenter)"
                    },
                    ["search_columns"] = new JsonObject
                    {
                        ["type"] = "boolean",
                        ["description"] = "是否同时搜索列。默认 true",
                        ["default"] = true
                    }
                }
            }
        }
    };

    public SearchSchemaTool(SqlConnectionFactory factory, ILogger<SearchSchemaTool> logger)
    {
        _factory = factory;
        _logger = logger;
    }

    public async Task<ToolResult> InvokeAsync(JsonObject args, ToolContext ctx)
    {
        try
        {
            var keyword = args["keyword"]?.GetValue<string>() ?? throw new ArgumentException("keyword required");
            var dbName = args["db_name"]?.GetValue<string>();
            var searchColumns = args["search_columns"]?.GetValue<bool>() ?? true;

            if (keyword.Length < 2)
                return ToolResult.Fail("关键词至少需要 2 个字符。");

            using var conn = _factory.CreateConnection("AIGateway");
            var param = new DynamicParameters();
            param.Add("Keyword", $"%{keyword}%");

            var dbFilterTable = string.IsNullOrWhiteSpace(dbName) ? "" : "AND DbName = @DbName";
            var dbFilterColumn = string.IsNullOrWhiteSpace(dbName) ? "" : "AND c.DbName = @DbName";
            if (!string.IsNullOrWhiteSpace(dbName))
                param.Add("DbName", dbName);

            // 1. 搜表
            var tables = (await conn.QueryAsync<TableRow>(
                $@"SELECT TableName, TableNameCn, [Description], DomainCode, DbName
FROM SchemaTable
WHERE (TableName LIKE @Keyword OR TableNameCn LIKE @Keyword OR [Description] LIKE @Keyword)
{dbFilterTable}
ORDER BY TableName;",
                param)).ToList();

            // 2. 搜列
            List<ColumnRow> columns = new();
            if (searchColumns)
            {
                columns = (await conn.QueryAsync<ColumnRow>(
                    $@"SELECT c.TableName, c.ColumnName, c.ColumnNameCn, c.DataType, c.[Description], c.DbName
FROM SchemaColumn c
WHERE (c.ColumnName LIKE @Keyword OR c.ColumnNameCn LIKE @Keyword OR c.[Description] LIKE @Keyword)
{dbFilterColumn}
ORDER BY c.TableName, c.ColumnName;",
                    param)).ToList();
            }

            if (tables.Count == 0 && columns.Count == 0)
                return ToolResult.Ok($"未找到与 '{keyword}' 匹配的表或列。");

            var summary = $"搜索 '{keyword}' 结果:\n";
            var tableArray = new JsonArray();
            var colArray = new JsonArray();

            if (tables.Count > 0)
            {
                summary += $"\n匹配的表 ({tables.Count}):\n";
                foreach (var t in tables)
                {
                    summary += $"- {t.TableName} ({JsonStringUtil.Sanitize(t.TableNameCn) ?? ""}) [{t.DbName}]\n";
                    tableArray.Add(new JsonObject
                    {
                        ["table_name"] = t.TableName,
                        ["table_name_cn"] = JsonStringUtil.Sanitize(t.TableNameCn),
                        ["description"] = JsonStringUtil.Sanitize(t.Description),
                        ["db_name"] = t.DbName
                    });
                }
            }

            if (columns.Count > 0)
            {
                summary += $"\n匹配的列 ({columns.Count}):\n";
                foreach (var c in columns)
                {
                    summary += $"- {c.TableName}.{c.ColumnName} ({JsonStringUtil.Sanitize(c.ColumnNameCn) ?? ""}): {c.DataType}  {JsonStringUtil.Sanitize(c.Description) ?? ""}\n";
                    colArray.Add(new JsonObject
                    {
                        ["table_name"] = c.TableName,
                        ["column_name"] = c.ColumnName,
                        ["column_name_cn"] = JsonStringUtil.Sanitize(c.ColumnNameCn),
                        ["data_type"] = c.DataType,
                        ["description"] = JsonStringUtil.Sanitize(c.Description),
                        ["db_name"] = c.DbName
                    });
                }
            }

            var structured = new JsonObject
            {
                ["keyword"] = keyword,
                ["tables"] = tableArray,
                ["columns"] = colArray,
                ["table_count"] = tables.Count,
                ["column_count"] = columns.Count
            };

            return ToolResult.Ok(summary, structured);
        }
        catch (Exception ex)
        {
            _logger.LogError(ex, "SearchSchema failed");
            return ToolResult.Fail($"搜索失败: {ex.Message}");
        }
    }

    private class TableRow
    {
        public string TableName { get; set; } = string.Empty;
        public string? TableNameCn { get; set; }
        public string? Description { get; set; }
        public string DomainCode { get; set; } = string.Empty;
        public string DbName { get; set; } = string.Empty;
    }

    private class ColumnRow
    {
        public string TableName { get; set; } = string.Empty;
        public string ColumnName { get; set; } = string.Empty;
        public string? ColumnNameCn { get; set; }
        public string DataType { get; set; } = string.Empty;
        public string? Description { get; set; }
        public string DbName { get; set; } = string.Empty;
    }
}
