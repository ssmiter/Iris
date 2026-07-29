package com.iris.sql;

import com.iris.sql.SqlConnectionProvider.Definition;
import org.springframework.stereotype.Component;

import java.sql.Connection;
import java.sql.DriverManager;
import java.sql.SQLException;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Optional;
import java.util.Properties;
import java.util.regex.Pattern;

import com.iris.tools.core.ToolRuntimeException;

/**
 * SQL Connection Definition → 当前 provider binding 的唯一目录。
 */
@Component
public class SqlConnectionCatalog {

    private static final Pattern ID =
            Pattern.compile("[a-z][a-z0-9]*(?:[_-][a-z0-9]+)*");

    private final Map<String, SqlConnectionProvider> providers;

    public SqlConnectionCatalog(
            List<SqlConnectionProvider> discovered,
            IrisSqlProperties properties
    ) {
        Map<String, SqlConnectionProvider> accepted = new LinkedHashMap<>();
        discovered.stream()
                .sorted(java.util.Comparator.comparing(
                        provider -> provider.definition().id()
                ))
                .forEach(provider -> {
                    Definition definition = requireValid(
                            provider.definition()
                    );
                    SqlConnectionProvider previous = accepted.putIfAbsent(
                            definition.id(),
                            provider
                    );
                    if (previous != null) {
                        throw new IllegalStateException(
                                "SQL connection id conflict: "
                                        + definition.id()
                            );
                    }
                });
        properties.getConnections().entrySet().stream()
                .sorted(Map.Entry.comparingByKey())
                .forEach(entry -> {
                    SqlConnectionProvider provider = configured(
                            entry.getKey(),
                            entry.getValue()
                    );
                    Definition definition = requireValid(
                            provider.definition()
                    );
                    SqlConnectionProvider previous = accepted.putIfAbsent(
                            definition.id(),
                            provider
                    );
                    if (previous != null) {
                        throw new IllegalStateException(
                                "SQL connection id conflict: "
                                        + definition.id()
                        );
                    }
                });
        this.providers = Map.copyOf(accepted);
    }

    public Optional<SqlConnectionProvider> find(String connectionId) {
        return Optional.ofNullable(providers.get(connectionId));
    }

    public SqlConnectionProvider requireReadOnly(String connectionId) {
        SqlConnectionProvider provider = find(connectionId)
                .orElseThrow(() -> new ToolRuntimeException(
                        "sql_connection_not_found",
                        "找不到 SQL 连接 " + connectionId
                                + "；先调用 list_sql_connections 查看可用对象"
                ));
        if (provider.definition().accessMode()
                != SqlConnectionProvider.AccessMode.READ_ONLY) {
            throw new ToolRuntimeException(
                    "sql_connection_not_read_only",
                    "连接 " + connectionId
                            + " 未声明为 read_only，只读 SQL 能力拒绝使用"
            );
        }
        return provider;
    }

    public List<Definition> definitions() {
        return providers.values().stream()
                .map(SqlConnectionProvider::definition)
                .sorted(java.util.Comparator.comparing(Definition::id))
                .toList();
    }

    private SqlConnectionProvider configured(
            String id,
            IrisSqlProperties.ConnectionSettings settings
    ) {
        if (settings == null
                || settings.getUrl() == null
                || settings.getUrl().isBlank()) {
            throw new IllegalStateException(
                    "SQL connection " + id + " is missing url"
            );
        }
        Definition definition = new Definition(
                id,
                settings.getTitle(),
                settings.getDescription(),
                settings.getDialect(),
                settings.getAccessMode()
        );
        Properties jdbcProperties = new Properties();
        jdbcProperties.putAll(settings.getProperties());
        if (settings.getUsername() != null
                && !settings.getUsername().isBlank()) {
            jdbcProperties.setProperty("user", settings.getUsername());
        }
        if (settings.getPassword() != null) {
            jdbcProperties.setProperty("password", settings.getPassword());
        }
        return new ConfiguredProvider(
                definition,
                settings.getUrl(),
                jdbcProperties
        );
    }

    private Definition requireValid(Definition definition) {
        if (definition == null
                || definition.id() == null
                || !ID.matcher(definition.id()).matches()
                || definition.title() == null
                || definition.title().isBlank()
                || definition.description() == null
                || definition.description().isBlank()
                || definition.dialect() == null
                || definition.accessMode() == null) {
            throw new IllegalStateException(
                    "SQL connection definition is incomplete"
            );
        }
        return definition;
    }

    private record ConfiguredProvider(
            Definition definition,
            String jdbcUrl,
            Properties jdbcProperties
    ) implements SqlConnectionProvider {

        private ConfiguredProvider {
            jdbcProperties = copy(jdbcProperties);
        }

        @Override
        public Connection open() throws SQLException {
            return DriverManager.getConnection(
                    jdbcUrl,
                    copy(jdbcProperties)
            );
        }

        private static Properties copy(Properties source) {
            Properties copy = new Properties();
            copy.putAll(source);
            return copy;
        }
    }
}
