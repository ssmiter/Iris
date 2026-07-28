package com.iris.sql;

import com.iris.sql.SqlConnectionProvider.Definition;
import org.springframework.stereotype.Component;

import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Optional;
import java.util.regex.Pattern;

/**
 * SQL Connection Definition → 当前 provider binding 的唯一目录。
 */
@Component
public class SqlConnectionCatalog {

    private static final Pattern ID =
            Pattern.compile("[a-z][a-z0-9]*(?:[_-][a-z0-9]+)*");

    private final Map<String, SqlConnectionProvider> providers;

    public SqlConnectionCatalog(List<SqlConnectionProvider> discovered) {
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
        this.providers = Map.copyOf(accepted);
    }

    public Optional<SqlConnectionProvider> find(String connectionId) {
        return Optional.ofNullable(providers.get(connectionId));
    }

    public List<Definition> definitions() {
        return providers.values().stream()
                .map(SqlConnectionProvider::definition)
                .sorted(java.util.Comparator.comparing(Definition::id))
                .toList();
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
}
