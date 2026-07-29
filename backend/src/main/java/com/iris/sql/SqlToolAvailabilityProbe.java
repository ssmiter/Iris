package com.iris.sql;

import com.iris.sql.SqlConnectionProvider.AccessMode;
import com.iris.tools.core.CapabilityAvailability.Status;
import com.iris.tools.core.ToolAvailabilityProbe;
import com.iris.tools.core.ToolRegistry.ToolBinding;
import org.springframework.stereotype.Component;

import java.util.Optional;
import java.util.Set;

/**
 * SQL Tool Definition 与当前 Connection 对象绑定之间的 availability。
 */
@Component
public class SqlToolAvailabilityProbe
        implements ToolAvailabilityProbe {

    private static final Set<String> REQUIRES_READ_ONLY_CONNECTION =
            Set.of("inspect_sql_schema", "query_sql");

    private final SqlConnectionCatalog connections;

    public SqlToolAvailabilityProbe(
            SqlConnectionCatalog connections
    ) {
        this.connections = connections;
    }

    @Override
    public Optional<Assessment> assess(ToolBinding binding) {
        String name = binding.manifest().name();
        if ("list_sql_connections".equals(name)) {
            return Optional.of(new Assessment(
                    Status.AVAILABLE,
                    "SQL Connection Catalog 可以读取"
            ));
        }
        if (!REQUIRES_READ_ONLY_CONNECTION.contains(name)) {
            return Optional.empty();
        }
        long readOnlyConnections = connections.definitions().stream()
                .filter(definition ->
                        definition.accessMode() == AccessMode.READ_ONLY)
                .count();
        if (readOnlyConnections == 0) {
            return Optional.of(new Assessment(
                    Status.UNAVAILABLE,
                    "当前没有配置 read_only SQL Connection 对象"
            ));
        }
        return Optional.of(new Assessment(
                Status.AVAILABLE,
                "当前有 " + readOnlyConnections
                        + " 个 read_only SQL Connection 对象"
        ));
    }
}
