package com.iris.workspace;

import com.iris.storage.ManagedObjectStore;
import com.iris.storage.ManagedObjectStore.StoredObject;
import com.iris.tools.core.ToolRuntimeException;
import com.iris.workspace.WorkspaceFileMutationService.ResourceKind;
import org.springframework.jdbc.core.simple.JdbcClient;
import org.springframework.stereotype.Service;
import org.springframework.transaction.support.TransactionTemplate;

import java.io.IOException;
import java.nio.file.Files;
import java.nio.file.LinkOption;
import java.sql.Types;
import java.time.Clock;
import java.time.Instant;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Optional;
import java.util.UUID;

/**
 * 一次工作区写操作的可恢复资源集合。
 *
 * <p>Checkpoint 对外是一个 ID，内部可以包含多个稳定排序的文件状态。
 * 对象内容先落不可变对象仓，SQL 再一次性声明整组已捕获。</p>
 */
@Service
public class WorkspaceCheckpointService {

    private static final long MAX_CHECKPOINT_BYTES = 32L * 1024 * 1024;

    private final JdbcClient jdbc;
    private final ManagedObjectStore objects;
    private final TransactionTemplate transactions;
    private final Clock clock = Clock.systemUTC();

    public WorkspaceCheckpointService(
            JdbcClient jdbc,
            ManagedObjectStore objects,
            TransactionTemplate transactions
    ) {
        this.jdbc = jdbc;
        this.objects = objects;
        this.transactions = transactions;
    }

    public void requireCapturable(
            WorkspaceFileMutationService.TargetState target
    ) {
        if (target.sizeBytes() > MAX_CHECKPOINT_BYTES) {
            throw new ToolRuntimeException(
                    "workspace_checkpoint_too_large",
                    "原文件超过 Checkpoint 上限，Iris 不会执行这次写入"
            );
        }
    }

    public Checkpoint capture(
            String executionId,
            String changeKind,
            WorkspaceFileMutationService.TargetState target
    ) throws IOException {
        CheckpointSet checkpoint = capture(
                executionId,
                List.of(new CheckpointTarget(changeKind, target))
        );
        CheckpointSnapshot item = checkpoint.items().getFirst();
        return new Checkpoint(
                checkpoint.checkpointId(),
                item.logicalPath(),
                item.beforeHash(),
                item.beforeSize()
        );
    }

    public CheckpointSet capture(
            String executionId,
            List<CheckpointTarget> targets
    ) throws IOException {
        if (targets == null || targets.isEmpty()) {
            throw new IllegalArgumentException(
                    "Checkpoint must contain at least one resource"
            );
        }
        Map<String, PreparedSnapshot> prepared = new LinkedHashMap<>();
        for (CheckpointTarget requested : targets) {
            if (requested == null
                    || requested.changeKind() == null
                    || requested.changeKind().isBlank()
                    || requested.target() == null) {
                throw new IllegalArgumentException(
                        "Checkpoint target is incomplete"
                );
            }
            WorkspaceFileMutationService.TargetState target =
                    requested.target();
            if (prepared.containsKey(target.logicalPath())) {
                throw new IllegalArgumentException(
                        "Checkpoint contains duplicate path: "
                                + target.logicalPath()
                );
            }
            requireCapturable(target);
            prepared.put(
                    target.logicalPath(),
                    prepareSnapshot(requested.changeKind(), target)
            );
        }

        String checkpointId = "checkpoint_"
                + UUID.randomUUID().toString().replace("-", "");
        Instant now = clock.instant();
        transactions.executeWithoutResult(status -> {
            jdbc.sql("""
                    INSERT INTO workspace_checkpoint_set(
                        checkpoint_id, execution_id, phase, created_at
                    ) VALUES (
                        :checkpointId, :executionId, 'captured', :now
                    )
                    """)
                    .param("checkpointId", checkpointId)
                    .param("executionId", executionId)
                    .param("now", now.toString())
                    .update();
            int ordinal = 0;
            for (PreparedSnapshot item : prepared.values()) {
                insertItem(checkpointId, ordinal++, item);
            }
        });
        return findById(checkpointId).orElseThrow(() ->
                new IllegalStateException(
                        "Checkpoint disappeared after commit"
                )
        );
    }

    public void markApplied(String checkpointId, String afterHash) {
        CheckpointSet checkpoint = findById(checkpointId).orElseThrow(
                () -> new IllegalStateException("Checkpoint not found")
        );
        if (checkpoint.items().size() != 1) {
            throw new IllegalArgumentException(
                    "Multi-resource Checkpoint needs one after-state per path"
            );
        }
        markApplied(
                checkpointId,
                List.of(new AppliedResource(
                        checkpoint.items().getFirst().logicalPath(),
                        afterHash
                ))
        );
    }

    public void markApplied(
            String checkpointId,
            List<AppliedResource> resources
    ) {
        CheckpointSet checkpoint = findById(checkpointId).orElseThrow(
                () -> new IllegalStateException("Checkpoint not found")
        );
        Map<String, String> afterByPath = new LinkedHashMap<>();
        for (AppliedResource resource : resources) {
            String previous = afterByPath.put(
                    resource.logicalPath(),
                    resource.afterHash()
            );
            if (previous != null) {
                throw new IllegalArgumentException(
                        "Duplicate applied resource: "
                                + resource.logicalPath()
                );
            }
        }
        if (afterByPath.size() != checkpoint.items().size()
                || checkpoint.items().stream().anyMatch(item ->
                !afterByPath.containsKey(item.logicalPath()))) {
            throw new IllegalArgumentException(
                    "Applied resources do not match captured Checkpoint"
            );
        }

        Instant now = clock.instant();
        transactions.executeWithoutResult(status -> {
            for (CheckpointSnapshot item : checkpoint.items()) {
                int updated = jdbc.sql("""
                        UPDATE workspace_checkpoint_item
                        SET after_hash = :afterHash
                        WHERE checkpoint_id = :checkpointId
                          AND logical_path = :logicalPath
                          AND after_hash IS NULL
                        """)
                        .param(
                                "afterHash",
                                afterByPath.get(item.logicalPath())
                        )
                        .param("checkpointId", checkpointId)
                        .param("logicalPath", item.logicalPath())
                        .update();
                if (updated != 1) {
                    throw new IllegalStateException(
                            "Checkpoint item changed before apply confirmation"
                    );
                }
            }
            int updated = jdbc.sql("""
                    UPDATE workspace_checkpoint_set
                    SET phase = 'applied', applied_at = :now
                    WHERE checkpoint_id = :checkpointId
                      AND phase = 'captured'
                    """)
                    .param("now", now.toString())
                    .param("checkpointId", checkpointId)
                    .update();
            if (updated != 1) {
                throw new IllegalStateException(
                        "Checkpoint state changed before apply confirmation"
                );
            }
        });
    }

    public Optional<CheckpointSet> find(
            String conversationId,
            String checkpointId
    ) {
        Optional<String> visibleId = jdbc.sql("""
                SELECT s.checkpoint_id
                FROM workspace_checkpoint_set s
                JOIN tool_execution e
                  ON e.execution_id = s.execution_id
                WHERE s.checkpoint_id = :checkpointId
                  AND e.conversation_id = :conversationId
                """)
                .param("checkpointId", checkpointId)
                .param("conversationId", conversationId)
                .query(String.class)
                .optional();
        return visibleId.flatMap(this::findById);
    }

    public Optional<CheckpointSet> findByExecution(
            String conversationId,
            String executionId
    ) {
        Optional<String> checkpointId = jdbc.sql("""
                SELECT s.checkpoint_id
                FROM workspace_checkpoint_set s
                JOIN tool_execution e
                  ON e.execution_id = s.execution_id
                WHERE s.execution_id = :executionId
                  AND e.conversation_id = :conversationId
                """)
                .param("executionId", executionId)
                .param("conversationId", conversationId)
                .query(String.class)
                .optional();
        return checkpointId.flatMap(this::findById);
    }

    public byte[] readBeforeContent(CheckpointSnapshot checkpoint)
            throws IOException {
        if (!checkpoint.beforeExists()) {
            return null;
        }
        if (checkpoint.resourceKind() != ResourceKind.FILE) {
            throw new IllegalArgumentException(
                    "Directory Checkpoint has no content object"
            );
        }
        String objectRef = checkpoint.beforeObjectRef();
        if (objectRef == null
                || !objectRef.equals(
                "object://sha256/" + checkpoint.beforeHash()
        )) {
            throw new IllegalStateException(
                    "Checkpoint object reference does not match its hash"
            );
        }
        byte[] content = objects.readBytes(
                objectRef,
                MAX_CHECKPOINT_BYTES
        );
        if (content.length != checkpoint.beforeSize()) {
            throw new IOException(
                    "Checkpoint object size does not match its metadata"
            );
        }
        return content;
    }

    private PreparedSnapshot prepareSnapshot(
            String changeKind,
            WorkspaceFileMutationService.TargetState target
    ) throws IOException {
        String beforeObjectRef;
        if (target.exists() && target.kind() == ResourceKind.FILE) {
            byte[] beforeContent = Files.readAllBytes(target.physicalPath());
            StoredObject stored = objects.put(beforeContent);
            if (!stored.contentHash().equals(target.version())) {
                throw new ToolRuntimeException(
                        "workspace_file_version_changed",
                        "文件在创建 Checkpoint 时发生变化；请重新发起操作"
                );
            }
            beforeObjectRef = stored.objectRef();
        } else if (!target.exists()) {
            if (Files.exists(
                    target.physicalPath(),
                    LinkOption.NOFOLLOW_LINKS
            )) {
                throw new ToolRuntimeException(
                        "workspace_file_version_changed",
                        "目标文件在创建 Checkpoint 前已经出现；请重新发起操作"
                );
            }
            beforeObjectRef = null;
        } else {
            beforeObjectRef = null;
        }
        return new PreparedSnapshot(changeKind, target, beforeObjectRef);
    }

    private void insertItem(
            String checkpointId,
            int ordinal,
            PreparedSnapshot prepared
    ) {
        WorkspaceFileMutationService.TargetState target = prepared.target();
        jdbc.sql("""
                INSERT INTO workspace_checkpoint_item(
                    checkpoint_id, ordinal, logical_path, resource_kind,
                    change_kind,
                    before_exists, before_object_ref, before_hash, before_size,
                    before_modified_at
                ) VALUES (
                    :checkpointId, :ordinal, :logicalPath, :resourceKind,
                    :changeKind,
                    :beforeExists, :beforeObjectRef, :beforeHash, :beforeSize,
                    :beforeModifiedAt
                )
                """)
                .param("checkpointId", checkpointId)
                .param("ordinal", ordinal)
                .param("logicalPath", target.logicalPath())
                .param(
                        "resourceKind",
                        target.kind().name().toLowerCase()
                )
                .param("changeKind", prepared.changeKind())
                .param("beforeExists", target.exists() ? 1 : 0)
                .param("beforeObjectRef", prepared.beforeObjectRef(), Types.VARCHAR)
                .param("beforeHash", target.version())
                .param("beforeSize", target.sizeBytes())
                .param(
                        "beforeModifiedAt",
                        target.modifiedAt() == null
                                ? null
                                : target.modifiedAt().toString(),
                        Types.VARCHAR
                )
                .update();
    }

    private Optional<CheckpointSet> findById(String checkpointId) {
        Optional<CheckpointHeader> header = jdbc.sql("""
                SELECT checkpoint_id, phase
                FROM workspace_checkpoint_set
                WHERE checkpoint_id = :checkpointId
                """)
                .param("checkpointId", checkpointId)
                .query((rs, rowNum) -> new CheckpointHeader(
                        rs.getString("checkpoint_id"),
                        rs.getString("phase")
                ))
                .optional();
        if (header.isEmpty()) {
            return Optional.empty();
        }
        List<CheckpointSnapshot> items = jdbc.sql("""
                SELECT checkpoint_id, ordinal, logical_path, resource_kind,
                       change_kind,
                       before_exists, before_object_ref, before_hash,
                       before_size, after_hash
                FROM workspace_checkpoint_item
                WHERE checkpoint_id = :checkpointId
                ORDER BY ordinal
                """)
                .param("checkpointId", checkpointId)
                .query((rs, rowNum) -> new CheckpointSnapshot(
                        rs.getString("checkpoint_id"),
                        rs.getInt("ordinal"),
                        rs.getString("logical_path"),
                        ResourceKind.valueOf(
                                rs.getString("resource_kind").toUpperCase()
                        ),
                        rs.getString("change_kind"),
                        rs.getInt("before_exists") == 1,
                        rs.getString("before_object_ref"),
                        rs.getString("before_hash"),
                        rs.getLong("before_size"),
                        rs.getString("after_hash")
                ))
                .list();
        if (items.isEmpty()) {
            throw new IllegalStateException(
                    "Checkpoint has no captured resources"
            );
        }
        return Optional.of(new CheckpointSet(
                header.get().checkpointId(),
                header.get().phase(),
                items
        ));
    }

    public record Checkpoint(
            String checkpointId,
            String logicalPath,
            String beforeHash,
            long beforeSize
    ) {
    }

    public record CheckpointTarget(
            String changeKind,
            WorkspaceFileMutationService.TargetState target
    ) {
    }

    public record AppliedResource(
            String logicalPath,
            String afterHash
    ) {
    }

    public record CheckpointSet(
            String checkpointId,
            String phase,
            List<CheckpointSnapshot> items
    ) {
        public CheckpointSet {
            items = List.copyOf(items);
        }
    }

    public record CheckpointSnapshot(
            String checkpointId,
            int ordinal,
            String logicalPath,
            ResourceKind resourceKind,
            String changeKind,
            boolean beforeExists,
            String beforeObjectRef,
            String beforeHash,
            long beforeSize,
            String afterHash
    ) {
    }

    private record PreparedSnapshot(
            String changeKind,
            WorkspaceFileMutationService.TargetState target,
            String beforeObjectRef
    ) {
    }

    private record CheckpointHeader(
            String checkpointId,
            String phase
    ) {
    }
}
