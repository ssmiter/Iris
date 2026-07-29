package com.iris.sql;

import java.sql.Connection;
import java.sql.SQLException;

/**
 * 一个可绑定的外部数据连接。实现负责凭据与物理连接，Catalog 只暴露安全 metadata。
 * 声明 READ_ONLY 的实现必须由数据库账号、连接模式或 session 策略兑现只读，
 * 不能只依赖调用方分析 SQL 文本。
 */
public interface SqlConnectionProvider {

    Definition definition();

    Connection open() throws SQLException;

    enum Dialect {
        SQLITE,
        SQL_SERVER,
        POSTGRESQL,
        MYSQL,
        GENERIC
    }

    enum AccessMode {
        READ_ONLY,
        READ_WRITE
    }

    record Definition(
            String id,
            String title,
            String description,
            Dialect dialect,
            AccessMode accessMode
    ) {
    }
}
