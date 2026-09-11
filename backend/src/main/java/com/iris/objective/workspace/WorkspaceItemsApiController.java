package com.iris.objective.workspace;

import org.springframework.jdbc.core.simple.JdbcClient;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RequestParam;
import org.springframework.web.bind.annotation.RestController;
import reactor.core.publisher.Mono;
import reactor.core.scheduler.Schedulers;

import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

/**
 * Session index for the preview dock. It exposes metadata only; bytes remain
 * in the immutable artifact/object store and are fetched lazily by preview
 * endpoints. Missing artifacts therefore cannot turn a refresh into a large
 * payload or an agent-context injection.
 */
@RestController
@RequestMapping("/api/workspace")
public final class WorkspaceItemsApiController {
    private final JdbcClient jdbc;

    public WorkspaceItemsApiController(JdbcClient jdbc) {
        this.jdbc = jdbc;
    }

    @GetMapping("/items")
    public Mono<Map<String, Object>> list(
            @RequestParam("conversationId") String conversationId
    ) {
        return Mono.fromCallable(() -> {
            String id = conversationId == null ? "" : conversationId.trim();
            List<Map<String, Object>> items = jdbc.sql("""
                    SELECT a.artifact_id, a.conversation_id, a.name, a.title,
                           a.kind, v.media_type, v.byte_count,
                           v.workspace_path, a.created_at
                    FROM artifact a
                    JOIN artifact_version v
                      ON v.artifact_id = a.artifact_id
                     AND v.artifact_version = a.latest_version
                    WHERE a.conversation_id = :conversationId
                      AND v.workspace_path IS NOT NULL
                    ORDER BY created_at ASC, artifact_id ASC
                    """)
                    .param("conversationId", id)
                    .query((rs, row) -> {
                        String artifactId = rs.getString("artifact_id");
                        String workspacePath = rs.getString("workspace_path");
                        String virtualPath = workspacePath == null || workspacePath.isBlank()
                                ? "/artifacts/" + artifactId
                                : workspacePath;
                        Map<String, Object> item = new LinkedHashMap<>();
                        // The frontend treats this as an opaque key; keeping
                        // the artifact id makes reconnects stable across runs.
                        item.put("id", artifactId);
                        item.put("conversationId", rs.getString("conversation_id"));
                        item.put("userId", "local");
                        item.put("virtualPath", virtualPath);
                        item.put("kind", kindOf(rs.getString("kind")));
                        item.put("caption", blankToNull(rs.getString("title")));
                        item.put("mimeType", rs.getString("media_type"));
                        item.put("sizeBytes", rs.getLong("byte_count"));
                        item.put("source", "artifact");
                        item.put("createdAt", rs.getString("created_at"));
                        item.put("updatedAt", rs.getString("created_at"));
                        return item;
                    })
                    .list();
            Map<String, Object> response = new LinkedHashMap<>();
            response.put("conversationId", id);
            response.put("items", items);
            return response;
        }).subscribeOn(Schedulers.boundedElastic());
    }

    private String kindOf(String value) {
        return value != null && value.toLowerCase().contains("input")
                ? "upload" : "output";
    }

    private String blankToNull(String value) {
        return value == null || value.isBlank() ? null : value;
    }
}
