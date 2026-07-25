using System.Text.Json.Nodes;
using AIGateway.Data.DbAccess;
using Dapper;

namespace AIGateway.Tools.SchemaDiscovery;

public class ListSchemaTablesTool : ITool
{
    private readonly SqlConnectionFactory _factory;
    private readonly ILogger<ListSchemaTablesTool> _logger;

    public string Name => "list_schema_tables";

    public string Description =>
        "列出 Schema 目录中的表。支持按业务域(DomainCode)或数据库名(DbName)过滤。返回表名、中文名、描述和所属数据库。";

    public string DescriptionEn =>
        "List tables in the schema catalog. Supports filtering by domain code or database name.";

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
                ["properties"] = new JsonObject
                {
                    ["domain_code"] = new JsonObject
                    {
                        ["type"] = "string",
                        ["description"] = "业务域代码，如 Mix(密炼)、Semi(半制品)、Molding(成型)、Curing(硫化)、Equip(设备)、Base(基础数据)、Perm(权限)、Sap(SAP中间表)、Stock(库存)、Other(其他)"
                    },
                    ["db_name"] = new JsonObject
                    {
                        ["type"] = "string",
                        ["description"] = "数据库名过滤：MES(后工序-ykhm)、MENS(密炼及原材料-ykhm)、IRIS(后工序-IRIS)、IRISMIX(密炼及原材料-IRIS)"
                    },
                    ["keyword"] = new JsonObject
                    {
                        ["type"] = "string",
                        ["description"] = "关键词模糊匹配表名或描述"
                    }
                }
            }
        }
    };

    public ListSchemaTablesTool(SqlConnectionFactory factory, ILogger<ListSchemaTablesTool> logger)
    {
        _factory = factory;
        _logger = logger;
    }

    public async Task<ToolResult> InvokeAsync(JsonObject args, ToolContext ctx)
    {
        try
        {
            var domainCode = args["domain_code"]?.GetValue<string>();
            var dbName = args["db_name"]?.GetValue<string>();
            var keyword = args["keyword"]?.GetValue<string>();

            var conditions = new List<string>();
            var parameters = new DynamicParameters();

            if (!string.IsNullOrWhiteSpace(domainCode))
            {
                conditions.Add("DomainCode = @DomainCode");
                parameters.Add("DomainCode", domainCode);
            }

            if (!string.IsNullOrWhiteSpace(dbName))
            {
                conditions.Add("DbName = @DbName");
                parameters.Add("DbName", dbName);
            }

            if (!string.IsNullOrWhiteSpace(keyword))
            {
                conditions.Add("(TableName LIKE @Keyword OR TableNameCn LIKE @Keyword OR [Description] LIKE @Keyword)");
                parameters.Add("Keyword", $"%{keyword}%");
            }

            var whereClause = conditions.Count > 0 ? "WHERE " + string.Join(" AND ", conditions) : "";
            var sql = $@"SELECT TableName, TableNameCn, [Description], DescriptionEn, DomainCode, DbName
FROM SchemaTable
{whereClause}
ORDER BY DomainCode, TableName;";

            using var conn = _factory.CreateConnection("AIGateway");
            var tables = (await conn.QueryAsync<TableRow>(sql, parameters)).ToList();

            if (tables.Count == 0)
                return ToolResult.Ok("未找到匹配的表。");

            var summary = $"找到 {tables.Count} 张表:\n";
            var array = new JsonArray();
            foreach (var t in tables)
            {
                summary += $"- {t.TableName} ({t.TableNameCn ?? "无中文名"}) [{t.DbName}]\n";
                array.Add(new JsonObject
                {
                    ["table_name"] = t.TableName,
                    ["table_name_cn"] = JsonStringUtil.Sanitize(t.TableNameCn),
                    ["description"] = JsonStringUtil.Sanitize(t.Description),
                    ["domain_code"] = t.DomainCode,
                    ["db_name"] = t.DbName
                });
            }

            var structured = new JsonObject { ["tables"] = array, ["count"] = tables.Count };
            return ToolResult.Ok(summary, structured);
        }
        catch (Exception ex)
        {
            _logger.LogError(ex, "ListSchemaTables failed");
            return ToolResult.Fail($"查询失败: {ex.Message}");
        }
    }

    private class TableRow
    {
        public string TableName { get; set; } = string.Empty;
        public string? TableNameCn { get; set; }
        public string? Description { get; set; }
        public string? DescriptionEn { get; set; }
        public string DomainCode { get; set; } = string.Empty;
        public string DbName { get; set; } = string.Empty;
    }
}
