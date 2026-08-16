package com.iris.storage;

import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.boot.ApplicationArguments;
import org.springframework.boot.ApplicationRunner;
import org.springframework.jdbc.core.simple.JdbcClient;
import org.springframework.stereotype.Component;

import javax.sql.DataSource;
import java.util.List;

/**
 * 既有数据库的就地列迁移。schema.sql 只 CREATE IF NOT EXISTS，无法为旧库补列；
 * 这里用 PRAGMA table_info 判定后 ALTER TABLE，幂等、无框架。
 *
 * <p>新增列时：先改 schema.sql（新库），再在这里登记一行（旧库）。只支持
 * ADD COLUMN 级别的演进；需要改表结构的迁移再引入真正的迁移工具。</p>
 */
@Component
public final class SchemaColumnMigration implements ApplicationRunner {
    private static final Logger log =
            LoggerFactory.getLogger(SchemaColumnMigration.class);

    private final JdbcClient jdbc;

    public SchemaColumnMigration(DataSource dataSource) {
        this.jdbc = JdbcClient.create(dataSource);
    }

    @Override
    public void run(ApplicationArguments args) {
        ensureColumn("iris_conversation", "archived_at", "TEXT");
    }

    private void ensureColumn(String table, String column, String ddlType) {
        List<String> columns = jdbc
                .sql("PRAGMA table_info(" + table + ")")
                .query((rs, rowNum) -> rs.getString("name"))
                .list();
        if (columns.contains(column)) {
            return;
        }
        jdbc.sql("ALTER TABLE " + table
                        + " ADD COLUMN " + column + " " + ddlType)
                .update();
        log.info("migrated schema: {}.{} added ({})", table, column, ddlType);
    }
}
