package com.iris.artifact;

import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.node.ArrayNode;
import com.fasterxml.jackson.databind.node.ObjectNode;
import com.iris.storage.ManagedObjectStore;
import com.iris.storage.ManagedObjectStore.StoredObject;
import com.iris.tools.core.ToolContext;
import com.iris.tools.core.ToolRuntimeException;
import com.iris.workspace.WorkspaceFileMutationService;
import com.iris.workspace.WorkspaceFileMutationService.TargetState;
import org.springframework.jdbc.core.simple.JdbcClient;
import org.springframework.stereotype.Service;
import org.springframework.transaction.support.TransactionTemplate;

import java.io.IOException;
import java.nio.file.Files;
import java.nio.file.Path;
import java.time.Clock;
import java.time.Instant;
import java.util.List;
import java.util.Locale;
import java.util.Optional;
import java.util.UUID;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

/**
 * Registry for immutable, transferable task outputs.
 *
 * Registration freezes bytes. Publication only changes Iris visibility.
 */
@Service
public class ArtifactService {
    private static final long MAX_ARTIFACT_BYTES = 32L * 1024 * 1024;
    private static final int MAX_PREVIEW_CHARACTERS = 80_000;
    private static final int MAX_MODEL_TEXT_WINDOW = 20_000;
    private static final Pattern REF = Pattern.compile(
            "^artifact://(artifact_[a-f0-9]{32})@([1-9][0-9]*)$"
    );

    private final JdbcClient jdbc;
    private final ObjectMapper objectMapper;
    private final TransactionTemplate transactions;
    private final WorkspaceFileMutationService workspaceFiles;
    private final ManagedObjectStore objects;
    private final Clock clock = Clock.systemUTC();

    public ArtifactService(
            JdbcClient jdbc,
            ObjectMapper objectMapper,
            TransactionTemplate transactions,
            WorkspaceFileMutationService workspaceFiles,
            ManagedObjectStore objects
    ) {
        this.jdbc = jdbc;
        this.objectMapper = objectMapper;
        this.transactions = transactions;
        this.workspaceFiles = workspaceFiles;
        this.objects = objects;
    }

    public WorkspaceCandidate inspectWorkspace(
            ToolContext context,
            String path
    ) throws IOException {
        TargetState state = workspaceFiles.inspect(
                context.workspaceRoot(),
                path
        );
        if (!state.exists()) {
            throw ToolRuntimeException.beforeCommit(
                    "artifact_source_not_found",
                    "要登记的工作区文件不存在：" + state.logicalPath()
            );
        }
        if (state.sizeBytes() > MAX_ARTIFACT_BYTES) {
            throw ToolRuntimeException.beforeCommit(
                    "artifact_source_too_large",
                    "文件为 " + state.sizeBytes()
                            + " 字节，超过当前 Artifact 登记上限"
            );
        }
        return new WorkspaceCandidate(
                state.logicalPath(),
                state.version(),
                state.sizeBytes(),
                state
        );
    }

    public ArtifactSnapshot registerWorkspace(
            ToolContext context,
            String registrationExecutionId,
            String path,
            String expectedWorkspaceVersion,
            String name,
            String title,
            String kind,
            String originExecutionId
    ) throws IOException {
        Scope scope = scope(context.runId());
        WorkspaceCandidate candidate = inspectWorkspace(context, path);
        if (!candidate.version().equals(expectedWorkspaceVersion)) {
            throw ToolRuntimeException.beforeCommit(
                    "artifact_source_version_changed",
                    "工作区文件已经变化；请重新检查后再登记"
            );
        }
        requireOrigin(scope.conversationId(), originExecutionId);
        byte[] content = Files.readAllBytes(
                candidate.target().physicalPath()
        );
        String afterReadVersion = workspaceFiles.versionOf(
                candidate.target().physicalPath()
        );
        if (!afterReadVersion.equals(expectedWorkspaceVersion)) {
            throw ToolRuntimeException.beforeCommit(
                    "artifact_source_version_changed",
                    "读取期间工作区文件发生变化；Iris 没有登记混合版本"
            );
        }
        StoredObject stored = objects.put(content);
        String artifactId = "artifact_" + UUID.randomUUID()
                .toString().replace("-", "");
        int version = 1;
        String mediaType = mediaType(candidate.target().physicalPath());
        Instant now = clock.instant();
        transactions.executeWithoutResult(status -> {
            jdbc.sql("""
                    INSERT INTO artifact (
                      artifact_id, conversation_id, branch_id,
                      name, title, kind, latest_version,
                      source_run_id, created_at
                    ) VALUES (
                      :artifactId, :conversationId, :branchId,
                      :name, :title, :kind, 1, :runId, :createdAt
                    )
                    """)
                    .param("artifactId", artifactId)
                    .param("conversationId", scope.conversationId())
                    .param("branchId", scope.branchId())
                    .param("name", name)
                    .param("title", title)
                    .param("kind", kind)
                    .param("runId", context.runId())
                    .param("createdAt", now.toString())
                    .update();
            jdbc.sql("""
                    INSERT INTO artifact_version (
                      artifact_id, artifact_version, object_ref, media_type,
                      content_hash, byte_count, workspace_path,
                      workspace_version, origin_execution_id,
                      registration_execution_id, created_at
                    ) VALUES (
                      :artifactId, 1, :objectRef, :mediaType,
                      :contentHash, :byteCount, :workspacePath,
                      :workspaceVersion, :originExecutionId,
                      :registrationExecutionId, :createdAt
                    )
                    """)
                    .param("artifactId", artifactId)
                    .param("objectRef", stored.objectRef())
                    .param("mediaType", mediaType)
                    .param("contentHash", stored.contentHash())
                    .param("byteCount", stored.byteCount())
                    .param("workspacePath", candidate.logicalPath())
                    .param("workspaceVersion", candidate.version())
                    .param(
                            "originExecutionId",
                            blankToNull(originExecutionId),
                            java.sql.Types.VARCHAR
                    )
                    .param("registrationExecutionId", registrationExecutionId)
                    .param("createdAt", now.toString())
                    .update();
            insertVisibility(
                    artifactId,
                    version,
                    "internal",
                    registrationExecutionId,
                    context.runId(),
                    now
            );
        });
        return require(
                reference(artifactId, version),
                scope.conversationId()
        );
    }

    /**
     * Freezes a user-selected file into the same immutable data plane used by
     * tool-produced artifacts, without fabricating an AgentRun or ToolExecution.
     */
    public ArtifactSnapshot registerUserUpload(
            String conversationId,
            String branchId,
            String submittedName,
            String submittedMediaType,
            Path stagedFile
    ) throws IOException {
        if (!branchBelongsToConversation(branchId, conversationId)) {
            throw new ToolRuntimeException(
                    "artifact_scope_unavailable",
                    "上传目标分支不属于当前对话"
            );
        }
        long byteCount = Files.size(stagedFile);
        if (byteCount > MAX_ARTIFACT_BYTES) {
            throw new ToolRuntimeException(
                    "artifact_source_too_large",
                    "上传文件超过当前 Artifact 的 32 MiB 上限"
            );
        }
        String name = safeFileName(submittedName);
        byte[] content = Files.readAllBytes(stagedFile);
        StoredObject stored = objects.put(content);
        String artifactId = "artifact_" + UUID.randomUUID()
                .toString().replace("-", "");
        String uploadId = "upload_" + UUID.randomUUID()
                .toString().replace("-", "");
        String mediaType = normalizeMediaType(
                submittedMediaType,
                name
        );
        Instant now = clock.instant();
        transactions.executeWithoutResult(status -> {
            jdbc.sql("""
                    INSERT INTO user_artifact (
                      artifact_id, conversation_id, branch_id,
                      name, title, kind, latest_version,
                      upload_id, created_at
                    ) VALUES (
                      :artifactId, :conversationId, :branchId,
                      :name, :title, 'input_file', 1,
                      :sourceRef, :createdAt
                    )
                    """)
                    .param("artifactId", artifactId)
                    .param("conversationId", conversationId)
                    .param("branchId", branchId)
                    .param("name", name)
                    .param("title", name)
                    .param("sourceRef", uploadId)
                    .param("createdAt", now.toString())
                    .update();
            jdbc.sql("""
                    INSERT INTO user_artifact_version (
                      artifact_id, artifact_version, object_ref, media_type,
                      content_hash, byte_count, created_at
                    ) VALUES (
                      :artifactId, 1, :objectRef, :mediaType,
                      :contentHash, :byteCount, :createdAt
                    )
                    """)
                    .param("artifactId", artifactId)
                    .param("objectRef", stored.objectRef())
                    .param("mediaType", mediaType)
                    .param("contentHash", stored.contentHash())
                    .param("byteCount", stored.byteCount())
                    .param("createdAt", now.toString())
                    .update();
        });
        return require(reference(artifactId, 1), conversationId);
    }

    public ArtifactSnapshot publish(
            ToolContext context,
            String publicationExecutionId,
            String artifactReference,
            String visibility
    ) {
        Scope scope = scope(context.runId());
        ArtifactSnapshot artifact = require(
                artifactReference,
                scope.conversationId()
        );
        if (!"tool".equals(artifact.sourceKind())) {
            throw ToolRuntimeException.beforeCommit(
                    "artifact_publication_not_applicable",
                    "用户附件已经由消息显式呈现，不需要再次发布"
            );
        }
        Instant now = clock.instant();
        transactions.executeWithoutResult(status -> {
            insertPublication(
                    artifact.artifactId(),
                    artifact.version(),
                    visibility,
                    publicationExecutionId,
                    context.runId(),
                    now
            );
            insertVisibility(
                    artifact.artifactId(),
                    artifact.version(),
                    visibility,
                    publicationExecutionId,
                    context.runId(),
                    now
            );
        });
        return require(artifactReference, scope.conversationId());
    }

    public ArtifactSnapshot require(
            String artifactReference,
            String conversationId
    ) {
        ArtifactAddress address = address(artifactReference);
        return find(address, conversationId).orElseThrow(() ->
                new ToolRuntimeException(
                        "artifact_not_found",
                        "当前对话中找不到 Artifact " + artifactReference
                )
        );
    }

    /**
     * Bounded metadata-only handoff index for subsequent model attempts.
     * Artifact bodies remain in the object store and are read explicitly.
     */
    public List<ArtifactSnapshot> modelContextIndex(
            String conversationId,
            String branchId,
            int limit
    ) {
        if (limit < 1 || limit > 32) {
            throw new IllegalArgumentException(
                    "Artifact context index limit must be between 1 and 32"
            );
        }
        return jdbc.sql("""
                SELECT visibility.artifact_id,
                       visibility.artifact_version
                FROM artifact_visibility visibility
                JOIN artifact artifact
                  ON artifact.artifact_id = visibility.artifact_id
                WHERE artifact.conversation_id = :conversationId
                  AND artifact.branch_id = :branchId
                  AND visibility.visibility = 'model_context'
                ORDER BY visibility.created_at DESC,
                         visibility.artifact_id DESC
                LIMIT :limit
                """)
                .param("conversationId", conversationId)
                .param("branchId", branchId)
                .param("limit", limit)
                .query((rs, row) -> reference(
                        rs.getString("artifact_id"),
                        rs.getInt("artifact_version")
                ))
                .list()
                .stream()
                .map(ref -> require(ref, conversationId))
                .toList();
    }

    public ArtifactSnapshot requireById(String artifactId, int version) {
        ArtifactAddress address = address(reference(artifactId, version));
        String conversationId = jdbc.sql("""
                SELECT conversation_id FROM artifact
                WHERE artifact_id = :artifactId
                UNION ALL
                SELECT conversation_id FROM user_artifact
                WHERE artifact_id = :artifactId
                """)
                .param("artifactId", address.artifactId())
                .query(String.class)
                .optional()
                .orElseThrow(() -> new ToolRuntimeException(
                        "artifact_not_found",
                        "找不到指定 Artifact"
                ));
        return require(reference(artifactId, version), conversationId);
    }

    public ArtifactContent content(String artifactId, int version) {
        requireById(artifactId, version);
        StoredContent stored = storedContent(artifactId, version);
        try {
            return new ArtifactContent(
                    stored.name(),
                    stored.mediaType(),
                    objects.readBytes(
                            stored.objectRef(),
                            MAX_ARTIFACT_BYTES
                    )
            );
        } catch (IOException exception) {
            throw new IllegalStateException(
                    "Artifact content is unavailable or corrupted",
                    exception
            );
        }
    }

    public ArtifactPreview preview(String artifactId, int version) {
        ArtifactSnapshot artifact = requireById(artifactId, version);
        StoredContent stored = storedContent(artifactId, version);
        String lowerName = stored.name().toLowerCase(Locale.ROOT);
        if (isSafePreviewImage(stored.mediaType())) {
            return new ArtifactPreview(
                    artifact.artifactId(),
                    artifact.reference(),
                    artifact.title(),
                    "image",
                    null,
                    null,
                    false,
                    artifact.byteCount(),
                    "/api/v1/artifacts/" + artifact.artifactId()
                            + "/versions/" + artifact.version()
                            + "/preview-content",
                    null
            );
        }
        String format = textPreviewFormat(stored.mediaType(), lowerName);
        if (format == null) {
            return new ArtifactPreview(
                    artifact.artifactId(),
                    artifact.reference(),
                    artifact.title(),
                    "download_only",
                    null,
                    null,
                    false,
                    artifact.byteCount(),
                    null,
                    "该格式暂不在 Iris 内联执行或解析，可下载后用本机应用查看。"
            );
        }
        try {
            String window = objects.readUtf8Window(
                    stored.objectRef(),
                    0,
                    MAX_PREVIEW_CHARACTERS + 1
            );
            boolean truncated = window.length() > MAX_PREVIEW_CHARACTERS;
            String content = truncated
                    ? window.substring(0, MAX_PREVIEW_CHARACTERS)
                    : window;
            return new ArtifactPreview(
                    artifact.artifactId(),
                    artifact.reference(),
                    artifact.title(),
                    "text",
                    format,
                    content,
                    truncated,
                    artifact.byteCount(),
                    null,
                    truncated
                            ? "预览仅展示开头内容，完整版本请下载。"
                            : null
            );
        } catch (IOException exception) {
            return new ArtifactPreview(
                    artifact.artifactId(),
                    artifact.reference(),
                    artifact.title(),
                    "download_only",
                    null,
                    null,
                    false,
                    artifact.byteCount(),
                    null,
                    "内容不是有效的 UTF-8 文本，可下载后用本机应用查看。"
            );
        }
    }

    public ArtifactTextWindow readTextWindow(
            String artifactReference,
            String conversationId,
            int startCharacter,
            int characterCount
    ) {
        if (startCharacter < 0
                || characterCount < 1
                || characterCount > MAX_MODEL_TEXT_WINDOW) {
            throw ToolRuntimeException.beforeCommit(
                    "invalid_artifact_text_window",
                    "start_character 必须大于等于 0，character_count 必须在 1 到 "
                            + MAX_MODEL_TEXT_WINDOW + " 之间"
            );
        }
        ArtifactSnapshot artifact = require(
                artifactReference,
                conversationId
        );
        StoredContent stored = storedContent(
                artifact.artifactId(),
                artifact.version()
        );
        String format = textPreviewFormat(
                stored.mediaType(),
                stored.name().toLowerCase(Locale.ROOT)
        );
        if (format == null) {
            throw ToolRuntimeException.beforeCommit(
                    "artifact_text_unavailable",
                    "该 Artifact 不是可按 UTF-8 文本读取的格式；请使用匹配的领域能力"
            );
        }
        try {
            String window = objects.readUtf8Window(
                    stored.objectRef(),
                    startCharacter,
                    characterCount + 1
            );
            boolean hasMore = window.length() > characterCount;
            String content = hasMore
                    ? window.substring(0, characterCount)
                    : window;
            return new ArtifactTextWindow(
                    artifact.reference(),
                    artifact.title(),
                    format,
                    startCharacter,
                    content,
                    hasMore
                            ? startCharacter + content.length()
                            : null,
                    hasMore
            );
        } catch (IOException exception) {
            throw ToolRuntimeException.beforeCommit(
                    "artifact_text_invalid",
                    "Artifact 内容不是有效的 UTF-8 文本，无法按字符窗口读取"
            );
        }
    }

    public ArtifactContent previewImageContent(
            String artifactId,
            int version
    ) {
        ArtifactSnapshot artifact = requireById(artifactId, version);
        if (!isSafePreviewImage(artifact.mediaType())) {
            throw new ToolRuntimeException(
                    "artifact_preview_not_available",
                    "该 Artifact 不允许通过图片预览端点读取"
            );
        }
        return content(artifactId, version);
    }

    public ObjectNode previewToJson(ArtifactPreview preview) {
        ObjectNode result = objectMapper.createObjectNode();
        result.put("artifactId", preview.artifactId());
        result.put("artifactRef", preview.artifactRef());
        result.put("title", preview.title());
        result.put("mode", preview.mode());
        if (preview.format() != null) {
            result.put("format", preview.format());
        }
        if (preview.content() != null) {
            result.put("content", preview.content());
        }
        result.put("truncated", preview.truncated());
        result.put("byteCount", preview.byteCount());
        if (preview.contentRef() != null) {
            result.put("contentRef", preview.contentRef());
        }
        if (preview.message() != null) {
            result.put("message", preview.message());
        }
        return result;
    }

    private StoredContent storedContent(String artifactId, int version) {
        return jdbc.sql("""
                SELECT name, media_type, object_ref, byte_count
                FROM (
                  SELECT a.artifact_id, v.artifact_version,
                         a.name, v.media_type, v.object_ref, v.byte_count
                  FROM artifact a
                  JOIN artifact_version v
                    ON v.artifact_id = a.artifact_id
                  UNION ALL
                  SELECT a.artifact_id, v.artifact_version,
                         a.name, v.media_type, v.object_ref, v.byte_count
                  FROM user_artifact a
                  JOIN user_artifact_version v
                    ON v.artifact_id = a.artifact_id
                )
                WHERE artifact_id = :artifactId
                  AND artifact_version = :version
                """)
                .param("artifactId", artifactId)
                .param("version", version)
                .query((rs, row) -> new StoredContent(
                        rs.getString("name"),
                        rs.getString("media_type"),
                        rs.getString("object_ref"),
                        rs.getLong("byte_count")
                ))
                .single();
    }

    public ObjectNode toJson(ArtifactSnapshot artifact) {
        ObjectNode result = objectMapper.createObjectNode();
        result.put("artifactId", artifact.artifactId());
        result.put("artifactRef", artifact.reference());
        result.put("version", artifact.version());
        result.put("name", artifact.name());
        result.put("title", artifact.title());
        result.put("kind", artifact.kind());
        result.put("sourceKind", artifact.sourceKind());
        result.put("sourceRef", artifact.sourceRef());
        result.put("mediaType", artifact.mediaType());
        result.put("byteCount", artifact.byteCount());
        result.put("contentHash", artifact.contentHash());
        if (artifact.workspacePath() != null) {
            result.put("workspacePath", artifact.workspacePath());
            result.put("workspaceVersion", artifact.workspaceVersion());
        }
        if (artifact.originExecutionId() != null) {
            result.put("originExecutionId", artifact.originExecutionId());
        }
        ArrayNode visibility = result.putArray("visibility");
        artifact.visibility().forEach(visibility::add);
        result.put("createdAt", artifact.createdAt().toString());
        return result;
    }

    private Optional<ArtifactSnapshot> find(
            ArtifactAddress address,
            String conversationId
    ) {
        return jdbc.sql("""
                SELECT *
                FROM (
                  SELECT a.artifact_id, v.artifact_version,
                         a.conversation_id, a.name, a.title, a.kind,
                         'tool' AS source_kind,
                         v.registration_execution_id AS source_ref,
                         v.media_type, v.content_hash, v.byte_count,
                         v.workspace_path, v.workspace_version,
                         v.origin_execution_id, v.created_at
                  FROM artifact a
                  JOIN artifact_version v
                    ON v.artifact_id = a.artifact_id
                  UNION ALL
                  SELECT a.artifact_id, v.artifact_version,
                         a.conversation_id, a.name, a.title, a.kind,
                         'user_upload' AS source_kind,
                         a.upload_id AS source_ref,
                         v.media_type, v.content_hash, v.byte_count,
                         NULL AS workspace_path,
                         NULL AS workspace_version,
                         NULL AS origin_execution_id, v.created_at
                  FROM user_artifact a
                  JOIN user_artifact_version v
                    ON v.artifact_id = a.artifact_id
                )
                WHERE artifact_id = :artifactId
                  AND artifact_version = :version
                  AND conversation_id = :conversationId
                """)
                .param("artifactId", address.artifactId())
                .param("version", address.version())
                .param("conversationId", conversationId)
                .query((rs, row) -> new ArtifactSnapshot(
                        rs.getString("artifact_id"),
                        rs.getInt("artifact_version"),
                        reference(
                                rs.getString("artifact_id"),
                                rs.getInt("artifact_version")
                        ),
                        rs.getString("name"),
                        rs.getString("title"),
                        rs.getString("kind"),
                        rs.getString("source_kind"),
                        rs.getString("source_ref"),
                        rs.getString("media_type"),
                        rs.getString("content_hash"),
                        rs.getLong("byte_count"),
                        rs.getString("workspace_path"),
                        rs.getString("workspace_version"),
                        rs.getString("origin_execution_id"),
                        visibility(
                                rs.getString("artifact_id"),
                                rs.getInt("artifact_version")
                        ),
                        Instant.parse(rs.getString("created_at"))
                ))
                .optional();
    }

    private List<String> visibility(String artifactId, int version) {
        return jdbc.sql("""
                SELECT visibility
                FROM artifact_visibility
                WHERE artifact_id = :artifactId
                  AND artifact_version = :version
                ORDER BY CASE visibility
                  WHEN 'internal' THEN 0
                  WHEN 'model_context' THEN 1
                  WHEN 'user_timeline' THEN 2
                  ELSE 9 END
                """)
                .param("artifactId", artifactId)
                .param("version", version)
                .query(String.class)
                .list();
    }

    private void insertVisibility(
            String artifactId,
            int version,
            String visibility,
            String executionId,
            String runId,
            Instant now
    ) {
        jdbc.sql("""
                INSERT INTO artifact_visibility (
                  artifact_id, artifact_version, visibility,
                  source_execution_id, source_run_id, created_at
                ) VALUES (
                  :artifactId, :version, :visibility,
                  :executionId, :runId, :createdAt
                )
                ON CONFLICT(artifact_id, artifact_version, visibility)
                DO NOTHING
                """)
                .param("artifactId", artifactId)
                .param("version", version)
                .param("visibility", visibility)
                .param("executionId", executionId)
                .param("runId", runId)
                .param("createdAt", now.toString())
                .update();
    }

    private void insertPublication(
            String artifactId,
            int version,
            String visibility,
            String executionId,
            String runId,
            Instant now
    ) {
        jdbc.sql("""
                INSERT INTO artifact_publication (
                  publication_execution_id, artifact_id, artifact_version,
                  visibility, source_run_id, created_at
                ) VALUES (
                  :executionId, :artifactId, :version,
                  :visibility, :runId, :createdAt
                )
                ON CONFLICT(publication_execution_id) DO NOTHING
                """)
                .param("executionId", executionId)
                .param("artifactId", artifactId)
                .param("version", version)
                .param("visibility", visibility)
                .param("runId", runId)
                .param("createdAt", now.toString())
                .update();
    }

    private void requireOrigin(
            String conversationId,
            String executionId
    ) {
        if (executionId == null || executionId.isBlank()) {
            return;
        }
        boolean exists = jdbc.sql("""
                SELECT COUNT(*)
                FROM tool_execution
                WHERE execution_id = :executionId
                  AND conversation_id = :conversationId
                  AND phase = 'succeeded'
                """)
                .param("executionId", executionId)
                .param("conversationId", conversationId)
                .query(Integer.class)
                .single() == 1;
        if (!exists) {
            throw ToolRuntimeException.beforeCommit(
                    "artifact_origin_unavailable",
                    "origin_execution_id 必须引用当前对话中已成功的工具执行"
            );
        }
    }

    private Scope scope(String runId) {
        return jdbc.sql("""
                SELECT conversation_id, branch_id
                FROM agent_run
                WHERE run_id = :runId
                """)
                .param("runId", runId)
                .query((rs, row) -> new Scope(
                        rs.getString("conversation_id"),
                        rs.getString("branch_id")
                ))
                .optional()
                .orElseThrow(() -> new ToolRuntimeException(
                        "artifact_scope_unavailable",
                        "无法确定 Artifact 所属的对话与分支"
                ));
    }

    private ArtifactAddress address(String reference) {
        Matcher matcher = REF.matcher(reference == null ? "" : reference);
        if (!matcher.matches()) {
            throw ToolRuntimeException.beforeCommit(
                    "invalid_artifact_reference",
                    "Artifact 引用必须形如 artifact://artifact_<id>@<version>"
            );
        }
        return new ArtifactAddress(
                matcher.group(1),
                Integer.parseInt(matcher.group(2))
        );
    }

    private String reference(String artifactId, int version) {
        return "artifact://" + artifactId + "@" + version;
    }

    private String mediaType(java.nio.file.Path physicalPath) {
        try {
            String probed = Files.probeContentType(physicalPath);
            if (probed != null && !probed.isBlank()) {
                return probed;
            }
        } catch (IOException ignored) {
            // Extension fallback below remains deterministic.
        }
        String lower = physicalPath.getFileName()
                .toString().toLowerCase(Locale.ROOT);
        if (lower.endsWith(".html") || lower.endsWith(".htm")) {
            return "text/html";
        }
        if (lower.endsWith(".xlsx")) {
            return "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";
        }
        if (lower.endsWith(".pdf")) {
            return "application/pdf";
        }
        if (lower.endsWith(".json")) {
            return "application/json";
        }
        if (lower.endsWith(".csv")) {
            return "text/csv";
        }
        return "application/octet-stream";
    }

    private boolean branchBelongsToConversation(
            String branchId,
            String conversationId
    ) {
        return jdbc.sql("""
                SELECT COUNT(*)
                FROM conversation_branch
                WHERE branch_id = :branchId
                  AND conversation_id = :conversationId
                """)
                .param("branchId", branchId)
                .param("conversationId", conversationId)
                .query(Integer.class)
                .single() == 1;
    }

    private String safeFileName(String submittedName) {
        String leaf = submittedName == null
                ? ""
                : Path.of(submittedName).getFileName().toString().trim();
        if (leaf.isBlank() || leaf.length() > 240) {
            throw new ToolRuntimeException(
                    "invalid_artifact_name",
                    "上传文件名为空或过长"
            );
        }
        return leaf;
    }

    private String normalizeMediaType(String submitted, String name) {
        if (submitted != null
                && submitted.length() <= 200
                && submitted.matches(
                        "[A-Za-z0-9!#$&^_.+-]+/[A-Za-z0-9!#$&^_.+-]+"
                )) {
            return submitted.toLowerCase(Locale.ROOT);
        }
        return mediaType(Path.of(name));
    }

    private boolean isSafePreviewImage(String mediaType) {
        return switch (mediaType.toLowerCase(Locale.ROOT)) {
            case "image/png", "image/jpeg", "image/gif", "image/webp" -> true;
            default -> false;
        };
    }

    private String textPreviewFormat(String mediaType, String lowerName) {
        String normalized = mediaType.toLowerCase(Locale.ROOT);
        if ("text/html".equals(normalized)
                || "image/svg+xml".equals(normalized)) {
            return null;
        }
        if (lowerName.endsWith(".md")
                || lowerName.endsWith(".markdown")
                || "text/markdown".equals(normalized)) {
            return "markdown";
        }
        if (lowerName.endsWith(".json")
                || "application/json".equals(normalized)
                || normalized.endsWith("+json")) {
            return "json";
        }
        if (normalized.startsWith("text/")
                || "application/xml".equals(normalized)
                || normalized.endsWith("+xml")) {
            return "plain";
        }
        return null;
    }

    private String blankToNull(String value) {
        return value == null || value.isBlank() ? null : value;
    }

    public record WorkspaceCandidate(
            String logicalPath,
            String version,
            long byteCount,
            TargetState target
    ) {
    }

    public record ArtifactSnapshot(
            String artifactId,
            int version,
            String reference,
            String name,
            String title,
            String kind,
            String sourceKind,
            String sourceRef,
            String mediaType,
            String contentHash,
            long byteCount,
            String workspacePath,
            String workspaceVersion,
            String originExecutionId,
            List<String> visibility,
            Instant createdAt
    ) {
        public ArtifactSnapshot {
            visibility = List.copyOf(visibility);
        }
    }

    public record ArtifactContent(
            String name,
            String mediaType,
            byte[] bytes
    ) {
        public ArtifactContent {
            bytes = bytes.clone();
        }

        @Override
        public byte[] bytes() {
            return bytes.clone();
        }
    }

    public record ArtifactPreview(
            String artifactId,
            String artifactRef,
            String title,
            String mode,
            String format,
            String content,
            boolean truncated,
            long byteCount,
            String contentRef,
            String message
    ) {
    }

    public record ArtifactTextWindow(
            String artifactRef,
            String title,
            String format,
            int startCharacter,
            String content,
            Integer nextStartCharacter,
            boolean hasMore
    ) {
    }

    private record ArtifactAddress(String artifactId, int version) {
    }

    private record StoredContent(
            String name,
            String mediaType,
            String objectRef,
            long byteCount
    ) {
    }

    private record Scope(String conversationId, String branchId) {
    }
}
