package com.iris.tools.system.files;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.node.ArrayNode;
import com.fasterxml.jackson.databind.node.ObjectNode;
import com.iris.tools.core.CommittedOperation;
import com.iris.tools.core.PreparedOperation;
import com.iris.tools.core.RiskLevel;
import com.iris.tools.core.Tool;
import com.iris.tools.core.ToolContext;
import com.iris.tools.core.ToolManifest;
import com.iris.tools.core.ToolOutcome;
import com.iris.tools.core.ToolRuntimeException;
import com.iris.tools.core.VerificationResult;
import com.iris.workspace.WorkspaceCheckpointService;
import com.iris.workspace.WorkspaceCheckpointService.CheckpointSet;
import com.iris.workspace.WorkspaceCheckpointService.CheckpointSnapshot;
import com.iris.workspace.WorkspaceFileMutationService;
import com.iris.workspace.WorkspaceFileMutationService.ResourceKind;
import org.springframework.stereotype.Component;

import java.io.IOException;
import java.time.Instant;
import java.util.ArrayList;
import java.util.List;

/**
 * 只读核对一次工作区写操作的 Checkpoint 与当前资源状态。
 */
@Component
public class InspectWorkspaceChangeTool implements Tool {

    private final ObjectMapper objectMapper;
    private final WorkspaceCheckpointService checkpoints;
    private final WorkspaceFileMutationService files;
    private final ToolManifest manifest;

    public InspectWorkspaceChangeTool(
            ObjectMapper objectMapper,
            WorkspaceCheckpointService checkpoints,
            WorkspaceFileMutationService files
    ) {
        this.objectMapper = objectMapper;
        this.checkpoints = checkpoints;
        this.files = files;
        this.manifest = new ToolManifest(
                "iris.system.files.inspect_workspace_change",
                "1",
                "inspect_workspace_change",
                "按工具 execution_id 核对工作区写前、记录的写后与当前资源版本；处理 outcome_unknown 时使用",
                inputSchema(),
                outputSchema(),
                RiskLevel.READ_ONLY,
                ToolManifest.SideEffect.NONE,
                15,
                12_000,
                ToolManifest.IdempotencySemantics.IDEMPOTENT,
                ToolManifest.EvidencePolicy.SUMMARY,
                ToolManifest.ContextRetention.PINNED,
                ToolManifest.ConcurrencySemantics.PARALLEL_SAFE,
                ToolManifest.CancellationSemantics.COOPERATIVE
        );
    }

    @Override
    public ToolManifest manifest() {
        return manifest;
    }

    @Override
    public PreparedOperation prepare(JsonNode input, ToolContext context) {
        String executionId = input.path("execution_id").asText();
        if (executionId.isBlank()) {
            throw new ToolRuntimeException(
                    "invalid_tool_input",
                    "execution_id 不能为空"
            );
        }
        ObjectNode normalized = objectMapper.createObjectNode();
        normalized.put("execution_id", executionId);
        return new PreparedOperation(
                normalized,
                "只读核对工具执行 " + executionId
                        + " 的工作区 Checkpoint 与当前版本，不改变任何状态",
                List.of(),
                Instant.now().plusSeconds(60)
        );
    }

    @Override
    public ToolOutcome execute(
            CommittedOperation operation,
            ToolContext context
    ) throws IOException {
        String executionId = operation.normalizedInput()
                .path("execution_id").asText();
        CheckpointSet checkpoint = checkpoints.findByExecution(
                context.conversationId(),
                executionId
        ).orElseThrow(() -> new ToolRuntimeException(
                "workspace_checkpoint_not_found",
                "当前对话的执行 " + executionId
                        + " 没有工作区 Checkpoint；它可能尚未到达提交边界，"
                        + "也可能不是工作区写操作"
        ));

        ArrayNode resources = objectMapper.createArrayNode();
        List<Relation> relations = new ArrayList<>();
        for (CheckpointSnapshot item : checkpoint.items()) {
            if (context.cancelled()) {
                throw new ToolRuntimeException(
                        "tool_cancelled",
                        "核对已停止，未改变任何工作区状态"
                );
            }
            String currentHash = currentVersion(context, item);
            Relation relation = relation(item, currentHash);
            relations.add(relation);
            ObjectNode resource = resources.addObject();
            resource.put("path", item.logicalPath());
            resource.put(
                    "kind",
                    item.resourceKind().name().toLowerCase()
            );
            resource.put("changeKind", item.changeKind());
            resource.put("beforeHash", item.beforeHash());
            if (item.afterHash() == null) {
                resource.putNull("recordedAfterHash");
            } else {
                resource.put("recordedAfterHash", item.afterHash());
            }
            resource.put("currentHash", currentHash);
            resource.put("relation", relation.value);
        }

        Assessment assessment = assess(checkpoint, relations);
        ObjectNode output = objectMapper.createObjectNode();
        output.put("executionId", executionId);
        output.put("checkpointId", checkpoint.checkpointId());
        output.put("checkpointPhase", checkpoint.phase());
        output.put("assessment", assessment.value);
        output.set("resources", resources);
        output.put("guidance", assessment.guidance);
        return ToolOutcome.succeeded(output);
    }

    @Override
    public VerificationResult verify(
            ToolOutcome outcome,
            CommittedOperation operation,
            ToolContext context
    ) {
        return VerificationResult.confirmed(List.of(
                new VerificationResult.Evidence(
                        "workspace_checkpoint_comparison",
                        outcome.output().path("checkpointId").asText(),
                        "已只读比较 Checkpoint 资源集与当前工作区版本"
                )
        ));
    }

    private String currentVersion(
            ToolContext context,
            CheckpointSnapshot item
    ) throws IOException {
        try {
            return item.resourceKind() == ResourceKind.FILE
                    ? files.inspect(
                            context.workspaceRoot(),
                            item.logicalPath()
                    ).version()
                    : files.inspectDirectory(
                            context.workspaceRoot(),
                            item.logicalPath()
                    ).version();
        } catch (ToolRuntimeException exception) {
            if ("workspace_path_not_regular_file".equals(exception.code())
                    || "workspace_path_not_directory".equals(
                    exception.code()
            )) {
                return "type_changed";
            }
            throw exception;
        }
    }

    private Relation relation(
            CheckpointSnapshot item,
            String currentHash
    ) {
        if (item.afterHash() != null
                && item.afterHash().equals(currentHash)) {
            return Relation.MATCHES_AFTER;
        }
        if (item.beforeHash().equals(currentHash)) {
            return Relation.MATCHES_BEFORE;
        }
        return Relation.DIVERGED;
    }

    private Assessment assess(
            CheckpointSet checkpoint,
            List<Relation> relations
    ) {
        boolean allAfter = relations.stream().allMatch(
                relation -> relation == Relation.MATCHES_AFTER
        );
        if ("applied".equals(checkpoint.phase()) && allAfter) {
            return Assessment.APPLIED_CONFIRMED;
        }
        boolean allBefore = relations.stream().allMatch(
                relation -> relation == Relation.MATCHES_BEFORE
        );
        if ("captured".equals(checkpoint.phase()) && allBefore) {
            return Assessment.NO_EFFECT_OBSERVED;
        }
        return Assessment.PARTIAL_OR_UNKNOWN;
    }

    private JsonNode inputSchema() {
        ObjectNode schema = WorkspaceFileToolSupport.objectSchema(objectMapper);
        ObjectNode properties = (ObjectNode) schema.path("properties");
        properties.putObject("execution_id")
                .put("type", "string")
                .put("description", "待核对的 Tool execution ID");
        schema.putArray("required").add("execution_id");
        return schema;
    }

    private JsonNode outputSchema() {
        ObjectNode schema = WorkspaceFileToolSupport.objectSchema(objectMapper);
        ObjectNode properties = (ObjectNode) schema.path("properties");
        properties.putObject("executionId")
                .put("type", "string")
                .put("description", "被核对的 Tool execution ID");
        properties.putObject("checkpointId")
                .put("type", "string")
                .put("description", "该执行创建的 Checkpoint ID");
        properties.putObject("checkpointPhase")
                .put("type", "string")
                .put("description", "captured 或 applied");
        properties.putObject("assessment")
                .put("type", "string")
                .put("description", "applied_confirmed、no_effect_observed 或 partial_or_unknown");
        ObjectNode resources = properties.putObject("resources");
        resources.put("type", "array");
        resources.put("description", "每个资源的写前、记录写后和当前版本比较");
        ObjectNode item = resources.putObject("items");
        item.put("type", "object");
        ObjectNode itemProperties = item.putObject("properties");
        itemProperties.putObject("path").put("type", "string");
        itemProperties.putObject("kind").put("type", "string");
        itemProperties.putObject("changeKind").put("type", "string");
        itemProperties.putObject("beforeHash").put("type", "string");
        itemProperties.putObject("recordedAfterHash").put("type", "string");
        itemProperties.putObject("currentHash").put("type", "string");
        itemProperties.putObject("relation").put("type", "string");
        properties.putObject("guidance")
                .put("type", "string")
                .put("description", "根据客观版本关系给出的安全下一步");
        schema.putArray("required")
                .add("executionId")
                .add("checkpointId")
                .add("checkpointPhase")
                .add("assessment")
                .add("resources")
                .add("guidance");
        return schema;
    }

    private enum Relation {
        MATCHES_BEFORE("matches_before"),
        MATCHES_AFTER("matches_after"),
        DIVERGED("diverged");

        private final String value;

        Relation(String value) {
            this.value = value;
        }
    }

    private enum Assessment {
        APPLIED_CONFIRMED(
                "applied_confirmed",
                "Checkpoint 已记录应用，且全部当前资源匹配写后版本；可把外部效果视为已确认"
        ),
        NO_EFFECT_OBSERVED(
                "no_effect_observed",
                "Checkpoint 只完成捕获，且全部当前资源仍匹配写前版本；未观察到工作区写入"
        ),
        PARTIAL_OR_UNKNOWN(
                "partial_or_unknown",
                "资源存在部分应用、后续修改或未记录写后版本；不要自动重试，先查看逐项关系"
        );

        private final String value;
        private final String guidance;

        Assessment(String value, String guidance) {
            this.value = value;
            this.guidance = guidance;
        }
    }
}
