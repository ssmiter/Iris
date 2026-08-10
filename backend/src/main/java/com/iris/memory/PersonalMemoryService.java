package com.iris.memory;

import com.iris.retrieval.HybridRetrievalEngine;
import com.iris.storage.ManagedObjectStore;
import org.springframework.jdbc.core.simple.JdbcClient;
import org.springframework.stereotype.Service;
import org.springframework.transaction.support.TransactionTemplate;

import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.time.Clock;
import java.time.Instant;
import java.util.List;
import java.util.Locale;
import java.util.UUID;
import java.util.regex.Pattern;

/** Versioned personal facts with source boundaries and hybrid retrieval. */
@Service
public class PersonalMemoryService {
    private static final int MAX_CONTENT = 20_000;
    private static final Pattern SCOPE = Pattern.compile(
            "[a-z][a-z0-9]*(?:[._:-][a-z0-9]+)*"
    );
    private static final Pattern SOURCE_KIND = Pattern.compile(
            "user_stated|agent_observation|imported|system"
    );

    private final JdbcClient jdbc;
    private final ManagedObjectStore objects;
    private final HybridRetrievalEngine retrieval;
    private final TransactionTemplate transactions;
    private final Clock clock = Clock.systemUTC();

    public PersonalMemoryService(
            JdbcClient jdbc,
            ManagedObjectStore objects,
            HybridRetrievalEngine retrieval,
            TransactionTemplate transactions
    ) {
        this.jdbc = jdbc;
        this.objects = objects;
        this.retrieval = retrieval;
        this.transactions = transactions;
    }

    public List<MemorySummary> list() {
        return jdbc.sql("""
                SELECT definition.*, head.lifecycle_status,
                       head.version AS head_version, head.updated_at
                FROM personal_memory_head head
                JOIN personal_memory_definition definition
                  ON definition.memory_id = head.memory_id
                 AND definition.definition_version = head.definition_version
                ORDER BY head.updated_at DESC, head.memory_id
                """)
                .query((rs, row) -> new MemorySummary(
                        rs.getString("memory_id"),
                        rs.getInt("definition_version"),
                        rs.getInt("head_version"),
                        rs.getString("title"),
                        preview(rs.getString("content_object_ref")),
                        rs.getString("scope"),
                        rs.getString("source_kind"),
                        rs.getString("source_ref"),
                        rs.getDouble("confidence"),
                        "active".equals(rs.getString("lifecycle_status")),
                        rs.getString("lifecycle_status"),
                        Instant.parse(rs.getString("updated_at"))
                ))
                .list();
    }

    public MemoryView require(String memoryId) {
        return jdbc.sql("""
                SELECT definition.*, head.lifecycle_status,
                       head.version AS head_version, head.updated_at
                FROM personal_memory_head head
                JOIN personal_memory_definition definition
                  ON definition.memory_id = head.memory_id
                 AND definition.definition_version = head.definition_version
                WHERE head.memory_id = :memoryId
                """)
                .param("memoryId", memoryId)
                .query((rs, row) -> new MemoryView(
                        rs.getString("memory_id"),
                        rs.getInt("definition_version"),
                        rs.getInt("head_version"),
                        rs.getString("title"),
                        content(rs.getString("content_object_ref")),
                        rs.getString("content_hash"),
                        rs.getString("scope"),
                        rs.getString("source_kind"),
                        rs.getString("source_ref"),
                        rs.getDouble("confidence"),
                        "active".equals(rs.getString("lifecycle_status")),
                        rs.getString("lifecycle_status"),
                        Instant.parse(rs.getString("updated_at"))
                ))
                .optional()
                .orElseThrow(() -> new IllegalArgumentException(
                        "Memory not found: " + memoryId
                ));
    }

    public MemoryView create(MemoryDraft draft) {
        MemoryDraft valid = validate(draft);
        String memoryId = "memory_" + UUID.randomUUID()
                .toString().replace("-", "");
        persist(memoryId, 1, valid, null);
        return require(memoryId);
    }

    public MemoryView update(
            String memoryId,
            int expectedHeadVersion,
            MemoryDraft draft
    ) {
        MemoryView previous = require(memoryId);
        if (previous.headVersion() != expectedHeadVersion) {
            throw new IllegalStateException(
                    "Memory changed; refresh before editing"
            );
        }
        persist(
                memoryId,
                previous.definitionVersion() + 1,
                validate(draft),
                previous
        );
        return require(memoryId);
    }

    public MemoryView setEnabled(
            String memoryId,
            int expectedHeadVersion,
            boolean enabled
    ) {
        require(memoryId);
        Instant now = clock.instant();
        int updated = jdbc.sql("""
                UPDATE personal_memory_head
                SET lifecycle_status = :status,
                    version = version + 1,
                    updated_at = :now
                WHERE memory_id = :memoryId AND version = :expectedVersion
                """)
                .param("status", enabled ? "active" : "forgotten")
                .param("now", now.toString())
                .param("memoryId", memoryId)
                .param("expectedVersion", expectedHeadVersion)
                .update();
        if (updated != 1) {
            throw new IllegalStateException(
                    "Memory changed; refresh before updating"
            );
        }
        return require(memoryId);
    }

    public SearchResult search(String query, String scope, int limit) {
        String normalizedQuery = bounded(query, "query", 500);
        List<MemoryView> candidates = activeMemories(scope);
        List<HybridRetrievalEngine.Candidate<MemoryView>> rankedCandidates =
                candidates.stream()
                        .map(memory -> new HybridRetrievalEngine.Candidate<>(
                                memory,
                                memory.memoryId(),
                                memory.title() + "\n" + memory.content(),
                                lexicalScore(normalizedQuery, memory),
                                memory.memoryId().equalsIgnoreCase(normalizedQuery)
                        ))
                        .toList();
        var ranked = retrieval.rank(normalizedQuery, rankedCandidates, limit);
        return new SearchResult(
                ranked.strategy(),
                ranked.modelIdentity(),
                ranked.matches().stream().map(match -> new SearchHit(
                        match.value().memoryId(),
                        match.value().title(),
                        excerpt(match.value().content(), normalizedQuery),
                        match.value().scope(),
                        match.value().sourceKind(),
                        match.value().sourceRef(),
                        match.value().confidence(),
                        match.combinedScore(),
                        match.strategy()
                )).toList()
        );
    }

    private List<MemoryView> activeMemories(String requestedScope) {
        String sql = """
                SELECT definition.*, head.lifecycle_status,
                       head.version AS head_version, head.updated_at
                FROM personal_memory_head head
                JOIN personal_memory_definition definition
                  ON definition.memory_id = head.memory_id
                 AND definition.definition_version = head.definition_version
                WHERE head.lifecycle_status = 'active'
                """ + (requestedScope == null || requestedScope.isBlank()
                ? "" : " AND definition.scope = :scope");
        var statement = jdbc.sql(sql);
        if (requestedScope != null && !requestedScope.isBlank()) {
            if (!SCOPE.matcher(requestedScope).matches()) {
                throw new IllegalArgumentException("Invalid memory scope");
            }
            statement.param("scope", requestedScope);
        }
        return statement.query((rs, row) -> new MemoryView(
                rs.getString("memory_id"),
                rs.getInt("definition_version"),
                rs.getInt("head_version"),
                rs.getString("title"),
                content(rs.getString("content_object_ref")),
                rs.getString("content_hash"),
                rs.getString("scope"),
                rs.getString("source_kind"),
                rs.getString("source_ref"),
                rs.getDouble("confidence"),
                true,
                rs.getString("lifecycle_status"),
                Instant.parse(rs.getString("updated_at"))
        )).list();
    }

    private void persist(
            String memoryId,
            int definitionVersion,
            MemoryDraft draft,
            MemoryView previous
    ) {
        try {
            var stored = objects.putUtf8(draft.content());
            Instant now = clock.instant();
            transactions.executeWithoutResult(tx -> {
                jdbc.sql("""
                        INSERT INTO personal_memory_definition(
                            memory_id, definition_version, title,
                            content_object_ref, content_hash, scope,
                            source_kind, source_ref, confidence, created_at
                        ) VALUES (
                            :memoryId, :definitionVersion, :title,
                            :contentRef, :contentHash, :scope,
                            :sourceKind, :sourceRef, :confidence, :now
                        )
                        """)
                        .param("memoryId", memoryId)
                        .param("definitionVersion", definitionVersion)
                        .param("title", draft.title())
                        .param("contentRef", stored.objectRef())
                        .param("contentHash", stored.contentHash())
                        .param("scope", draft.scope())
                        .param("sourceKind", draft.sourceKind())
                        .param("sourceRef", draft.sourceRef())
                        .param("confidence", draft.confidence())
                        .param("now", now.toString())
                        .update();
                if (previous == null) {
                    jdbc.sql("""
                            INSERT INTO personal_memory_head(
                                memory_id, definition_version,
                                lifecycle_status, version,
                                created_at, updated_at
                            ) VALUES (
                                :memoryId, :definitionVersion,
                                :status, 1, :now, :now
                            )
                            """)
                            .param("memoryId", memoryId)
                            .param("definitionVersion", definitionVersion)
                            .param("status", draft.enabled()
                                    ? "active" : "forgotten")
                            .param("now", now.toString())
                            .update();
                } else {
                    int updated = jdbc.sql("""
                            UPDATE personal_memory_head
                            SET definition_version = :definitionVersion,
                                lifecycle_status = :status,
                                version = version + 1,
                                updated_at = :now
                            WHERE memory_id = :memoryId
                              AND version = :expectedVersion
                            """)
                            .param("definitionVersion", definitionVersion)
                            .param("status", draft.enabled()
                                    ? "active" : "forgotten")
                            .param("now", now.toString())
                            .param("memoryId", memoryId)
                            .param("expectedVersion", previous.headVersion())
                            .update();
                    if (updated != 1) {
                        throw new IllegalStateException(
                                "Memory changed while saving"
                        );
                    }
                }
            });
        } catch (IOException exception) {
            throw new IllegalStateException(
                    "Unable to persist memory content", exception
            );
        }
    }

    private MemoryDraft validate(MemoryDraft draft) {
        if (draft == null) {
            throw new IllegalArgumentException("Memory definition is required");
        }
        String title = bounded(draft.title(), "title", 160);
        String content = bounded(draft.content(), "content", MAX_CONTENT);
        String scope = draft.scope() == null || draft.scope().isBlank()
                ? "personal" : draft.scope().trim();
        if (!SCOPE.matcher(scope).matches()) {
            throw new IllegalArgumentException("Invalid memory scope");
        }
        String sourceKind = draft.sourceKind() == null
                || draft.sourceKind().isBlank()
                ? "user_stated" : draft.sourceKind().trim();
        if (!SOURCE_KIND.matcher(sourceKind).matches()) {
            throw new IllegalArgumentException("Invalid memory sourceKind");
        }
        if (draft.confidence() < 0D || draft.confidence() > 1D) {
            throw new IllegalArgumentException(
                    "Memory confidence must be between 0 and 1"
            );
        }
        String sourceRef = draft.sourceRef() == null
                || draft.sourceRef().isBlank()
                ? null : draft.sourceRef().trim();
        return new MemoryDraft(
                title, content, scope, sourceKind, sourceRef,
                draft.confidence(), draft.enabled()
        );
    }

    private double lexicalScore(String query, MemoryView memory) {
        String q = query.toLowerCase(Locale.ROOT);
        String title = memory.title().toLowerCase(Locale.ROOT);
        String content = memory.content().toLowerCase(Locale.ROOT);
        double score = 0D;
        if (title.equals(q)) score += 12D;
        else if (title.contains(q)) score += 7D;
        if (content.contains(q)) score += 4D;
        for (String term : q.split("[^\\p{L}\\p{N}_]+")) {
            if (term.length() < 2 || term.equals(q)) continue;
            if (title.contains(term)) score += 2D;
            if (content.contains(term)) score += 1D;
        }
        return score;
    }

    private String excerpt(String content, String query) {
        String lower = content.toLowerCase(Locale.ROOT);
        int hit = lower.indexOf(query.toLowerCase(Locale.ROOT));
        int start = hit < 0 ? 0 : Math.max(0, hit - 80);
        int end = Math.min(content.length(), start + 280);
        return (start > 0 ? "…" : "")
                + content.substring(start, end)
                + (end < content.length() ? "…" : "");
    }

    private String preview(String objectRef) {
        try {
            String value = objects.readUtf8Window(objectRef, 0, 320);
            return value.length() < 320 ? value : value + "…";
        } catch (IOException exception) {
            return "[memory content unavailable]";
        }
    }

    private String content(String objectRef) {
        try {
            return new String(
                    objects.readBytes(objectRef, MAX_CONTENT * 4L),
                    StandardCharsets.UTF_8
            );
        } catch (IOException exception) {
            throw new IllegalStateException(
                    "Stored memory content is unavailable", exception
            );
        }
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

    public record MemoryDraft(
            String title,
            String content,
            String scope,
            String sourceKind,
            String sourceRef,
            double confidence,
            boolean enabled
    ) { }

    public record MemorySummary(
            String memoryId,
            int definitionVersion,
            int headVersion,
            String title,
            String preview,
            String scope,
            String sourceKind,
            String sourceRef,
            double confidence,
            boolean enabled,
            String lifecycleStatus,
            Instant updatedAt
    ) { }

    public record MemoryView(
            String memoryId,
            int definitionVersion,
            int headVersion,
            String title,
            String content,
            String contentHash,
            String scope,
            String sourceKind,
            String sourceRef,
            double confidence,
            boolean enabled,
            String lifecycleStatus,
            Instant updatedAt
    ) { }

    public record SearchResult(
            String strategy,
            String semanticModel,
            List<SearchHit> matches
    ) { }

    public record SearchHit(
            String memoryId,
            String title,
            String excerpt,
            String scope,
            String sourceKind,
            String sourceRef,
            double confidence,
            double relevance,
            String retrievalStrategy
    ) { }
}
