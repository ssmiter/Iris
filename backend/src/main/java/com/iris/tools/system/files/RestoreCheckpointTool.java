package com.iris.tools.system.files;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.node.ArrayNode;
import com.fasterxml.jackson.databind.node.ObjectNode;
import com.iris.tools.core.CommittedOperation;
import com.iris.tools.core.PreparedOperation;
import com.iris.tools.core.PreparedOperation.ResourceClaim;
import com.iris.tools.core.RiskLevel;
import com.iris.tools.core.Tool;
import com.iris.tools.core.ToolContext;
import com.iris.tools.core.ToolManifest;
import com.iris.tools.core.ToolOutcome;
import com.iris.tools.core.ToolRuntimeException;
import com.iris.tools.core.VerificationResult;
import com.iris.workspace.WorkspaceCheckpointService;
import com.iris.workspace.WorkspaceCheckpointService.AppliedResource;
import com.iris.workspace.WorkspaceCheckpointService.CheckpointSet;
import com.iris.workspace.WorkspaceCheckpointService.CheckpointSnapshot;
import com.iris.workspace.WorkspaceCheckpointService.CheckpointTarget;
import com.iris.workspace.WorkspaceFileMutationService;
import com.iris.workspace.WorkspaceFileMutationService.ResourceKind;
import com.iris.workspace.WorkspaceFileMutationService.TargetState;
import org.springframework.stereotype.Component;

import java.io.IOException;
import java.time.Instant;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

/**
 * 把一个已确认应用的 Checkpoint 整体恢复到写前状态。
 */
@Component
public class RestoreCheckpointTool implements Tool {

    private final ObjectMapper objectMapper;
    private final WorkspaceFileMutationService files;
    private final WorkspaceCheckpointService checkpoints;
    private final ToolManifest manifest;

    public RestoreCheckpointTool(
            ObjectMapper objectMapper,
            WorkspaceFileMutationService files,
            WorkspaceCheckpointService checkpoints
    ) {
        this.objectMapper = objectMapper;
        this.files = files;
        this.checkpoints = checkpoints;
        this.manifest = new ToolManifest(
                "iris.system.files.restore_checkpoint",
                "3",
                "restore_checkpoint",
                "整体恢复一次工作区操作涉及的全部文件；用户要求撤销已完成文件操作时使用",
                inputSchema(),
                outputSchema(),
                RiskLevel.STANDARD,
                ToolManifest.SideEffect.WORKSPACE_WRITE,
                30,
                12_000,
                ToolManifest.IdempotencySemantics.IDEMPOTENT_WITH_KEY,
                ToolManifest.EvidencePolicy.REQUIRED
        );
    }

    @Override
    public ToolManifest manifest() {
        return manifest;
    }

    @Override
    public PreparedOperation prepare(JsonNode input, ToolContext context)
            throws IOException {
        String checkpointId = requiredCheckpointId(input);
        CheckpointSet source = requireRestorable(
                context.conversationId(),
                checkpointId
        );
        List<ResourceClaim> resources = new ArrayList<>();
        long restoredBytes = 0;
        for (CheckpointSnapshot item : source.items()) {
            TargetState current = inspectResource(context, item);
            requireCurrentVersion(item, current);
            checkpoints.requireCapturable(current);
            resources.add(new ResourceClaim(
                    "workspace_file",
                    item.logicalPath(),
                    current.version()
            ));
            if (item.beforeExists()) {
                restoredBytes += item.beforeSize();
            }
        }

        ObjectNode normalized = objectMapper.createObjectNode();
        normalized.put("checkpoint_id", checkpointId);
        String impact = source.items().size() == 1
                ? singleImpact(source.items().getFirst())
                : "将整体撤销 Checkpoint " + checkpointId
                        + " 对 " + source.items().size()
                        + " 个工作区文件的改变（恢复内容共 "
                        + restoredBytes
                        + " 字节）；恢复前再次保存全部当前状态";
        return new PreparedOperation(
                normalized,
                impact,
                resources,
                Instant.now().plusSeconds(300)
        );
    }

    @Override
    public ToolOutcome execute(
            CommittedOperation operation,
            ToolContext context
    ) throws IOException {
        String checkpointId = operation.normalizedInput()
                .path("checkpoint_id").asText();
        CheckpointSet source = requireRestorable(
                context.conversationId(),
                checkpointId
        );
        Map<String, ResourceClaim> claims = claimsByPath(
                operation.resources()
        );
        List<CurrentItem> currentItems = new ArrayList<>();
        for (CheckpointSnapshot item : source.items()) {
            ResourceClaim claim = claims.get(item.logicalPath());
            if (claim == null) {
                throw new IllegalStateException(
                        "Checkpoint resource is missing from committed snapshot"
                );
            }
            TargetState current = inspectResource(context, item);
            files.requireVersion(current, claim.expectedVersion());
            requireCurrentVersion(item, current);
            currentItems.add(new CurrentItem(item, current));
        }
        if (claims.size() != currentItems.size()) {
            throw new IllegalStateException(
                    "Committed snapshot contains unexpected resources"
            );
        }
        if (context.cancelled()) {
            throw ToolRuntimeException.beforeCommit(
                    "cancelled_before_commit",
                    "任务已停止，Checkpoint 尚未恢复"
            );
        }

        CheckpointSet recovery = checkpoints.capture(
                operation.executionId(),
                currentItems.stream()
                        .map(item -> new CheckpointTarget(
                                "restore",
                                item.current()
                        ))
                        .toList()
        );
        if (context.cancelled()) {
            throw ToolRuntimeException.beforeCommit(
                    "cancelled_before_commit",
                    "任务已停止，Checkpoint 尚未恢复"
            );
        }

        // 先移除原本不存在的目标，再恢复原本存在的内容。
        for (CurrentItem item : currentItems) {
            if (!item.snapshot().beforeExists()
                    && item.current().exists()) {
                if (item.snapshot().resourceKind() == ResourceKind.FILE) {
                    files.deleteFile(item.current());
                } else {
                    files.deleteDirectory(item.current());
                }
            }
        }
        for (CurrentItem item : currentItems) {
            if (item.snapshot().beforeExists()) {
                if (item.snapshot().resourceKind() == ResourceKind.FILE) {
                    byte[] content = checkpoints.readBeforeContent(
                            item.snapshot()
                    );
                    if (content == null) {
                        throw new IllegalStateException(
                                "Checkpoint 声明原文件存在但缺少内容"
                        );
                    }
                    files.writeBytes(item.current(), content);
                } else if (!item.current().exists()) {
                    files.createDirectory(item.current());
                }
            }
        }

        List<AppliedResource> applied = new ArrayList<>();
        ArrayNode restored = objectMapper.createArrayNode();
        for (CurrentItem item : currentItems) {
            String afterHash = files.versionOf(item.current());
            applied.add(new AppliedResource(
                    item.current().logicalPath(),
                    afterHash
            ));
            ObjectNode resource = restored.addObject();
            resource.put("path", item.current().logicalPath());
            resource.put("beforeRestoreHash", item.current().version());
            resource.put("afterRestoreHash", afterHash);
        }
        checkpoints.markApplied(recovery.checkpointId(), applied);

        ObjectNode output = objectMapper.createObjectNode();
        output.put("restoredCheckpointId", source.checkpointId());
        output.put("recoveryCheckpointId", recovery.checkpointId());
        output.put(
                "changeKind",
                source.items().size() == 1
                        ? "resource_restored"
                        : "resource_set_restored"
        );
        output.set("resources", restored);
        return ToolOutcome.succeeded(output);
    }

    @Override
    public VerificationResult verify(
            ToolOutcome outcome,
            CommittedOperation operation,
            ToolContext context
    ) throws IOException {
        String checkpointId = operation.normalizedInput()
                .path("checkpoint_id").asText();
        CheckpointSet source = requireRestorable(
                context.conversationId(),
                checkpointId
        );
        for (CheckpointSnapshot item : source.items()) {
            TargetState current = inspectResource(context, item);
            if (!current.version().equals(item.beforeHash())) {
                return new VerificationResult(
                        VerificationResult.Status.UNKNOWN,
                        List.of(),
                        "恢复操作已返回，但资源集的最终版本无法完整确认"
                );
            }
        }
        return VerificationResult.confirmed(List.of(
                new VerificationResult.Evidence(
                        "workspace_resource_set",
                        source.checkpointId(),
                        "Checkpoint 中 " + source.items().size()
                                + " 个资源均已恢复到写前版本"
                ),
                new VerificationResult.Evidence(
                        "workspace_checkpoint",
                        outcome.output()
                                .path("recoveryCheckpointId").asText(),
                        "恢复前的资源集已再次整体保留，可撤销本次恢复"
                )
        ));
    }

    private String requiredCheckpointId(JsonNode input) {
        String checkpointId = input.path("checkpoint_id").asText();
        if (checkpointId.isBlank()) {
            throw new ToolRuntimeException(
                    "invalid_tool_input",
                    "checkpoint_id 不能为空"
            );
        }
        return checkpointId;
    }

    private CheckpointSet requireRestorable(
            String conversationId,
            String checkpointId
    ) {
        CheckpointSet source = checkpoints.find(
                conversationId,
                checkpointId
        ).orElseThrow(() -> new ToolRuntimeException(
                "workspace_checkpoint_not_found",
                "当前对话中找不到 Checkpoint " + checkpointId
        ));
        if (!"applied".equals(source.phase())
                || source.items().stream().anyMatch(
                item -> item.afterHash() == null
        )) {
            throw new ToolRuntimeException(
                    "workspace_checkpoint_not_applied",
                    "Checkpoint 尚未确认整体应用，不能直接恢复；请先核对原操作结果"
            );
        }
        return source;
    }

    private void requireCurrentVersion(
            CheckpointSnapshot item,
            TargetState current
    ) {
        if (!current.version().equals(item.afterHash())) {
            throw new ToolRuntimeException(
                    "workspace_checkpoint_target_changed",
                    "工作区文件 " + item.logicalPath()
                            + " 在该 Checkpoint 应用后又发生变化；"
                            + "Iris 不会覆盖后续修改"
            );
        }
    }

    private TargetState inspectResource(
            ToolContext context,
            CheckpointSnapshot item
    ) throws IOException {
        return item.resourceKind() == ResourceKind.FILE
                ? files.inspect(
                        context.workspaceRoot(),
                        item.logicalPath()
                )
                : files.inspectDirectory(
                        context.workspaceRoot(),
                        item.logicalPath()
                );
    }

    private Map<String, ResourceClaim> claimsByPath(
            List<ResourceClaim> resources
    ) {
        Map<String, ResourceClaim> result = new LinkedHashMap<>();
        for (ResourceClaim resource : resources) {
            if (result.put(resource.logicalPath(), resource) != null) {
                throw new IllegalStateException(
                        "Committed snapshot contains duplicate resource"
                );
            }
        }
        return result;
    }

    private String singleImpact(CheckpointSnapshot source) {
        return source.beforeExists()
                ? "将把工作区文件 " + source.logicalPath()
                        + " 恢复为 Checkpoint " + source.checkpointId()
                        + " 中的 " + source.beforeSize()
                        + " 字节内容；恢复前再次保存当前状态"
                : "将删除 Checkpoint " + source.checkpointId()
                        + " 之后创建的工作区文件 " + source.logicalPath()
                        + "；删除前再次保存当前状态";
    }

    private JsonNode inputSchema() {
        ObjectNode schema = WorkspaceFileToolSupport.objectSchema(objectMapper);
        ObjectNode properties = (ObjectNode) schema.path("properties");
        properties.putObject("checkpoint_id")
                .put("type", "string")
                .put("description", "待整体恢复的 Checkpoint ID");
        schema.putArray("required").add("checkpoint_id");
        return schema;
    }

    private JsonNode outputSchema() {
        ObjectNode schema = WorkspaceFileToolSupport.objectSchema(objectMapper);
        ObjectNode properties = (ObjectNode) schema.path("properties");
        properties.putObject("restoredCheckpointId")
                .put("type", "string")
                .put("description", "本次采用的原 Checkpoint");
        properties.putObject("recoveryCheckpointId")
                .put("type", "string")
                .put("description", "恢复前新建的整体可逆 Checkpoint");
        properties.putObject("changeKind")
                .put("type", "string")
                .put("description", "resource_restored 或 resource_set_restored");
        ObjectNode resources = properties.putObject("resources");
        resources.put("type", "array");
        resources.put("description", "每个资源恢复前后的逻辑路径与内容版本");
        ObjectNode item = resources.putObject("items");
        item.put("type", "object");
        ObjectNode itemProperties = item.putObject("properties");
        itemProperties.putObject("path").put("type", "string");
        itemProperties.putObject("beforeRestoreHash").put("type", "string");
        itemProperties.putObject("afterRestoreHash").put("type", "string");
        schema.putArray("required")
                .add("restoredCheckpointId")
                .add("recoveryCheckpointId")
                .add("changeKind")
                .add("resources");
        return schema;
    }

    private record CurrentItem(
            CheckpointSnapshot snapshot,
            TargetState current
    ) {
    }
}
