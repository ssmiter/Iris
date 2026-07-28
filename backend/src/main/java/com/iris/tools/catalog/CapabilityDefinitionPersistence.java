package com.iris.tools.catalog;

import com.fasterxml.jackson.core.JsonProcessingException;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.node.ObjectNode;
import com.iris.storage.ManagedObjectStore;
import com.iris.storage.ManagedObjectStore.StoredObject;
import com.iris.tools.core.ToolRegistry;
import com.iris.tools.core.ToolRegistry.ToolBinding;
import org.springframework.boot.ApplicationArguments;
import org.springframework.boot.ApplicationRunner;
import org.springframework.jdbc.core.simple.JdbcClient;
import org.springframework.stereotype.Component;
import org.springframework.transaction.support.TransactionTemplate;

import java.io.IOException;
import java.time.Clock;
import java.time.Instant;
import java.util.ArrayList;
import java.util.List;

/**
 * 把当前 Registry Definition 固化为可解释的历史快照。
 *
 * <p>Catalog 索引仍可重建；Definition identity 和曾经使用的 schema 不可丢。</p>
 */
@Component
public class CapabilityDefinitionPersistence
        implements ApplicationRunner {

    private static final String PROVIDER_KEY = "local-java";

    private final ToolRegistry registry;
    private final ObjectMapper objectMapper;
    private final ManagedObjectStore objects;
    private final JdbcClient jdbc;
    private final TransactionTemplate transactions;
    private final Clock clock = Clock.systemUTC();

    public CapabilityDefinitionPersistence(
            ToolRegistry registry,
            ObjectMapper objectMapper,
            ManagedObjectStore objects,
            JdbcClient jdbc,
            TransactionTemplate transactions
    ) {
        this.registry = registry;
        this.objectMapper = objectMapper;
        this.objects = objects;
        this.jdbc = jdbc;
        this.transactions = transactions;
    }

    @Override
    public void run(ApplicationArguments args) throws Exception {
        Instant now = clock.instant();
        List<DefinitionSnapshot> snapshots = new ArrayList<>();
        for (ToolBinding binding : registry.all()) {
            snapshots.add(snapshot(binding));
        }
        transactions.executeWithoutResult(status -> {
            markProviderBindingsUnavailable(now);
            for (DefinitionSnapshot snapshot : snapshots) {
                persistDefinition(snapshot, now);
                markBindingAvailable(snapshot, now);
            }
        });
    }

    private DefinitionSnapshot snapshot(ToolBinding binding)
            throws IOException {
        ObjectNode definition = objectMapper.createObjectNode();
        definition.put("kind", "tool");
        definition.put("capabilityPath", binding.capabilityPath());
        definition.set(
                "manifest",
                objectMapper.valueToTree(binding.manifest())
        );
        String json;
        try {
            json = objectMapper.writeValueAsString(definition);
        } catch (JsonProcessingException exception) {
            throw new IOException(
                    "Capability Definition cannot be serialized",
                    exception
            );
        }
        StoredObject stored = objects.putUtf8(json);
        return new DefinitionSnapshot(
                binding.manifest().id(),
                binding.manifest().version(),
                binding.manifest().name(),
                binding.capabilityPath(),
                binding.manifest().description(),
                binding.manifest().riskLevel().name().toLowerCase(),
                binding.manifestHash(),
                stored.objectRef(),
                stored.contentHash()
        );
    }

    private void persistDefinition(
            DefinitionSnapshot definition,
            Instant now
    ) {
        jdbc.sql("""
                INSERT INTO capability_definition(
                    capability_id, definition_version, kind, name,
                    capability_path, description, risk_level,
                    definition_status, manifest_hash,
                    snapshot_object_ref, snapshot_content_hash,
                    first_seen_at, last_seen_at
                ) VALUES (
                    :id, :version, 'tool', :name,
                    :path, :description, :risk,
                    'active', :manifestHash,
                    :objectRef, :contentHash,
                    :now, :now
                )
                ON CONFLICT(capability_id, definition_version)
                DO NOTHING
                """)
                .param("id", definition.id())
                .param("version", definition.version())
                .param("name", definition.name())
                .param("path", definition.path())
                .param("description", definition.description())
                .param("risk", definition.riskLevel())
                .param("manifestHash", definition.manifestHash())
                .param("objectRef", definition.objectRef())
                .param("contentHash", definition.contentHash())
                .param("now", now.toString())
                .update();

        String storedHash = jdbc.sql("""
                SELECT manifest_hash
                FROM capability_definition
                WHERE capability_id = :id
                  AND definition_version = :version
                """)
                .param("id", definition.id())
                .param("version", definition.version())
                .query(String.class)
                .single();
        if (!storedHash.equals(definition.manifestHash())) {
            throw new IllegalStateException(
                    "Capability Definition changed without a new version: "
                            + definition.id() + "@" + definition.version()
            );
        }
        jdbc.sql("""
                UPDATE capability_definition
                SET last_seen_at = :now
                WHERE capability_id = :id
                  AND definition_version = :version
                """)
                .param("now", now.toString())
                .param("id", definition.id())
                .param("version", definition.version())
                .update();
    }

    private void markProviderBindingsUnavailable(Instant now) {
        jdbc.sql("""
                UPDATE capability_binding_state
                SET availability = 'unavailable',
                    checked_at = :now
                WHERE provider_key = :providerKey
                """)
                .param("now", now.toString())
                .param("providerKey", PROVIDER_KEY)
                .update();
    }

    private void markBindingAvailable(
            DefinitionSnapshot definition,
            Instant now
    ) {
        jdbc.sql("""
                INSERT INTO capability_binding_state(
                    capability_id, definition_version, provider_key,
                    availability, checked_at, last_seen_at
                ) VALUES (
                    :id, :version, :providerKey,
                    'available', :now, :now
                )
                ON CONFLICT(
                    capability_id,
                    definition_version,
                    provider_key
                ) DO UPDATE SET
                    availability = 'available',
                    checked_at = excluded.checked_at,
                    last_seen_at = excluded.last_seen_at
                """)
                .param("id", definition.id())
                .param("version", definition.version())
                .param("providerKey", PROVIDER_KEY)
                .param("now", now.toString())
                .update();
    }

    private record DefinitionSnapshot(
            String id,
            String version,
            String name,
            String path,
            String description,
            String riskLevel,
            String manifestHash,
            String objectRef,
            String contentHash
    ) {
    }
}
