package com.iris.mcp;

import com.fasterxml.jackson.core.JsonProcessingException;
import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.node.ObjectNode;
import com.iris.storage.ManagedObjectStore;
import com.iris.tools.core.CommittedOperation;
import com.iris.tools.core.PreparedOperation;
import com.iris.tools.core.RiskLevel;
import com.iris.tools.core.Tool;
import com.iris.tools.core.ToolContext;
import com.iris.tools.core.ToolManifest;
import com.iris.tools.core.ToolOutcome;
import com.iris.tools.core.ToolRegistry;
import com.iris.tools.core.VerificationResult;
import org.springframework.boot.context.event.ApplicationReadyEvent;
import org.springframework.context.event.EventListener;
import org.springframework.jdbc.core.simple.JdbcClient;
import org.springframework.stereotype.Service;
import org.springframework.transaction.support.TransactionTemplate;

import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.security.NoSuchAlgorithmException;
import java.time.Clock;
import java.time.Instant;
import java.util.ArrayList;
import java.util.HashSet;
import java.util.HexFormat;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.UUID;
import java.util.concurrent.CompletableFuture;
import java.util.concurrent.ConcurrentHashMap;
import java.util.regex.Pattern;

/** Dynamic MCP connector lifecycle projected into the ordinary ToolRegistry. */
@Service
public class McpServerService {
    private static final Pattern SLUG = Pattern.compile(
            "[a-z][a-z0-9]*(?:_[a-z0-9]+)*"
    );
    private static final Pattern ENVIRONMENT_NAME = Pattern.compile(
            "[A-Z_][A-Z0-9_]*"
    );
    private static final String TRANSPORT = "streamable_http";

    private final JdbcClient jdbc;
    private final ObjectMapper objectMapper;
    private final ManagedObjectStore objects;
    private final ToolRegistry registry;
    private final McpHttpClient client;
    private final TransactionTemplate transactions;
    private final Map<String, LiveConnection> live = new ConcurrentHashMap<>();
    private final Clock clock = Clock.systemUTC();

    public McpServerService(
            JdbcClient jdbc,
            ObjectMapper objectMapper,
            ManagedObjectStore objects,
            ToolRegistry registry,
            McpHttpClient client,
            TransactionTemplate transactions
    ) {
        this.jdbc = jdbc;
        this.objectMapper = objectMapper;
        this.objects = objects;
        this.registry = registry;
        this.client = client;
        this.transactions = transactions;
    }

    public List<ServerView> list() {
        return jdbc.sql("""
                SELECT * FROM mcp_server
                ORDER BY lower(display_name), slug
                """)
                .query(this::mapServer)
                .list();
    }

    public ServerView require(String serverId) {
        return jdbc.sql("SELECT * FROM mcp_server WHERE server_id = :id")
                .param("id", serverId)
                .query(this::mapServer)
                .optional()
                .orElseThrow(() -> new IllegalArgumentException(
                        "MCP server not found: " + serverId
                ));
    }

    public List<ToolView> tools(String serverId) {
        require(serverId);
        return jdbc.sql("""
                SELECT * FROM mcp_server_tool
                WHERE server_id = :serverId AND active = 1
                ORDER BY local_name
                """)
                .param("serverId", serverId)
                .query((rs, row) -> new ToolView(
                        rs.getString("remote_name"),
                        rs.getString("local_name"),
                        rs.getString("capability_path"),
                        rs.getString("description"),
                        rs.getString("risk_level"),
                        rs.getString("manifest_hash")
                ))
                .list();
    }

    public ServerView create(ServerDraft draft) {
        ServerDraft valid = validate(draft);
        String id = "mcp_" + UUID.randomUUID().toString().replace("-", "");
        Instant now = clock.instant();
        jdbc.sql("""
                INSERT INTO mcp_server(
                    server_id, slug, display_name, transport, endpoint,
                    authorization_env, enabled, connection_state,
                    tool_count, version, created_at, updated_at
                ) VALUES (
                    :id, :slug, :displayName, :transport, :endpoint,
                    :authorizationEnv, :enabled, :state,
                    0, 1, :now, :now
                )
                """)
                .param("id", id)
                .param("slug", valid.slug())
                .param("displayName", valid.displayName())
                .param("transport", TRANSPORT)
                .param("endpoint", valid.endpoint())
                .param("authorizationEnv", valid.authorizationEnv())
                .param("enabled", valid.enabled() ? 1 : 0)
                .param("state", valid.enabled() ? "pending" : "disabled")
                .param("now", now.toString())
                .update();
        if (valid.enabled()) {
            refresh(id);
        }
        return require(id);
    }

    public ServerView update(
            String serverId,
            int expectedVersion,
            ServerDraft draft
    ) {
        require(serverId);
        ServerDraft valid = validate(draft);
        Instant now = clock.instant();
        int updated = jdbc.sql("""
                UPDATE mcp_server
                SET slug = :slug,
                    display_name = :displayName,
                    endpoint = :endpoint,
                    authorization_env = :authorizationEnv,
                    enabled = :enabled,
                    connection_state = :state,
                    last_error = NULL,
                    version = version + 1,
                    updated_at = :now
                WHERE server_id = :id AND version = :expectedVersion
                """)
                .param("slug", valid.slug())
                .param("displayName", valid.displayName())
                .param("endpoint", valid.endpoint())
                .param("authorizationEnv", valid.authorizationEnv())
                .param("enabled", valid.enabled() ? 1 : 0)
                .param("state", valid.enabled() ? "pending" : "disabled")
                .param("now", now.toString())
                .param("id", serverId)
                .param("expectedVersion", expectedVersion)
                .update();
        if (updated != 1) {
            throw new IllegalStateException(
                    "MCP server changed; refresh before editing"
            );
        }
        unload(serverId, "configuration changed");
        if (valid.enabled()) {
            refresh(serverId);
        }
        return require(serverId);
    }

    public ServerView setEnabled(
            String serverId,
            int expectedVersion,
            boolean enabled
    ) {
        require(serverId);
        Instant now = clock.instant();
        int updated = jdbc.sql("""
                UPDATE mcp_server
                SET enabled = :enabled,
                    connection_state = :state,
                    last_error = NULL,
                    version = version + 1,
                    updated_at = :now
                WHERE server_id = :id AND version = :expectedVersion
                """)
                .param("enabled", enabled ? 1 : 0)
                .param("state", enabled ? "pending" : "disabled")
                .param("now", now.toString())
                .param("id", serverId)
                .param("expectedVersion", expectedVersion)
                .update();
        if (updated != 1) {
            throw new IllegalStateException(
                    "MCP server changed; refresh before toggling"
            );
        }
        if (enabled) {
            refresh(serverId);
        } else {
            unload(serverId, "server disabled");
        }
        return require(serverId);
    }

    public ServerView refresh(String serverId) {
        ServerView server = require(serverId);
        if (!server.enabled()) {
            unload(serverId, "server disabled");
            return require(serverId);
        }
        markState(serverId, "connecting", null, null, null, null, 0);
        try {
            String token = authorizationToken(server.authorizationEnv());
            McpHttpClient.Discovery discovery = client.connect(
                    server.endpoint(), token
            );
            List<DiscoveredTool> tools = discoveredTools(server, discovery);
            registry.replaceExternal(
                    providerKey(serverId),
                    tools.stream()
                            .map(tool -> new ToolRegistry.ExternalToolRegistration(
                                    tool.capabilityPath(), tool.tool()
                            ))
                            .toList(),
                    objectMapper
            );
            live.put(serverId, new LiveConnection(
                    server.endpoint(), token, discovery.sessionId()
            ));
            persistDiscovery(server, discovery, tools);
        } catch (Exception exception) {
            unload(serverId, "connection failed");
            String state = missingCredential(exception)
                    ? "needs_auth" : "failed";
            markState(
                    serverId, state, safeMessage(exception),
                    null, null, null, 0
            );
        }
        return require(serverId);
    }

    @EventListener(ApplicationReadyEvent.class)
    public void reconnectEnabledServers() {
        list().stream().filter(ServerView::enabled).forEach(server ->
                CompletableFuture.runAsync(() -> refresh(server.serverId()))
        );
    }

    private List<DiscoveredTool> discoveredTools(
            ServerView server,
            McpHttpClient.Discovery discovery
    ) {
        List<DiscoveredTool> result = new ArrayList<>();
        HashSet<String> names = new HashSet<>();
        for (JsonNode remote : discovery.tools()) {
            String remoteName = requiredRemoteText(remote, "name", 240);
            String normalizedRemote = normalize(remoteName);
            String localName = "mcp_" + server.slug() + "_" + normalizedRemote;
            if (!names.add(localName)) {
                throw new IllegalStateException(
                        "MCP tools collide after name normalization: " + localName
                );
            }
            String description = remote.path("description").asText().trim();
            if (description.isBlank()) {
                description = "MCP tool " + remoteName
                        + " provided by " + server.displayName();
            }
            JsonNode inputSchema = normalizedInputSchema(
                    remote.path("inputSchema")
            );
            RiskLevel risk = risk(remote.path("annotations"));
            ToolManifest.SideEffect sideEffect = risk == RiskLevel.READ_ONLY
                    ? ToolManifest.SideEffect.NONE
                    : risk == RiskLevel.DESTRUCTIVE
                            ? ToolManifest.SideEffect.DESTRUCTIVE
                            : ToolManifest.SideEffect.EXTERNAL_WRITE;
            String capabilityId = "iris.mcp." + server.serverId()
                    + "." + normalizedRemote;
            String path = "/connectors/mcp/" + server.slug()
                    + "/" + normalizedRemote;
            String definitionVersion = definitionVersion(
                    remoteName, description, inputSchema, risk, path
            );
            JsonNode outputSchema = outputSchema();
            ToolManifest manifest = new ToolManifest(
                    capabilityId,
                    definitionVersion,
                    localName,
                    description,
                    inputSchema,
                    outputSchema,
                    risk,
                    sideEffect,
                    60,
                    80_000,
                    idempotency(remote.path("annotations")),
                    ToolManifest.EvidencePolicy.REQUIRED,
                    ToolManifest.ContextRetention.REFETCHABLE,
                    risk == RiskLevel.READ_ONLY
                            ? ToolManifest.ConcurrencySemantics.PARALLEL_SAFE
                            : ToolManifest.ConcurrencySemantics.SERIAL,
                    risk == RiskLevel.READ_ONLY
                            ? ToolManifest.CancellationSemantics.COOPERATIVE
                            : ToolManifest.CancellationSemantics.COMMIT_BOUNDARY
            );
            result.add(new DiscoveredTool(
                    remoteName,
                    path,
                    new RemoteMcpTool(
                            server.serverId(), remoteName, manifest
                    )
            ));
        }
        return List.copyOf(result);
    }

    private void persistDiscovery(
            ServerView server,
            McpHttpClient.Discovery discovery,
            List<DiscoveredTool> tools
    ) throws IOException {
        Instant now = clock.instant();
        List<PersistedDefinition> definitions = new ArrayList<>();
        for (DiscoveredTool discovered : tools) {
            ToolManifest manifest = discovered.tool().manifest();
            String snapshotJson;
            try {
                ObjectNode snapshot = objectMapper.createObjectNode();
                snapshot.set("manifest", objectMapper.valueToTree(manifest));
                snapshot.put("capabilityPath", discovered.capabilityPath());
                snapshot.put("provider", "mcp");
                snapshot.put("serverId", server.serverId());
                snapshot.put("remoteName", discovered.remoteName());
                snapshotJson = objectMapper.writeValueAsString(snapshot);
            } catch (JsonProcessingException exception) {
                throw new IllegalStateException(
                        "Unable to serialize MCP tool definition", exception
                );
            }
            var stored = objects.putUtf8(snapshotJson);
            String manifestHash = registry.find(manifest.name())
                    .orElseThrow(() -> new IllegalStateException(
                            "MCP tool disappeared during discovery commit"
                    ))
                    .manifestHash();
            definitions.add(new PersistedDefinition(
                    discovered, manifestHash, stored.objectRef(),
                    stored.contentHash()
            ));
        }
        transactions.executeWithoutResult(tx -> {
            markBindingsUnavailable(server.serverId(), now);
            jdbc.sql("""
                    UPDATE mcp_server_tool SET active = 0, updated_at = :now
                    WHERE server_id = :serverId
                    """)
                    .param("now", now.toString())
                    .param("serverId", server.serverId())
                    .update();
            for (PersistedDefinition definition : definitions) {
                ToolManifest manifest = definition.discovered().tool().manifest();
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
                            :snapshotRef, :snapshotHash, :now, :now
                        )
                        ON CONFLICT(capability_id, definition_version)
                        DO UPDATE SET last_seen_at = excluded.last_seen_at
                        """)
                        .param("id", manifest.id())
                        .param("version", manifest.version())
                        .param("name", manifest.name())
                        .param("path", definition.discovered().capabilityPath())
                        .param("description", manifest.description())
                        .param("risk", manifest.riskLevel().name().toLowerCase(Locale.ROOT))
                        .param("manifestHash", definition.manifestHash())
                        .param("snapshotRef", definition.snapshotRef())
                        .param("snapshotHash", definition.snapshotHash())
                        .param("now", now.toString())
                        .update();
                jdbc.sql("""
                        INSERT INTO capability_binding_state(
                            capability_id, definition_version, provider_key,
                            availability, checked_at, last_seen_at
                        ) VALUES (
                            :id, :version, :provider,
                            'available', :now, :now
                        )
                        ON CONFLICT(capability_id, definition_version, provider_key)
                        DO UPDATE SET availability = 'available',
                                      checked_at = excluded.checked_at,
                                      last_seen_at = excluded.last_seen_at
                        """)
                        .param("id", manifest.id())
                        .param("version", manifest.version())
                        .param("provider", providerKey(server.serverId()))
                        .param("now", now.toString())
                        .update();
                jdbc.sql("""
                        INSERT INTO mcp_server_tool(
                            server_id, remote_name, local_name, capability_id,
                            definition_version, capability_path, description,
                            risk_level, manifest_hash, active, updated_at
                        ) VALUES (
                            :serverId, :remoteName, :localName, :capabilityId,
                            :definitionVersion, :path, :description,
                            :risk, :manifestHash, 1, :now
                        )
                        ON CONFLICT(server_id, remote_name) DO UPDATE SET
                            local_name = excluded.local_name,
                            capability_id = excluded.capability_id,
                            definition_version = excluded.definition_version,
                            capability_path = excluded.capability_path,
                            description = excluded.description,
                            risk_level = excluded.risk_level,
                            manifest_hash = excluded.manifest_hash,
                            active = 1,
                            updated_at = excluded.updated_at
                        """)
                        .param("serverId", server.serverId())
                        .param("remoteName", definition.discovered().remoteName())
                        .param("localName", manifest.name())
                        .param("capabilityId", manifest.id())
                        .param("definitionVersion", manifest.version())
                        .param("path", definition.discovered().capabilityPath())
                        .param("description", manifest.description())
                        .param("risk", manifest.riskLevel().name().toLowerCase(Locale.ROOT))
                        .param("manifestHash", definition.manifestHash())
                        .param("now", now.toString())
                        .update();
            }
            markState(
                    server.serverId(), "connected", null,
                    discovery.protocolVersion(), discovery.serverName(),
                    discovery.serverVersion(), definitions.size()
            );
            jdbc.sql("""
                    UPDATE mcp_server SET instructions = :instructions
                    WHERE server_id = :serverId
                    """)
                    .param("instructions", boundedNullable(
                            discovery.instructions(), 4_000
                    ))
                    .param("serverId", server.serverId())
                    .update();
        });
    }

    private void unload(String serverId, String reason) {
        registry.unregisterExternal(providerKey(serverId));
        live.remove(serverId);
        Instant now = clock.instant();
        transactions.executeWithoutResult(tx -> {
            markBindingsUnavailable(serverId, now);
            jdbc.sql("""
                    UPDATE mcp_server_tool
                    SET active = 0, updated_at = :now
                    WHERE server_id = :serverId
                    """)
                    .param("now", now.toString())
                    .param("serverId", serverId)
                    .update();
        });
    }

    private void markBindingsUnavailable(String serverId, Instant now) {
        jdbc.sql("""
                UPDATE capability_binding_state
                SET availability = 'unavailable', checked_at = :now
                WHERE provider_key = :provider
                """)
                .param("now", now.toString())
                .param("provider", providerKey(serverId))
                .update();
    }

    private void markState(
            String serverId,
            String state,
            String error,
            String protocolVersion,
            String remoteName,
            String remoteVersion,
            int toolCount
    ) {
        Instant now = clock.instant();
        jdbc.sql("""
                UPDATE mcp_server
                SET connection_state = :state,
                    last_error = :error,
                    protocol_version = COALESCE(:protocol, protocol_version),
                    remote_server_name = COALESCE(:remoteName, remote_server_name),
                    remote_server_version = COALESCE(:remoteVersion, remote_server_version),
                    tool_count = :toolCount,
                    updated_at = :now,
                    checked_at = :now
                WHERE server_id = :serverId
                """)
                .param("state", state)
                .param("error", error)
                .param("protocol", protocolVersion)
                .param("remoteName", remoteName)
                .param("remoteVersion", remoteVersion)
                .param("toolCount", toolCount)
                .param("now", now.toString())
                .param("serverId", serverId)
                .update();
    }

    private ServerView mapServer(java.sql.ResultSet rs, int row)
            throws java.sql.SQLException {
        return new ServerView(
                rs.getString("server_id"),
                rs.getString("slug"),
                rs.getString("display_name"),
                rs.getString("transport"),
                rs.getString("endpoint"),
                rs.getString("authorization_env"),
                rs.getInt("enabled") == 1,
                rs.getString("connection_state"),
                rs.getString("protocol_version"),
                rs.getString("remote_server_name"),
                rs.getString("remote_server_version"),
                rs.getString("instructions"),
                rs.getInt("tool_count"),
                rs.getString("last_error"),
                rs.getInt("version"),
                Instant.parse(rs.getString("created_at")),
                Instant.parse(rs.getString("updated_at")),
                rs.getString("checked_at") == null
                        ? null : Instant.parse(rs.getString("checked_at"))
        );
    }

    private ServerDraft validate(ServerDraft draft) {
        if (draft == null || draft.slug() == null
                || !SLUG.matcher(draft.slug().trim()).matches()) {
            throw new IllegalArgumentException(
                    "MCP slug must be snake_case"
            );
        }
        String displayName = bounded(draft.displayName(), "displayName", 120);
        String endpoint = bounded(draft.endpoint(), "endpoint", 2_000);
        URIValidator.requireHttpEndpoint(endpoint);
        String authorizationEnv = draft.authorizationEnv() == null
                || draft.authorizationEnv().isBlank()
                ? null : draft.authorizationEnv().trim();
        if (authorizationEnv != null
                && !ENVIRONMENT_NAME.matcher(authorizationEnv).matches()) {
            throw new IllegalArgumentException(
                    "authorizationEnv must name an environment variable"
            );
        }
        return new ServerDraft(
                draft.slug().trim(), displayName, endpoint,
                authorizationEnv, draft.enabled()
        );
    }

    private String authorizationToken(String environmentName) {
        if (environmentName == null || environmentName.isBlank()) {
            return null;
        }
        String token = System.getenv(environmentName);
        if (token == null || token.isBlank()) {
            throw new MissingCredentialException(
                    "Environment variable " + environmentName + " is not set"
            );
        }
        return token;
    }

    private JsonNode normalizedInputSchema(JsonNode source) {
        ObjectNode schema = source != null && source.isObject()
                ? source.deepCopy() : objectMapper.createObjectNode();
        schema.put("type", "object");
        if (!schema.path("properties").isObject()) {
            schema.set("properties", objectMapper.createObjectNode());
        }
        ObjectNode properties = schema.withObject("properties");
        List<String> propertyNames = new ArrayList<>();
        properties.fieldNames().forEachRemaining(propertyNames::add);
        for (String name : propertyNames) {
            JsonNode property = properties.path(name);
            if (!property.isObject()) {
                ObjectNode normalized = objectMapper.createObjectNode();
                normalized.put("description", "Argument " + name);
                if (property.isBoolean() && !property.asBoolean()) {
                    normalized.set("not", objectMapper.createObjectNode());
                }
                properties.set(name, normalized);
            } else if (property.path("description").asText().isBlank()) {
                ((ObjectNode) property).put(
                        "description", "Argument " + name
                );
            }
        }
        return schema;
    }

    private JsonNode outputSchema() {
        ObjectNode schema = objectMapper.createObjectNode();
        schema.put("type", "object");
        schema.put("additionalProperties", true);
        ObjectNode properties = schema.putObject("properties");
        properties.putObject("content")
                .put("type", "array")
                .put("description", "MCP content blocks returned by the server");
        properties.putObject("structuredContent")
                .put("type", "object")
                .put("description", "Optional structured MCP result");
        properties.putObject("isError")
                .put("type", "boolean")
                .put("description", "Whether the MCP server reported a tool error");
        return schema;
    }

    private RiskLevel risk(JsonNode annotations) {
        if (annotations.path("readOnlyHint").asBoolean(false)) {
            return RiskLevel.READ_ONLY;
        }
        if (annotations.path("destructiveHint").asBoolean(false)) {
            return RiskLevel.DESTRUCTIVE;
        }
        return RiskLevel.ELEVATED;
    }

    private ToolManifest.IdempotencySemantics idempotency(
            JsonNode annotations
    ) {
        return annotations.path("idempotentHint").asBoolean(false)
                ? ToolManifest.IdempotencySemantics.IDEMPOTENT
                : ToolManifest.IdempotencySemantics.NON_IDEMPOTENT;
    }

    private String definitionVersion(
            String name,
            String description,
            JsonNode inputSchema,
            RiskLevel risk,
            String capabilityPath
    ) {
        return hash(name + "\n" + description + "\n"
                + inputSchema + "\n" + risk + "\n" + capabilityPath)
                .substring(0, 16);
    }

    private String normalize(String value) {
        String normalized = value.toLowerCase(Locale.ROOT)
                .replaceAll("[^a-z0-9]+", "_")
                .replaceAll("^_+|_+$", "")
                .replaceAll("_+", "_");
        if (normalized.isBlank() || !Character.isLetter(normalized.charAt(0))) {
            normalized = "tool_" + normalized;
        }
        return normalized;
    }

    private String requiredRemoteText(JsonNode node, String field, int max) {
        String value = node.path(field).asText().trim();
        if (value.isBlank() || value.length() > max) {
            throw new IllegalStateException(
                    "MCP tool has invalid " + field
            );
        }
        return value;
    }

    private String providerKey(String serverId) {
        return "mcp:" + serverId;
    }

    private boolean missingCredential(Exception exception) {
        Throwable current = exception;
        while (current != null) {
            if (current instanceof MissingCredentialException) {
                return true;
            }
            if (current instanceof McpHttpClient.McpProtocolException protocol
                    && ("http_401".equals(protocol.code())
                    || "http_403".equals(protocol.code()))) {
                return true;
            }
            current = current.getCause();
        }
        return false;
    }

    private String safeMessage(Exception exception) {
        String message = exception.getMessage();
        return boundedNullable(
                message == null ? exception.getClass().getSimpleName() : message,
                1_000
        );
    }

    private String bounded(String value, String field, int maximum) {
        String normalized = value == null ? "" : value.trim();
        if (normalized.isBlank() || normalized.length() > maximum) {
            throw new IllegalArgumentException(
                    field + " must contain 1 to " + maximum + " characters"
            );
        }
        return normalized;
    }

    private String boundedNullable(String value, int maximum) {
        if (value == null) {
            return null;
        }
        String normalized = value.trim();
        return normalized.length() <= maximum
                ? normalized : normalized.substring(0, maximum);
    }

    private String hash(String value) {
        try {
            return HexFormat.of().formatHex(
                    MessageDigest.getInstance("SHA-256").digest(
                            value.getBytes(StandardCharsets.UTF_8)
                    )
            );
        } catch (NoSuchAlgorithmException exception) {
            throw new IllegalStateException("SHA-256 unavailable", exception);
        }
    }

    private final class RemoteMcpTool implements Tool {
        private final String serverId;
        private final String remoteName;
        private final ToolManifest manifest;

        private RemoteMcpTool(
                String serverId,
                String remoteName,
                ToolManifest manifest
        ) {
            this.serverId = serverId;
            this.remoteName = remoteName;
            this.manifest = manifest;
        }

        @Override
        public ToolManifest manifest() {
            return manifest;
        }

        @Override
        public PreparedOperation prepare(JsonNode input, ToolContext context) {
            String impact = manifest.riskLevel() == RiskLevel.READ_ONLY
                    ? "Read from MCP service using " + remoteName
                    : "Allow MCP service " + require(serverId).displayName()
                            + " to perform " + remoteName
                            + "; this may change external state";
            return new PreparedOperation(
                    input.deepCopy(), impact, List.of(),
                    Instant.now().plusSeconds(manifest.timeoutSeconds())
            );
        }

        @Override
        public ToolOutcome execute(
                CommittedOperation operation,
                ToolContext context
        ) {
            if (context.cancelled()) {
                return ToolOutcome.failed("cancelled", "MCP call was cancelled");
            }
            LiveConnection connection = live.get(serverId);
            if (connection == null) {
                return ToolOutcome.failed(
                        "mcp_not_connected",
                        "MCP server is not connected; refresh it in capability management"
                );
            }
            try {
                JsonNode result = client.call(
                        connection.endpoint(), connection.bearerToken(),
                        connection.sessionId(), remoteName,
                        operation.normalizedInput()
                );
                if (result.path("isError").asBoolean(false)) {
                    return ToolOutcome.failed(
                            "mcp_tool_error", summarizeMcpError(result)
                    );
                }
                return ToolOutcome.succeeded(result);
            } catch (Exception exception) {
                return ToolOutcome.failed(
                        "mcp_call_failed", safeMessage(exception)
                );
            }
        }

        @Override
        public VerificationResult verify(
                ToolOutcome outcome,
                CommittedOperation operation,
                ToolContext context
        ) {
            if (outcome.kind() != ToolOutcome.Kind.SUCCEEDED) {
                return new VerificationResult(
                        VerificationResult.Status.FAILED,
                        List.of(), outcome.message()
                );
            }
            return VerificationResult.confirmed(List.of(
                    new VerificationResult.Evidence(
                            "mcp_result",
                            "mcp://" + serverId + "/" + remoteName,
                            "MCP server returned a successful tool result"
                    )
            ));
        }

        private String summarizeMcpError(JsonNode result) {
            for (JsonNode block : result.path("content")) {
                if ("text".equals(block.path("type").asText())) {
                    return boundedNullable(
                            block.path("text").asText("MCP tool failed"), 1_000
                    );
                }
            }
            return "MCP tool reported an error";
        }
    }

    private record DiscoveredTool(
            String remoteName,
            String capabilityPath,
            RemoteMcpTool tool
    ) { }

    private record PersistedDefinition(
            DiscoveredTool discovered,
            String manifestHash,
            String snapshotRef,
            String snapshotHash
    ) { }

    private record LiveConnection(
            String endpoint,
            String bearerToken,
            String sessionId
    ) { }

    private static final class MissingCredentialException
            extends IllegalStateException {
        private MissingCredentialException(String message) {
            super(message);
        }
    }

    private static final class URIValidator {
        private static void requireHttpEndpoint(String value) {
            java.net.URI uri = java.net.URI.create(value);
            String scheme = uri.getScheme() == null
                    ? "" : uri.getScheme().toLowerCase(Locale.ROOT);
            if (!("http".equals(scheme) || "https".equals(scheme))
                    || uri.getHost() == null || uri.getUserInfo() != null) {
                throw new IllegalArgumentException(
                        "endpoint must be an http(s) URL without user info"
                );
            }
        }
    }

    public record ServerDraft(
            String slug,
            String displayName,
            String endpoint,
            String authorizationEnv,
            boolean enabled
    ) { }

    public record ServerView(
            String serverId,
            String slug,
            String displayName,
            String transport,
            String endpoint,
            String authorizationEnv,
            boolean enabled,
            String connectionState,
            String protocolVersion,
            String remoteServerName,
            String remoteServerVersion,
            String instructions,
            int toolCount,
            String lastError,
            int version,
            Instant createdAt,
            Instant updatedAt,
            Instant checkedAt
    ) { }

    public record ToolView(
            String remoteName,
            String localName,
            String capabilityPath,
            String description,
            String riskLevel,
            String manifestHash
    ) { }
}
