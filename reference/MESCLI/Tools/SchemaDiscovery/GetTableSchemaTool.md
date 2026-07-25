using System.Text.Json.Nodes;
using AIGateway.Data.DbAccess;
using Dapper;

namespace AIGateway.Tools.SchemaDiscovery;

public class GetTableSchemaTool : ITool
{
    private readonly SqlConnectionFactory _factory;
    private readonly ILogger<GetTableSchemaTool> _logger;

    public string Name => "get_table_schema";

    public string Description =>
        "获取单张表的完整结构定义。返回列信息（名称、数据类型、是否可空、是否主键/外键、中文备注）以及外键关联关系。";

    public string DescriptionEn =>
        "Get full schema definition of a single table, including columns and foreign key relations.";

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
                ["required"] = new JsonArray { "table_name", "db_name" },
                ["properties"] = new JsonObject
                {
                    ["table_name"] = new JsonObject
                    {
                        ["type"] = "string",
                        ["description"] = "表名，如 Ppt_Plan"
                    },
                    ["db_name"] = new JsonObject
                    {
                        ["type"] = "string",
                        ["description"] = "数据库名：MES(后工序) 或 MENS(密炼及原材料)"
                    }
                }
            }
        }
    };

    public GetTableSchemaTool(SqlConnectionFactory factory, ILogger<GetTableSchemaTool> logger)
    {
        _factory = factory;
        _logger = logger;
    }

    public async Task<ToolResult> InvokeAsync(JsonObject args, ToolContext ctx)
    {
        try
        {
            var tableName = args["table_name"]?.GetValue<string>() ?? throw new ArgumentException("table_name required");
            var dbName = args["db_name"]?.GetValue<string>() ?? throw new ArgumentException("db_name required");

            using var conn = _factory.CreateConnection("AIGateway");

            // 1. 查列
            var columns = (await conn.QueryAsync<ColumnRow>(
                @"SELECT ColumnName, ColumnNameCn, DataType, MaxLength, IsNullable, IsPk, IsFk, [Description], DescriptionEn
                  FROM SchemaColumn
                  WHERE TableName = @TableName AND DbName = @DbName
                  ORDER BY Id;",
                new { TableName = tableName, DbName = dbName })).ToList();

            if (columns.Count == 0)
                return ToolResult.Fail($"表 {tableName} ({dbName}) 在目录中不存在。");

            // 2. 查外键关系
            var relations = (await conn.QueryAsync<RelationRow>(
                @"SELECT ParentColumn, ReferencedTable, ReferencedColumn, RelationName
                  FROM SchemaRelation
                  WHERE ParentTable = @TableName AND DbName = @DbName;",
                new { TableName = tableName, DbName = dbName })).ToList();

            // 3. 查表级信息
            var tableInfo = await conn.QueryFirstOrDefaultAsync<TableRow>(
                @"SELECT TableNameCn, [Description], DescriptionEn, DomainCode
                  FROM SchemaTable
                  WHERE TableName = @TableName AND DbName = @DbName;",
                new { TableName = tableName, DbName = dbName });

            var summary = $"表: {tableName} ({dbName})\n";
            if (!string.IsNullOrEmpty(tableInfo?.TableNameCn))
                summary += $"中文名: {tableInfo.TableNameCn}\n";
            if (!string.IsNullOrEmpty(tableInfo?.Description))
                summary += $"描述: {tableInfo.Description}\n";
            summary += $"\n共 {columns.Count} 列:\n";

            var colArray = new JsonArray();
            foreach (var c in columns)
            {
                var nullable = c.IsNullable ? "可空" : "非空";
                var pk = c.IsPk ? ", PK" : "";
                var fk = c.IsFk ? ", FK" : "";
                var len = c.MaxLength.HasValue ? $"({c.MaxLength})" : "";
                summary += $"- {c.ColumnName}: {c.DataType}{len} {nullable}{pk}{fk}  {c.Description ?? ""}\n";

                colArray.Add(new JsonObject
                {
                    ["column_name"] = c.ColumnName,
                    ["column_name_cn"] = JsonStringUtil.Sanitize(c.ColumnNameCn),
                    ["data_type"] = c.DataType,
                    ["max_length"] = c.MaxLength,
                    ["is_nullable"] = c.IsNullable,
                    ["is_pk"] = c.IsPk,
                    ["is_fk"] = c.IsFk,
                    ["description"] = JsonStringUtil.Sanitize(c.Description),
                    ["description_en"] = JsonStringUtil.Sanitize(c.DescriptionEn)
                });
            }

            var relArray = new JsonArray();
            if (relations.Count > 0)
            {
                summary += $"\n外键关系 ({relations.Count}):\n";
                foreach (var r in relations)
                {
                    summary += $"- {r.ParentColumn} -> {r.ReferencedTable}.{r.ReferencedColumn}\n";
                    relArray.Add(new JsonObject
                    {
                        ["parent_column"] = r.ParentColumn,
                        ["referenced_table"] = r.ReferencedTable,
                        ["referenced_column"] = r.ReferencedColumn,
                        ["relation_name"] = r.RelationName
                    });
                }
            }

            var structured = new JsonObject
            {
                ["table_name"] = tableName,
                ["db_name"] = dbName,
                ["table_name_cn"] = JsonStringUtil.Sanitize(tableInfo?.TableNameCn),
                ["description"] = JsonStringUtil.Sanitize(tableInfo?.Description),
                ["domain_code"] = tableInfo?.DomainCode,
                ["columns"] = colArray,
                ["relations"] = relArray
            };

            return ToolResult.Ok(summary, structured);
        }
        catch (Exception ex)
        {
            _logger.LogError(ex, "GetTableSchema failed");
            return ToolResult.Fail($"查询失败: {ex.Message}");
        }
    }

    private class ColumnRow
    {
        public string ColumnName { get; set; } = string.Empty;
        public string? ColumnNameCn { get; set; }
        public string DataType { get; set; } = string.Empty;
        public int? MaxLength { get; set; }
        public bool IsNullable { get; set; }
        public bool IsPk { get; set; }
        public bool IsFk { get; set; }
        public string? Description { get; set; }
        public string? DescriptionEn { get; set; }
    }

    private class RelationRow
    {
        public string ParentColumn { get; set; } = string.Empty;
        public string ReferencedTable { get; set; } = string.Empty;
        public string ReferencedColumn { get; set; } = string.Empty;
        public string? RelationName { get; set; }
    }

    private class TableRow
    {
        public string? TableNameCn { get; set; }
        public string? Description { get; set; }
        public string? DescriptionEn { get; set; }
        public string DomainCode { get; set; } = string.Empty;
    }
}
