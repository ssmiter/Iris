package com.iris.skill;

import com.fasterxml.jackson.core.JsonProcessingException;
import com.fasterxml.jackson.core.type.TypeReference;
import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.node.ObjectNode;
import com.iris.storage.ManagedObjectStore;
import com.iris.tools.catalog.CapabilityCatalogSource;
import org.springframework.jdbc.core.simple.JdbcClient;
import org.springframework.stereotype.Service;
import org.springframework.transaction.support.TransactionTemplate;

import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.security.NoSuchAlgorithmException;
import java.time.Clock;
import java.time.Instant;
import java.util.HexFormat;
import java.util.List;
import java.util.Locale;
import java.util.UUID;
import java.util.regex.Pattern;

/** Versioned Skill lifecycle and its live Capability Catalog projection. */
@Service
public class SkillService implements CapabilityCatalogSource {
    private static final Pattern NAME = Pattern.compile(
            "[a-z][a-z0-9]*(?:_[a-z0-9]+)*"
    );
    private static final int MAX_INSTRUCTIONS = 40_000;
    private static final String PROVIDER_KEY = "skill-store";

    private final JdbcClient jdbc;
    private final ObjectMapper objectMapper;
    private final ManagedObjectStore objects;
    private final TransactionTemplate transactions;
    private final Clock clock = Clock.systemUTC();

    public SkillService(
            JdbcClient jdbc,
            ObjectMapper objectMapper,
            ManagedObjectStore objects,
            TransactionTemplate transactions
    ) {
        this.jdbc = jdbc;
        this.objectMapper = objectMapper;
        this.objects = objects;
        this.transactions = transactions;
    }

    public List<SkillView> list() {
        return jdbc.sql("""
                SELECT definition.*, head.lifecycle_status,
                       head.version AS head_version, head.updated_at
                FROM skill_head head
                JOIN skill_definition definition
                  ON definition.skill_id = head.skill_id
                 AND definition.definition_version = head.definition_version
                ORDER BY lower(definition.title), definition.skill_id
                """)
                .query(this::mapView)
                .list();
    }

    public SkillView require(String skillId) {
        return jdbc.sql("""
                SELECT definition.*, head.lifecycle_status,
                       head.version AS head_version, head.updated_at
                FROM skill_head head
                JOIN skill_definition definition
                  ON definition.skill_id = head.skill_id
                 AND definition.definition_version = head.definition_version
                WHERE head.skill_id = :skillId
                """)
                .param("skillId", skillId)
                .query(this::mapView)
                .optional()
                .orElseThrow(() -> new IllegalArgumentException(
                        "Skill not found: " + skillId
                ));
    }

    public SkillView create(SkillDraft draft) {
        SkillDraft valid = validate(draft);
        String skillId = "skill_" + UUID.randomUUID()
                .toString().replace("-", "");
        persistVersion(skillId, 1, valid, null);
        return require(skillId);
    }

    public SkillView update(
            String skillId,
            int expectedHeadVersion,
            SkillDraft draft
    ) {
        SkillView before = require(skillId);
        if (before.headVersion() != expectedHeadVersion) {
            throw new IllegalStateException(
                    "Skill changed; refresh before editing"
            );
        }
        persistVersion(
                skillId,
                before.definitionVersion() + 1,
                validate(draft),
                before
        );
        return require(skillId);
    }

    public SkillView setEnabled(
            String skillId,
            int expectedHeadVersion,
            boolean enabled
    ) {
        SkillView before = require(skillId);
        if (before.headVersion() != expectedHeadVersion) {
            throw new IllegalStateException(
                    "Skill changed; refresh before toggling"
            );
        }
        String status = enabled ? "active" : "disabled";
        Instant now = clock.instant();
        transactions.executeWithoutResult(tx -> {
            int updated = jdbc.sql("""
                    UPDATE skill_head
                    SET lifecycle_status = :status,
                        version = version + 1,
                        updated_at = :now
                    WHERE skill_id = :skillId
                      AND version = :expectedVersion
                    """)
                    .param("status", status)
                    .param("now", now.toString())
                    .param("skillId", skillId)
                    .param("expectedVersion", expectedHeadVersion)
                    .update();
            if (updated != 1) {
                throw new IllegalStateException(
                        "Skill changed while toggling"
                );
            }
            updateBinding(
                    skillId,
                    Integer.toString(before.definitionVersion()),
                    enabled ? "available" : "unavailable",
                    now
            );
        });
        return require(skillId);
    }

    @Override
    public List<Definition> definitions() {
        return list().stream()
                .filter(SkillView::enabled)
                .map(this::catalogDefinition)
                .toList();
    }

    private void persistVersion(
            String skillId,
            int definitionVersion,
            SkillDraft draft,
            SkillView previous
    ) {
        requireUniquePath(skillId, draft.capabilityPath());
        try {
            var instructions = objects.putUtf8(draft.instructions());
            ObjectNode manifest = manifest(
                    skillId,
                    definitionVersion,
                    draft,
                    instructions.contentHash()
            );
            String manifestJson = objectMapper.writeValueAsString(manifest);
            String manifestHash = hash(manifestJson);
            var snapshot = objects.putUtf8(manifestJson);
            Instant now = clock.instant();
            transactions.executeWithoutResult(tx -> {
                jdbc.sql("""
                        INSERT INTO skill_definition(
                            skill_id, definition_version, name, title,
                            capability_path, description, when_to_use,
                            instructions_object_ref,
                            instructions_content_hash,
                            dependencies_json, created_at
                        ) VALUES (
                            :skillId, :definitionVersion, :name, :title,
                            :path, :description, :whenToUse,
                            :instructionsRef, :instructionsHash,
                            :dependencies, :now
                        )
                        """)
                        .param("skillId", skillId)
                        .param("definitionVersion", definitionVersion)
                        .param("name", draft.name())
                        .param("title", draft.title())
                        .param("path", draft.capabilityPath())
                        .param("description", draft.description())
                        .param("whenToUse", draft.whenToUse())
                        .param("instructionsRef", instructions.objectRef())
                        .param("instructionsHash", instructions.contentHash())
                        .param("dependencies", write(draft.dependencies()))
                        .param("now", now.toString())
                        .update();
                jdbc.sql("""
                        INSERT INTO capability_definition(
                            capability_id, definition_version, kind, name,
                            capability_path, description, risk_level,
                            definition_status, manifest_hash,
                            snapshot_object_ref, snapshot_content_hash,
                            first_seen_at, last_seen_at
                        ) VALUES (
                            :skillId, :definitionVersion, 'skill', :name,
                            :path, :description, 'read_only',
                            'active', :manifestHash,
                            :snapshotRef, :snapshotHash, :now, :now
                        )
                        """)
                        .param("skillId", skillId)
                        .param("definitionVersion",
                                Integer.toString(definitionVersion))
                        .param("name", draft.name())
                        .param("path", draft.capabilityPath())
                        .param("description", draft.description())
                        .param("manifestHash", manifestHash)
                        .param("snapshotRef", snapshot.objectRef())
                        .param("snapshotHash", snapshot.contentHash())
                        .param("now", now.toString())
                        .update();
                if (previous == null) {
                    jdbc.sql("""
                            INSERT INTO skill_head(
                                skill_id, definition_version,
                                lifecycle_status, version,
                                created_at, updated_at
                            ) VALUES (
                                :skillId, :definitionVersion,
                                :status, 1, :now, :now
                            )
                            """)
                            .param("skillId", skillId)
                            .param("definitionVersion", definitionVersion)
                            .param("status", draft.enabled()
                                    ? "active" : "disabled")
                            .param("now", now.toString())
                            .update();
                } else {
                    int updated = jdbc.sql("""
                            UPDATE skill_head
                            SET definition_version = :definitionVersion,
                                lifecycle_status = :status,
                                version = version + 1,
                                updated_at = :now
                            WHERE skill_id = :skillId
                              AND version = :expectedVersion
                            """)
                            .param("definitionVersion", definitionVersion)
                            .param("status", draft.enabled()
                                    ? "active" : "disabled")
                            .param("now", now.toString())
                            .param("skillId", skillId)
                            .param("expectedVersion", previous.headVersion())
                            .update();
                    if (updated != 1) {
                        throw new IllegalStateException(
                                "Skill changed while saving"
                        );
                    }
                    updateBinding(
                            skillId,
                            Integer.toString(previous.definitionVersion()),
                            "unavailable",
                            now
                    );
                }
                updateBinding(
                        skillId,
                        Integer.toString(definitionVersion),
                        draft.enabled() ? "available" : "unavailable",
                        now
                );
            });
        } catch (IOException exception) {
            throw new IllegalStateException(
                    "Unable to persist Skill content",
                    exception
            );
        }
    }

    private Definition catalogDefinition(SkillView skill) {
        ObjectNode manifest = manifest(
                skill.skillId(),
                skill.definitionVersion(),
                new SkillDraft(
                        skill.name(),
                        skill.title(),
                        skill.capabilityPath(),
                        skill.description(),
                        skill.whenToUse(),
                        skill.instructions(),
                        skill.dependencies(),
                        true
                ),
                skill.instructionsContentHash()
        );
        String manifestHash = hash(write(manifest));
        return new Definition(
                skill.skillId(),
                Integer.toString(skill.definitionVersion()),
                "skill",
                skill.name(),
                skill.capabilityPath(),
                skill.description(),
                "read_only",
                "available",
                "Skill 已启用；读取定义后按其适用条件使用",
                manifestHash,
                manifest
        );
    }

    private ObjectNode manifest(
            String skillId,
            int definitionVersion,
            SkillDraft draft,
            String contentHash
    ) {
        ObjectNode manifest = objectMapper.createObjectNode();
        manifest.put("id", skillId);
        manifest.put("version", Integer.toString(definitionVersion));
        manifest.put("kind", "skill");
        manifest.put("name", draft.name());
        manifest.put("title", draft.title());
        manifest.put("capabilityPath", draft.capabilityPath());
        manifest.put("description", draft.description());
        manifest.put("whenToUse", draft.whenToUse());
        manifest.put("instructions", draft.instructions());
        manifest.put("contentHash", contentHash);
        var dependencies = manifest.putArray("dependencies");
        draft.dependencies().forEach(dependencies::add);
        manifest.put(
                "usage",
                "先核对 whenToUse 与当前任务，再把 instructions 作为工艺骨架；真实动作仍通过相应 Tool Runtime 执行"
        );
        return manifest;
    }

    private SkillView mapView(java.sql.ResultSet rs, int row)
            throws java.sql.SQLException {
        try {
            String instructions = new String(
                    objects.readBytes(
                            rs.getString("instructions_object_ref"),
                            MAX_INSTRUCTIONS * 4L
                    ),
                    StandardCharsets.UTF_8
            );
            return new SkillView(
                    rs.getString("skill_id"),
                    rs.getInt("definition_version"),
                    rs.getInt("head_version"),
                    rs.getString("name"),
                    rs.getString("title"),
                    rs.getString("capability_path"),
                    rs.getString("description"),
                    rs.getString("when_to_use"),
                    instructions,
                    rs.getString("instructions_content_hash"),
                    readList(rs.getString("dependencies_json")),
                    "active".equals(rs.getString("lifecycle_status")),
                    rs.getString("lifecycle_status"),
                    Instant.parse(rs.getString("updated_at"))
            );
        } catch (IOException exception) {
            throw new java.sql.SQLException(
                    "Stored Skill content is unavailable",
                    exception
            );
        }
    }

    private SkillDraft validate(SkillDraft draft) {
        if (draft == null || draft.name() == null
                || !NAME.matcher(draft.name().trim()).matches()) {
            throw new IllegalArgumentException(
                    "Skill name must be snake_case"
            );
        }
        String name = draft.name().trim();
        String title = bounded(draft.title(), "title", 120);
        String description = bounded(
                draft.description(), "description", 600
        );
        String whenToUse = bounded(
                draft.whenToUse(), "whenToUse", 1_200
        );
        String instructions = bounded(
                draft.instructions(), "instructions", MAX_INSTRUCTIONS
        );
        String path = draft.capabilityPath() == null
                || draft.capabilityPath().isBlank()
                ? "/skills/personal/" + name
                : draft.capabilityPath().trim();
        if (!path.matches("^/skills(?:/[a-z0-9][a-z0-9_-]*)+$")
                || !path.endsWith("/" + name)) {
            throw new IllegalArgumentException(
                    "Skill capabilityPath must be under /skills and end with its name"
            );
        }
        List<String> dependencies = draft.dependencies() == null
                ? List.of()
                : draft.dependencies().stream()
                        .map(String::trim)
                        .filter(value -> !value.isBlank())
                        .distinct()
                        .limit(32)
                        .toList();
        if (dependencies.stream().anyMatch(value ->
                !value.startsWith("/") || value.contains(".."))) {
            throw new IllegalArgumentException(
                    "Skill dependencies must be absolute capability paths"
            );
        }
        return new SkillDraft(
                name, title, path, description, whenToUse,
                instructions, dependencies, draft.enabled()
        );
    }

    private void requireUniquePath(String skillId, String path) {
        int conflicts = jdbc.sql("""
                SELECT COUNT(*)
                FROM skill_definition
                WHERE capability_path = :path
                  AND skill_id <> :skillId
                """)
                .param("path", path)
                .param("skillId", skillId)
                .query(Integer.class)
                .single();
        if (conflicts > 0) {
            throw new IllegalArgumentException(
                    "Another Skill already uses " + path
            );
        }
    }

    private void updateBinding(
            String skillId,
            String definitionVersion,
            String availability,
            Instant now
    ) {
        jdbc.sql("""
                INSERT INTO capability_binding_state(
                    capability_id, definition_version, provider_key,
                    availability, checked_at, last_seen_at
                ) VALUES (
                    :skillId, :definitionVersion, :providerKey,
                    :availability, :now,
                    CASE WHEN :availability = 'available'
                         THEN :now ELSE NULL END
                )
                ON CONFLICT(
                    capability_id, definition_version, provider_key
                ) DO UPDATE SET
                    availability = excluded.availability,
                    checked_at = excluded.checked_at,
                    last_seen_at = CASE
                        WHEN excluded.availability = 'available'
                        THEN excluded.last_seen_at
                        ELSE capability_binding_state.last_seen_at
                    END
                """)
                .param("skillId", skillId)
                .param("definitionVersion", definitionVersion)
                .param("providerKey", PROVIDER_KEY)
                .param("availability", availability)
                .param("now", now.toString())
                .update();
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

    private String write(Object value) {
        try {
            return objectMapper.writeValueAsString(value);
        } catch (JsonProcessingException exception) {
            throw new IllegalStateException("Unable to serialize Skill", exception);
        }
    }

    private List<String> readList(String json) {
        try {
            return objectMapper.readValue(
                    json,
                    new TypeReference<List<String>>() { }
            );
        } catch (JsonProcessingException exception) {
            throw new IllegalStateException(
                    "Stored Skill dependencies are invalid",
                    exception
            );
        }
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

    public record SkillDraft(
            String name,
            String title,
            String capabilityPath,
            String description,
            String whenToUse,
            String instructions,
            List<String> dependencies,
            boolean enabled
    ) {
        public SkillDraft {
            dependencies = dependencies == null
                    ? List.of() : List.copyOf(dependencies);
        }
    }

    public record SkillView(
            String skillId,
            int definitionVersion,
            int headVersion,
            String name,
            String title,
            String capabilityPath,
            String description,
            String whenToUse,
            String instructions,
            String instructionsContentHash,
            List<String> dependencies,
            boolean enabled,
            String lifecycleStatus,
            Instant updatedAt
    ) {
        public SkillView {
            dependencies = List.copyOf(dependencies);
        }
    }
}
