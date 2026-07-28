package com.iris.sql;

import java.sql.Connection;
import java.sql.SQLException;

/**
 * 一个可绑定的外部数据连接。实现负责凭据与物理连接，Catalog 只暴露安全 metadata。
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
