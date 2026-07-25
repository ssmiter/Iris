using System.Data;
using System.Text.RegularExpressions;
using AIGateway.Data.DbAccess;
using Dapper;
using Microsoft.Data.SqlClient;

namespace AIGateway.Services;

/// <summary>
/// 从 MES / MENS 数据库同步表结构元数据到 AIGateway 的 Schema 目录表。
/// 供 LLM 动态发现表、列、关联关系，进而生成查询语句。
/// </summary>
public class SchemaSyncService
{
    private readonly SqlConnectionFactory _factory;
    private readonly ILogger<SchemaSyncService> _logger;

    public SchemaSyncService(SqlConnectionFactory factory, ILogger<SchemaSyncService> logger)
    {
        _factory = factory;
        _logger = logger;
    }

    /// <summary>
    /// 执行全量同步。先清空旧数据，再从 MES 和 MENS 重新抽取。
    /// </summary>
    public async Task<SyncResult> SyncAllAsync(CancellationToken ct = default)
    {
        var result = new SyncResult();
        using var catalogConn = _factory.CreateConnection("AIGateway");

        _logger.LogInformation("[SchemaSync] 开始全量同步...");

        // 0. 确保目录表存在
        await EnsureCatalogTablesAsync(catalogConn);

        // 1. 清空旧数据（保留 Domain 定义）
        await catalogConn.ExecuteAsync("DELETE FROM SchemaRelation;");
        await catalogConn.ExecuteAsync("DELETE FROM SchemaColumn;");
        await catalogConn.ExecuteAsync("DELETE FROM SchemaTable;");
        _logger.LogInformation("[SchemaSync] 已清空旧元数据");

        // 2. 同步 MES
        try
        {
            using var mesConn = _factory.CreateMESConnection();
            var mesResult = await SyncDatabaseAsync(mesConn, catalogConn, "MES", ct);
            result.Tables += mesResult.Tables;
            result.Columns += mesResult.Columns;
            result.Relations += mesResult.Relations;
            _logger.LogInformation("[SchemaSync] MES 同步完成: {Tables} 表, {Columns} 列, {Relations} 关联",
                mesResult.Tables, mesResult.Columns, mesResult.Relations);
        }
        catch (Exception ex)
        {
            _logger.LogError(ex, "[SchemaSync] MES 同步失败");
            result.Errors.Add($"MES: {ex.Message}");
        }

        // 3. 同步 MENS
        try
        {
            using var mensConn = _factory.CreateMENSConnection();
            var mensResult = await SyncDatabaseAsync(mensConn, catalogConn, "MENS", ct);
            result.Tables += mensResult.Tables;
            result.Columns += mensResult.Columns;
            result.Relations += mensResult.Relations;
            _logger.LogInformation("[SchemaSync] MENS 同步完成: {Tables} 表, {Columns} 列, {Relations} 关联",
                mensResult.Tables, mensResult.Columns, mensResult.Relations);
        }
        catch (Exception ex)
        {
            _logger.LogError(ex, "[SchemaSync] MENS 同步失败");
            result.Errors.Add($"MENS: {ex.Message}");
        }

        // 4. 同步 IRIS
        try
        {
            using var irisConn = _factory.CreateIRISConnection();
            var irisResult = await SyncDatabaseAsync(irisConn, catalogConn, "IRIS", ct);
            result.Tables += irisResult.Tables;
            result.Columns += irisResult.Columns;
            result.Relations += irisResult.Relations;
            _logger.LogInformation("[SchemaSync] IRIS 同步完成: {Tables} 表, {Columns} 列, {Relations} 关联",
                irisResult.Tables, irisResult.Columns, irisResult.Relations);
        }
        catch (Exception ex)
        {
            _logger.LogError(ex, "[SchemaSync] IRIS 同步失败");
            result.Errors.Add($"IRIS: {ex.Message}");
        }

        // 5. 同步 IRISMIX
        try
        {
            using var irisMixConn = _factory.CreateIRISMIXConnection();
            var irisMixResult = await SyncDatabaseAsync(irisMixConn, catalogConn, "IRISMIX", ct);
            result.Tables += irisMixResult.Tables;
            result.Columns += irisMixResult.Columns;
            result.Relations += irisMixResult.Relations;
            _logger.LogInformation("[SchemaSync] IRISMIX 同步完成: {Tables} 表, {Columns} 列, {Relations} 关联",
                irisMixResult.Tables, irisMixResult.Columns, irisMixResult.Relations);
        }
        catch (Exception ex)
        {
            _logger.LogError(ex, "[SchemaSync] IRISMIX 同步失败");
            result.Errors.Add($"IRISMIX: {ex.Message}");
        }

        _logger.LogInformation("[SchemaSync] 全量同步结束。总计: {Tables} 表, {Columns} 列, {Relations} 关联",
            result.Tables, result.Columns, result.Relations);

        return result;
    }

    private async Task<SyncResult> SyncDatabaseAsync(
        SqlConnection sourceConn, SqlConnection catalogConn, string dbName, CancellationToken ct)
    {
        var result = new SyncResult();

        // ---------- 1. 同步表 ----------
        var tableSql = string.Format(
            @"SELECT
    t.name AS TableName,
    CAST(ep.value AS NVARCHAR(500)) AS Description
FROM [{0}].sys.tables t
JOIN [{0}].sys.schemas s ON t.schema_id = s.schema_id
LEFT JOIN [{0}].sys.extended_properties ep
    ON t.object_id = ep.major_id AND ep.minor_id = 0 AND ep.name = 'MS_Description'
WHERE s.name = 'dbo'
ORDER BY t.name;",
            dbName);

        var tables = (await sourceConn.QueryAsync<TableInfo>(tableSql)).ToList();

        var tableRecords = new List<object>();
        foreach (var t in tables)
        {
            var domain = InferDomain(t.TableName, dbName);
            tableRecords.Add(new
            {
                DomainCode = domain.Code,
                TableName = t.TableName,
                TableNameCn = domain.SuggestName,
                Description = t.Description,
                DescriptionEn = (string?)null,
                DbName = dbName
            });
        }

        await catalogConn.ExecuteAsync(
            "INSERT INTO SchemaTable (DomainCode, TableName, TableNameCn, Description, DescriptionEn, DbName) VALUES (@DomainCode, @TableName, @TableNameCn, @Description, @DescriptionEn, @DbName);",
            tableRecords);
        result.Tables = tables.Count;

        // ---------- 2. 同步列 ----------
        var columnSql = string.Format(
            @"SELECT
    t.name AS TableName,
    c.name AS ColumnName,
    ty.name AS DataType,
    c.max_length AS MaxLength,
    CASE WHEN c.is_nullable = 1 THEN 1 ELSE 0 END AS IsNullable,
    CASE WHEN EXISTS (
        SELECT 1 FROM [{0}].sys.indexes i
        JOIN [{0}].sys.index_columns ic ON i.object_id = ic.object_id AND i.index_id = ic.index_id
        WHERE i.is_primary_key = 1 AND ic.object_id = c.object_id AND ic.column_id = c.column_id
    ) THEN 1 ELSE 0 END AS IsPk,
    CAST(ep.value AS NVARCHAR(500)) AS Description
FROM [{0}].sys.columns c
JOIN [{0}].sys.tables t ON c.object_id = t.object_id
JOIN [{0}].sys.schemas s ON t.schema_id = s.schema_id
JOIN [{0}].sys.types ty ON c.user_type_id = ty.user_type_id
LEFT JOIN [{0}].sys.extended_properties ep
    ON c.object_id = ep.major_id AND c.column_id = ep.minor_id AND ep.name = 'MS_Description'
WHERE s.name = 'dbo'
ORDER BY t.name, c.column_id;",
            dbName);

        var columns = (await sourceConn.QueryAsync<ColumnInfo>(columnSql)).ToList();

        var colRecords = columns.Select(c => new
        {
            c.TableName,
            c.ColumnName,
            ColumnNameCn = (string?)null,
            c.DataType,
            c.MaxLength,
            c.IsNullable,
            c.IsPk,
            IsFk = 0,
            Description = c.Description,
            DescriptionEn = (string?)null,
            DbName = dbName
        }).ToList();

        await catalogConn.ExecuteAsync(
            "INSERT INTO SchemaColumn (TableName, ColumnName, ColumnNameCn, DataType, MaxLength, IsNullable, IsPk, IsFk, Description, DescriptionEn, DbName) " +
            "VALUES (@TableName, @ColumnName, @ColumnNameCn, @DataType, @MaxLength, @IsNullable, @IsPk, @IsFk, @Description, @DescriptionEn, @DbName);",
            colRecords);
        result.Columns = columns.Count;

        // ---------- 3. 同步外键关系 ----------
        var relationSql = string.Format(
            @"SELECT
    fk.name AS RelationName,
    OBJECT_NAME(fk.parent_object_id) AS ParentTable,
    cp.name AS ParentColumn,
    OBJECT_NAME(fk.referenced_object_id) AS ReferencedTable,
    cr.name AS ReferencedColumn
FROM [{0}].sys.foreign_keys fk
INNER JOIN [{0}].sys.foreign_key_columns fkc
    ON fk.object_id = fkc.constraint_object_id
INNER JOIN [{0}].sys.columns cp
    ON fkc.parent_object_id = cp.object_id AND fkc.parent_column_id = cp.column_id
INNER JOIN [{0}].sys.columns cr
    ON fkc.referenced_object_id = cr.object_id AND fkc.referenced_column_id = cr.column_id
INNER JOIN [{0}].sys.tables pt ON fk.parent_object_id = pt.object_id
INNER JOIN [{0}].sys.tables rt ON fk.referenced_object_id = rt.object_id
INNER JOIN [{0}].sys.schemas ps ON pt.schema_id = ps.schema_id
INNER JOIN [{0}].sys.schemas rs ON rt.schema_id = rs.schema_id
WHERE fk.type = 'F' AND ps.name = 'dbo' AND rs.name = 'dbo';",
            dbName);

        var relations = (await sourceConn.QueryAsync<RelationInfo>(relationSql)).ToList();

        var relRecords = relations.Select(r => new
        {
            r.ParentTable,
            r.ParentColumn,
            r.ReferencedTable,
            r.ReferencedColumn,
            r.RelationName,
            DbName = dbName
        }).ToList();

        if (relRecords.Count > 0)
        {
            await catalogConn.ExecuteAsync(
                "INSERT INTO SchemaRelation (ParentTable, ParentColumn, ReferencedTable, ReferencedColumn, RelationName, DbName) " +
                "VALUES (@ParentTable, @ParentColumn, @ReferencedTable, @ReferencedColumn, @RelationName, @DbName);",
                relRecords);
        }

        // 回写 IsFk 标记到 SchemaColumn
        await catalogConn.ExecuteAsync(
            "UPDATE c SET IsFk = 1 FROM SchemaColumn c JOIN SchemaRelation r " +
            "ON c.TableName = r.ParentTable AND c.ColumnName = r.ParentColumn AND c.DbName = r.DbName;");

        result.Relations = relations.Count;
        return result;
    }

    private static async Task EnsureCatalogTablesAsync(SqlConnection conn)
    {
        await conn.ExecuteAsync(@"
IF NOT EXISTS (SELECT * FROM sys.tables WHERE name = 'SchemaDomain')
CREATE TABLE SchemaDomain (
    DomainCode VARCHAR(50) PRIMARY KEY,
    DomainName NVARCHAR(100) NOT NULL,
    DbName VARCHAR(50) NOT NULL,
    DisplayOrder INT DEFAULT 0,
    Description NVARCHAR(500)
);");

        await conn.ExecuteAsync(@"
IF NOT EXISTS (SELECT * FROM sys.tables WHERE name = 'SchemaTable')
CREATE TABLE SchemaTable (
    Id INT IDENTITY(1,1) PRIMARY KEY,
    DomainCode VARCHAR(50) NOT NULL,
    TableName VARCHAR(200) NOT NULL,
    TableNameCn NVARCHAR(200),
    [Description] NVARCHAR(1000),
    DescriptionEn NVARCHAR(1000),
    DbName VARCHAR(50) NOT NULL,
    SyncedAt DATETIME2 DEFAULT GETDATE(),
    CONSTRAINT UQ_SchemaTable_Name_Db UNIQUE (TableName, DbName)
);");

        await conn.ExecuteAsync(@"
IF NOT EXISTS (SELECT * FROM sys.tables WHERE name = 'SchemaColumn')
CREATE TABLE SchemaColumn (
    Id INT IDENTITY(1,1) PRIMARY KEY,
    TableName VARCHAR(200) NOT NULL,
    ColumnName VARCHAR(200) NOT NULL,
    ColumnNameCn NVARCHAR(200),
    DataType VARCHAR(100) NOT NULL,
    MaxLength INT,
    IsNullable BIT DEFAULT 1,
    IsPk BIT DEFAULT 0,
    IsFk BIT DEFAULT 0,
    [Description] NVARCHAR(1000),
    DescriptionEn NVARCHAR(1000),
    DbName VARCHAR(50) NOT NULL,
    CONSTRAINT UQ_SchemaColumn_Name_Table_Db UNIQUE (TableName, ColumnName, DbName)
);");

        await conn.ExecuteAsync(@"
IF NOT EXISTS (SELECT * FROM sys.tables WHERE name = 'SchemaRelation')
CREATE TABLE SchemaRelation (
    Id INT IDENTITY(1,1) PRIMARY KEY,
    ParentTable VARCHAR(200) NOT NULL,
    ParentColumn VARCHAR(200) NOT NULL,
    ReferencedTable VARCHAR(200) NOT NULL,
    ReferencedColumn VARCHAR(200) NOT NULL,
    RelationName NVARCHAR(200),
    DbName VARCHAR(50) NOT NULL,
    CONSTRAINT UQ_SchemaRelation_Cols_Db UNIQUE (ParentTable, ParentColumn, ReferencedTable, ReferencedColumn, DbName)
);");

        await conn.ExecuteAsync(@"
MERGE SchemaDomain AS target
USING (VALUES
    ('Mix',     N'密炼',       'MENS', 1, N'密炼计划、配方、工艺、物料、产能（MENS/IRISMIX）'),
    ('Semi',    N'半制品',     'MES',  2, N'半制品计划、库存、质检（MES/IRIS）'),
    ('Molding', N'成型',       'MES',  3, N'成型计划、胎坯、模具（MES/IRIS）'),
    ('Curing',  N'硫化',       'MES',  4, N'硫化计划、模具（MES/IRIS）'),
    ('Equip',   N'设备',       'MES',  5, N'设备档案、机台能力、故障、点检（MES/IRIS/IRISMIX）'),
    ('Base',    N'基础数据',   'MES',  6, N'班组、部门、字典、工厂、物料主数据（MES/MENS/IRIS/IRISMIX）'),
    ('Perm',    N'权限',       'MES',  7, N'用户、角色、菜单、操作（MES/IRIS/IRISMIX）'),
    ('Sap',     N'SAP中间表',  'MES',  8, N'SAP 接口中间表（MES/MENS/IRIS/IRISMIX）'),
    ('Stock',   N'库存',       'MENS', 9, N'原材料库存、条码、出入库（MENS/IRIS/IRISMIX）'),
    ('Tech',    N'技术配方',   'MES',  10, N'BOM、配方、工艺参数、规格书（MES/IRIS/IRISMIX）'),
    ('Quality', N'质量检测',   'MES',  11, N'质检数据、缺陷统计、检测报告（MES/IRIS/IRISMIX）'),
    ('Other',   N'其他',       'MES',  99, N'未分类表')
) AS source (DomainCode, DomainName, DbName, DisplayOrder, [Description])
ON target.DomainCode = source.DomainCode
WHEN MATCHED THEN
    UPDATE SET DomainName = source.DomainName, [Description] = source.[Description]
WHEN NOT MATCHED THEN
    INSERT (DomainCode, DomainName, DbName, DisplayOrder, [Description])
    VALUES (source.DomainCode, source.DomainName, source.DbName, source.DisplayOrder, source.[Description]);");

        await conn.ExecuteAsync(@"
IF NOT EXISTS (SELECT * FROM sys.indexes WHERE name = 'IX_SchemaTable_Domain')
    CREATE INDEX IX_SchemaTable_Domain ON SchemaTable(DomainCode);");

        await conn.ExecuteAsync(@"
IF NOT EXISTS (SELECT * FROM sys.indexes WHERE name = 'IX_SchemaColumn_Table')
    CREATE INDEX IX_SchemaColumn_Table ON SchemaColumn(TableName, DbName);");

        await conn.ExecuteAsync(@"
IF NOT EXISTS (SELECT * FROM sys.indexes WHERE name = 'IX_SchemaRelation_Parent')
    CREATE INDEX IX_SchemaRelation_Parent ON SchemaRelation(ParentTable, DbName);");

        // 双语支持：补充 DescriptionEn 字段（已存在的表升级用）
        await conn.ExecuteAsync(@"
IF NOT EXISTS (SELECT * FROM sys.columns WHERE name = 'DescriptionEn' AND object_id = OBJECT_ID('SchemaTable'))
    ALTER TABLE SchemaTable ADD DescriptionEn NVARCHAR(1000);");

        await conn.ExecuteAsync(@"
IF NOT EXISTS (SELECT * FROM sys.columns WHERE name = 'DescriptionEn' AND object_id = OBJECT_ID('SchemaColumn'))
    ALTER TABLE SchemaColumn ADD DescriptionEn NVARCHAR(1000);");
    }

    /// <summary>
    /// 根据表名前缀和数据库推断业务域。
    /// 规则来自现有 config 工具、MES/IRIS 命名惯例。
    /// </summary>
    private static (string Code, string SuggestName) InferDomain(string tableName, string dbName)
    {
        var t = tableName.ToUpperInvariant();
        var db = dbName.ToUpperInvariant();

        // ---- IRIS 特有规则 ----
        if (db == "IRIS")
        {
            if (t.StartsWith("BPM_MOLDING_") || t.StartsWith("CIM_MOULD_") || t.StartsWith("CPP_MOLD_") || t.StartsWith("MOLD_"))
                return ("Molding", "成型");
            if (t.StartsWith("CPP_CURING_") || t.StartsWith("CPP_SULF_"))
                return ("Curing", "硫化");
            if (t.StartsWith("BPM_SEMIS_") || t.StartsWith("HPP_SEMI_"))
                return ("Semi", "半制品");
            if (t.StartsWith("SBE_") || t.StartsWith("SBE_DEVICE") || t.StartsWith("SBE_EQUIP_") || t.StartsWith("TB_EQ_EQUIP") || t.StartsWith("TB_EQ_MOULD"))
                return ("Equip", "设备");
            if (t.StartsWith("FQ") && t.Length > 3 && t[3] == '_' && !t.StartsWith("FQI_"))
                return ("Quality", "质量");
            if (t.StartsWith("BPM_STORE_") || t.StartsWith("PSB_") || t.StartsWith("PSM_"))
                return ("Stock", "库存");
            if (t.StartsWith("BAS_") || t.StartsWith("BASIC") || t.StartsWith("CBM_"))
                return ("Base", "基础数据");
            if (t.StartsWith("SSB_"))
                return ("Base", "基础数据");
            if (t.StartsWith("SBM_"))
                return ("Base", "基础数据");
            if (t.StartsWith("SSP_"))
                return ("Perm", "权限");
            if (t.StartsWith("HRT_") || t.StartsWith("RDM_") || t.StartsWith("BOM_") || t.StartsWith("TB_TE_"))
                return ("Tech", "技术配方");
            if (t.StartsWith("INTERFACE_SAP_") || t.StartsWith("ITF_MES_") || t.StartsWith("ITF_BPM_") || t.StartsWith("ITF_HPP_"))
                return ("Sap", "SAP接口");
            if (t.StartsWith("AGV_"))
                return ("Other", "其他");
        }

        // ---- IRISMIX 特有规则 ----
        if (db == "IRISMIX")
        {
            if (t.StartsWith("MOY_") || t.StartsWith("MOY_") || t.StartsWith("PMT_") || t.StartsWith("PPT_") ||
                (t.StartsWith("PPM_") && (t.Contains("RUB") || t.Contains("MIX") || t.Contains("MJ"))))
                return ("Mix", "密炼");
            if (t.StartsWith("EQM_") || t.StartsWith("EQUIP_"))
                return ("Equip", "设备");
            if (t.StartsWith("QMM_") || t.StartsWith("QMT_") || t.StartsWith("QRT_") || t.StartsWith("QUA_") || t.StartsWith("JCZL_"))
                return ("Quality", "质量");
            if (t.StartsWith("PMM_") || t.StartsWith("PST_") || t.StartsWith("PWM_") || t.StartsWith("BAS_STOCK"))
                return ("Stock", "库存");
            if (t.StartsWith("BAS_") || t.StartsWith("SYS_"))
                return ("Base", "基础数据");
            if (t.StartsWith("SSB_"))
                return ("Base", "基础数据");
            if (t.StartsWith("RDM_"))
                return ("Tech", "技术配方");
            if (t.StartsWith("COST_"))
                return ("Other", "其他");
            if (t.StartsWith("INTERFACE_") || t.StartsWith("ITF_") || t.StartsWith("PPT_SAP_INTERFACE"))
                return ("Sap", "SAP接口");
        }

        // ---- ykhm 原有规则 ----
        if (t.StartsWith("PMT_") || t.StartsWith("PMM_") || t.StartsWith("PPT_") || t.StartsWith("QMM_"))
            return ("Mix", "密炼");
        if (t.StartsWith("SBE_"))
            return ("Equip", "设备");
        if (t.StartsWith("SSB_"))
            return ("Base", "基础数据");
        if (t.StartsWith("SSP_"))
            return ("Perm", "权限");
        if (t.StartsWith("BAS_"))
            return ("Base", "基础数据");
        if (t.StartsWith("PPM_") || t.StartsWith("PMI_"))
            return ("Semi", "半制品");
        if (t.StartsWith("PSM_"))
            return ("Molding", "成型");

        return ("Other", "其他");
    }

    private class TableInfo
    {
        public string TableSchema { get; set; } = string.Empty;
        public string TableName { get; set; } = string.Empty;
        public string? Description { get; set; }
    }

    private class ColumnInfo
    {
        public string TableName { get; set; } = string.Empty;
        public string ColumnName { get; set; } = string.Empty;
        public string DataType { get; set; } = string.Empty;
        public int? MaxLength { get; set; }
        public bool IsNullable { get; set; }
        public bool IsPk { get; set; }
        public string? Description { get; set; }
    }

    private class RelationInfo
    {
        public string? RelationName { get; set; }
        public string ParentTable { get; set; } = string.Empty;
        public string ParentColumn { get; set; } = string.Empty;
        public string ReferencedTable { get; set; } = string.Empty;
        public string ReferencedColumn { get; set; } = string.Empty;
    }
}

public class SyncResult
{
    public int Tables { get; set; }
    public int Columns { get; set; }
    public int Relations { get; set; }
    public List<string> Errors { get; set; } = new();
}
