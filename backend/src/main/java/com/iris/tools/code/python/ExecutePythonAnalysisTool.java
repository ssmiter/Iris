package com.iris.tools.code.python;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.node.ArrayNode;
import com.fasterxml.jackson.databind.node.ObjectNode;
import com.iris.artifact.ArtifactService;
import com.iris.artifact.ArtifactService.ArtifactContent;
import com.iris.artifact.ArtifactService.ArtifactSnapshot;
import com.iris.sandbox.PythonAnalysisSandbox;
import com.iris.sandbox.PythonAnalysisSandbox.ExecutionResult;
import com.iris.sandbox.PythonAnalysisSandbox.InputFile;
import com.iris.sandbox.PythonAnalysisSandbox.OutputFile;
import com.iris.tools.core.CommittedOperation;
import com.iris.tools.core.PreparedOperation;
import com.iris.tools.core.PreparedOperation.ResourceClaim;
import com.iris.tools.core.RiskLevel;
import com.iris.tools.core.Tool;
import com.iris.tools.core.ToolContext;
import com.iris.tools.core.ToolManifest;
import com.iris.tools.core.ToolOutcome;
import com.iris.tools.core.ToolOutputPayloadService;
import com.iris.tools.core.ToolOutputPayloadService.BinaryPayload;
import com.iris.tools.core.ToolOutputPayloadService.PayloadDescriptor;
import com.iris.tools.core.ToolRuntimeException;
import com.iris.tools.core.VerificationResult;
import com.iris.workspace.WorkspaceCheckpointService;
import com.iris.workspace.WorkspaceCheckpointService.AppliedResource;
import com.iris.workspace.WorkspaceCheckpointService.CheckpointSet;
import com.iris.workspace.WorkspaceCheckpointService.CheckpointTarget;
import com.iris.workspace.WorkspaceFileMutationService;
import com.iris.workspace.WorkspaceFileMutationService.TargetState;
import org.springframework.stereotype.Component;

import java.io.IOException;
import java.nio.file.Files;
import java.nio.file.LinkOption;
import java.time.Instant;
import java.util.ArrayList;
import java.util.HashMap;
import java.util.HashSet;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.Set;
import java.util.regex.Pattern;

/**
 * Runs bounded Python analysis against explicitly staged workspace files.
 *
 * <p>The model-facing contract deliberately does not expose the runtime
 * implementation. A trusted process, container, or future helper must all
 * obey the same declared-input/declared-output commit protocol.</p>
 */
@Component
public class ExecutePythonAnalysisTool implements Tool {
    private static final int MAX_CODE_CHARACTERS = 120_000;
    private static final int MAX_INPUTS = 16;
    private static final int MAX_OUTPUTS = 8;
    private static final Pattern SAFE_FILE_NAME = Pattern.compile(
            "[A-Za-z0-9][A-Za-z0-9._-]{0,119}"
    );
    private static final Set<String> ARTIFACT_KINDS = Set.of(
            "document", "spreadsheet", "presentation", "pdf", "image",
            "html", "data", "code", "archive", "file"
    );

    private final ObjectMapper objectMapper;
    private final PythonAnalysisSandbox sandbox;
    private final WorkspaceFileMutationService files;
    private final WorkspaceCheckpointService checkpoints;
    private final ArtifactService artifacts;
    private final ToolOutputPayloadService toolOutputs;
    private final ToolManifest manifest;

    public ExecutePythonAnalysisTool(
            ObjectMapper objectMapper,
            PythonAnalysisSandbox sandbox,
            WorkspaceFileMutationService files,
            WorkspaceCheckpointService checkpoints,
            ArtifactService artifacts,
            ToolOutputPayloadService toolOutputs
    ) {
        this.objectMapper = objectMapper;
        this.sandbox = sandbox;
        this.files = files;
        this.checkpoints = checkpoints;
        this.artifacts = artifacts;
        this.toolOutputs = toolOutputs;
        this.manifest = new ToolManifest(
                "iris.code.python.execute_python_analysis",
                "1",
                "execute_python_analysis",
                "用受控 Python 环境完成数据分析、确定性计算、图表或文档生成；"
                        + "输入和输出必须预先声明，脚本只从 IRIS_INPUT_DIR 读取并向 "
                        + "IRIS_OUTPUT_DIR 写入，不用于联网或通用 Shell 操作",
                inputSchema(),
                outputSchema(),
                RiskLevel.ELEVATED,
                ToolManifest.SideEffect.WORKSPACE_WRITE,
                180,
                16_000,
                ToolManifest.IdempotencySemantics.IDEMPOTENT_WITH_KEY,
                ToolManifest.EvidencePolicy.REQUIRED,
                ToolManifest.ContextRetention.REFETCHABLE,
                ToolManifest.ConcurrencySemantics.SERIAL,
                ToolManifest.CancellationSemantics.COMMIT_BOUNDARY
        );
    }

    @Override
    public ToolManifest manifest() {
        return manifest;
    }

    @Override
    public PreparedOperation prepare(JsonNode input, ToolContext context)
            throws IOException {
        PythonAnalysisSandbox.Assessment runtime = sandbox.assessment();
        if (!runtime.executable()) {
            throw ToolRuntimeException.beforeCommit(
                    "python_runtime_unavailable",
                    runtime.reason()
            );
        }
        String code = input.path("code").asText();
        if (code.isBlank() || code.length() > MAX_CODE_CHARACTERS) {
            throw ToolRuntimeException.beforeCommit(
                    "invalid_python_code",
                    "code 必须为 1 到 " + MAX_CODE_CHARACTERS
                            + " 字符的非空 Python 源码"
            );
        }

        ArrayNode normalizedInputs = objectMapper.createArrayNode();
        ArrayNode normalizedOutputs = objectMapper.createArrayNode();
        List<ResourceClaim> resources = new ArrayList<>();
        Set<String> inputNames = new HashSet<>();
        Set<String> outputNames = new HashSet<>();
        Set<String> outputPaths = new HashSet<>();
        long declaredInputBytes = 0;

        JsonNode inputs = requireArray(input, "inputs", 0, MAX_INPUTS);
        for (JsonNode declared : inputs) {
            String mountName = safeFileName(
                    requiredText(declared, "mount_name", 120),
                    "mount_name"
            );
            requireUnique(inputNames, mountName, "mount_name");
            PreparedInput preparedInput = prepareInput(
                    declared,
                    mountName,
                    context
            );
            declaredInputBytes += preparedInput.byteCount();
            if (declaredInputBytes > sandbox.maxInputBytes()) {
                throw ToolRuntimeException.beforeCommit(
                        "python_input_budget_exceeded",
                        "声明输入总量超过 Python staged input 上限"
                );
            }
            normalizedInputs.add(preparedInput.normalized());
            resources.add(preparedInput.resource());
        }

        JsonNode outputs = requireArray(input, "outputs", 1, MAX_OUTPUTS);
        for (JsonNode declared : outputs) {
            String outputName = safeFileName(
                    requiredText(declared, "output_name", 120),
                    "output_name"
            );
            requireUnique(outputNames, outputName, "output_name");
            String kind = requiredText(declared, "kind", 40)
                    .toLowerCase(Locale.ROOT);
            if (!ARTIFACT_KINDS.contains(kind)) {
                throw ToolRuntimeException.beforeCommit(
                        "invalid_artifact_kind",
                        "kind 必须是已声明的 Artifact 类型"
                );
            }
            String title = requiredText(declared, "title", 500);
            TargetState target = files.inspect(
                    context.workspaceRoot(),
                    requiredText(declared, "workspace_path", 2_000)
            );
            requireUnique(
                    outputPaths,
                    target.logicalPath(),
                    "workspace_path"
            );
            requireExistingParent(target);
            checkpoints.requireCapturable(target);
            normalizedOutputs.addObject()
                    .put("output_name", outputName)
                    .put("workspace_path", target.logicalPath())
                    .put("kind", kind)
                    .put("title", title);
            resources.add(new ResourceClaim(
                    "python_output",
                    target.logicalPath(),
                    target.version()
            ));
        }

        ObjectNode normalized = objectMapper.createObjectNode();
        normalized.put("code", code);
        normalized.set("inputs", normalizedInputs);
        normalized.set("outputs", normalizedOutputs);
        List<String> outputPathsForImpact = new ArrayList<>();
        normalizedOutputs.forEach(item -> outputPathsForImpact.add(
                item.path("workspace_path").asText()
        ));
        String outputSummary = String.join("、", outputPathsForImpact);
        return new PreparedOperation(
                normalized,
                "将在已配置的 Python 分析运行时中读取 "
                        + normalizedInputs.size() + " 个声明输入，并创建或替换 "
                        + normalizedOutputs.size() + " 个工作区文件（"
                        + outputSummary + "）；提交前为全部目标建立 Checkpoint",
                resources,
                Instant.now().plusSeconds(600)
        );
    }

    @Override
    public ToolOutcome execute(
            CommittedOperation operation,
            ToolContext context
    ) throws IOException, InterruptedException {
        JsonNode normalized = operation.normalizedInput();
        int inputCount = normalized.path("inputs").size();
        List<InputFile> stagedInputs = new ArrayList<>();
        for (int index = 0; index < inputCount; index++) {
            JsonNode declared = normalized.path("inputs").get(index);
            ResourceClaim resource = operation.resources().get(index);
            stagedInputs.add(resolveInput(
                    declared,
                    resource,
                    context
            ));
        }

        List<TargetState> outputTargets = new ArrayList<>();
        List<String> expectedOutputNames = new ArrayList<>();
        JsonNode declaredOutputs = normalized.path("outputs");
        for (int index = 0; index < declaredOutputs.size(); index++) {
            JsonNode declared = declaredOutputs.get(index);
            ResourceClaim resource = operation.resources().get(
                    inputCount + index
            );
            TargetState current = files.inspect(
                    context.workspaceRoot(),
                    resource.logicalPath()
            );
            files.requireVersion(current, resource.expectedVersion());
            requireExistingParent(current);
            outputTargets.add(current);
            expectedOutputNames.add(
                    declared.path("output_name").asText()
            );
        }
        if (context.cancelled()) {
            throw ToolRuntimeException.beforeCommit(
                    "cancelled_before_commit",
                    "任务已停止，Python 尚未运行"
            );
        }

        ExecutionResult result = sandbox.execute(
                normalized.path("code").asText(),
                stagedInputs,
                expectedOutputNames,
                context::cancelled
        );
        if (!result.success()) {
            return ToolOutcome.failed(
                    "python_execution_failed",
                    failureMessage(result)
            );
        }
        if (context.cancelled()) {
            throw ToolRuntimeException.beforeCommit(
                    "cancelled_before_commit",
                    "Python 已完成，但 staged output 尚未提交"
            );
        }

        for (int index = 0; index < outputTargets.size(); index++) {
            TargetState refreshed = files.inspect(
                    context.workspaceRoot(),
                    outputTargets.get(index).logicalPath()
            );
            ResourceClaim resource = operation.resources().get(
                    inputCount + index
            );
            files.requireVersion(refreshed, resource.expectedVersion());
            outputTargets.set(index, refreshed);
        }

        List<CheckpointTarget> checkpointTargets = outputTargets.stream()
                .map(target -> new CheckpointTarget(
                        target.exists() ? "replace" : "create",
                        target
                ))
                .toList();
        CheckpointSet checkpoint = checkpoints.capture(
                operation.executionId(),
                checkpointTargets
        );

        Map<String, byte[]> generated = new HashMap<>();
        for (OutputFile output : result.outputs()) {
            generated.put(output.name(), output.bytes());
        }
        List<AppliedResource> applied = new ArrayList<>();
        for (int index = 0; index < outputTargets.size(); index++) {
            TargetState target = outputTargets.get(index);
            String outputName = expectedOutputNames.get(index);
            files.writeBytes(target, generated.get(outputName));
            String afterHash = files.versionOf(target.physicalPath());
            applied.add(new AppliedResource(
                    target.logicalPath(),
                    afterHash
            ));
        }
        checkpoints.markApplied(checkpoint.checkpointId(), applied);

        ObjectNode output = objectMapper.createObjectNode();
        output.put("runtimeMode", result.runtimeMode());
        output.put("durationMs", result.durationMs());
        output.put("stdout", result.stdout());
        output.put("stderr", result.stderr());
        output.put("stdoutTruncated", result.stdoutTruncated());
        output.put("stderrTruncated", result.stderrTruncated());
        output.put("checkpointId", checkpoint.checkpointId());
        ArrayNode outputItems = output.putArray("outputs");
        for (int index = 0; index < outputTargets.size(); index++) {
            JsonNode declared = declaredOutputs.get(index);
            TargetState target = outputTargets.get(index);
            AppliedResource appliedResource = applied.get(index);
            ArtifactSnapshot artifact = artifacts.registerWorkspace(
                    context,
                    operation.executionId(),
                    target.logicalPath(),
                    appliedResource.afterHash(),
                    declared.path("output_name").asText(),
                    declared.path("title").asText(),
                    declared.path("kind").asText(),
                    null
            );
            ObjectNode item = outputItems.addObject();
            item.put("outputName", declared.path("output_name").asText());
            item.put("workspacePath", target.logicalPath());
            item.put(
                    "bytesWritten",
                    generated.get(declared.path("output_name").asText()).length
            );
            item.put("afterHash", appliedResource.afterHash());
            item.set("artifact", artifacts.toJson(artifact));
        }
        return ToolOutcome.succeeded(output);
    }

    @Override
    public VerificationResult verify(
            ToolOutcome outcome,
            CommittedOperation operation,
            ToolContext context
    ) throws IOException {
        List<VerificationResult.Evidence> evidence = new ArrayList<>();
        for (JsonNode generated : outcome.output().path("outputs")) {
            String path = generated.path("workspacePath").asText();
            String afterHash = generated.path("afterHash").asText();
            TargetState current = files.inspect(context.workspaceRoot(), path);
            if (!current.exists() || !current.version().equals(afterHash)) {
                return new VerificationResult(
                        VerificationResult.Status.UNKNOWN,
                        evidence,
                        "Python 输出已提交，但工作区版本无法确认：" + path
                );
            }
            String artifactRef = generated.path("artifact")
                    .path("artifactRef").asText();
            ArtifactSnapshot artifact = artifacts.require(
                    artifactRef,
                    context.conversationId()
            );
            if (!artifact.visibility().contains("internal")) {
                return new VerificationResult(
                        VerificationResult.Status.UNKNOWN,
                        evidence,
                        "Python 输出已写入，但 Artifact 登记无法确认：" + path
                );
            }
            evidence.add(new VerificationResult.Evidence(
                    "workspace_file_version",
                    path,
                    "Python 输出版本 " + afterHash.substring(0, 12)
            ));
            evidence.add(new VerificationResult.Evidence(
                    "artifact_content_version",
                    artifactRef,
                    "输出已冻结为内部 Artifact"
            ));
        }
        evidence.add(new VerificationResult.Evidence(
                "workspace_checkpoint",
                outcome.output().path("checkpointId").asText(),
                "全部目标的写前状态已作为一组保留"
        ));
        return VerificationResult.confirmed(evidence);
    }

    private JsonNode inputSchema() {
        ObjectNode schema = objectSchema();
        ObjectNode properties = (ObjectNode) schema.path("properties");
        properties.putObject("code")
                .put("type", "string")
                .put("maxLength", MAX_CODE_CHARACTERS)
                .put("description", "完整 Python 源码；从 IRIS_INPUT_DIR 读取，"
                        + "只向 IRIS_OUTPUT_DIR 写入声明文件");

        ObjectNode inputs = properties.putObject("inputs");
        inputs.put("type", "array");
        inputs.put("maxItems", MAX_INPUTS);
        inputs.put("description", "可选 staged input；每项必须且只能引用一个 "
                + "workspace_path、artifact_ref 或 tool_execution_id");
        ObjectNode inputItem = objectSchema();
        ObjectNode inputProperties =
                (ObjectNode) inputItem.path("properties");
        inputProperties.putObject("workspace_path")
                .put("type", "string")
                .put("description", "可选：工作区内已存在的相对文件路径");
        inputProperties.putObject("artifact_ref")
                .put("type", "string")
                .put("description", "可选：同一对话中的 immutable artifact:// 引用");
        inputProperties.putObject("tool_execution_id")
                .put("type", "string")
                .put("description", "可选：同一对话中完整规范 Tool output 的 execution ID");
        inputProperties.putObject("mount_name")
                .put("type", "string")
                .put("maxLength", 120)
                .put("description", "脚本在 IRIS_INPUT_DIR 下读取的扁平文件名");
        inputItem.putArray("required").add("mount_name");
        inputs.set("items", inputItem);

        ObjectNode outputs = properties.putObject("outputs");
        outputs.put("type", "array");
        outputs.put("minItems", 1);
        outputs.put("maxItems", MAX_OUTPUTS);
        outputs.put("description", "脚本必须精确生成的输出集合；不能多也不能少");
        ObjectNode outputItem = objectSchema();
        ObjectNode outputProperties =
                (ObjectNode) outputItem.path("properties");
        outputProperties.putObject("output_name")
                .put("type", "string")
                .put("maxLength", 120)
                .put("description", "脚本在 IRIS_OUTPUT_DIR 下创建的扁平文件名");
        outputProperties.putObject("workspace_path")
                .put("type", "string")
                .put("description", "验证成功后原子提交到的工作区相对路径");
        ObjectNode kind = outputProperties.putObject("kind");
        kind.put("type", "string");
        kind.put("description", "决定预览和交付方式的 Artifact 类型");
        ArrayNode kinds = kind.putArray("enum");
        ARTIFACT_KINDS.stream().sorted().forEach(kinds::add);
        outputProperties.putObject("title")
                .put("type", "string")
                .put("maxLength", 500)
                .put("description", "用户能理解的产物标题");
        outputItem.putArray("required")
                .add("output_name").add("workspace_path")
                .add("kind").add("title");
        outputs.set("items", outputItem);
        schema.putArray("required").add("code").add("inputs").add("outputs");
        return schema;
    }

    private JsonNode outputSchema() {
        ObjectNode schema = objectSchema();
        ObjectNode properties = (ObjectNode) schema.path("properties");
        properties.putObject("runtimeMode")
                .put("type", "string")
                .put(
                        "description",
                        "实际承接本次执行的 Python 运行模式"
                );
        properties.putObject("durationMs")
                .put("type", "integer")
                .put("description", "Python 子进程执行耗时，单位毫秒");
        properties.putObject("stdout")
                .put("type", "string")
                .put("description", "有界的标准输出；不作为产物交付");
        properties.putObject("stderr")
                .put("type", "string")
                .put("description", "有界的标准错误输出，用于诊断脚本失败");
        properties.putObject("stdoutTruncated")
                .put("type", "boolean")
                .put("description", "标准输出是否因捕获预算被截断");
        properties.putObject("stderrTruncated")
                .put("type", "boolean")
                .put("description", "标准错误输出是否因捕获预算被截断");
        properties.putObject("checkpointId")
                .put("type", "string")
                .put(
                        "description",
                        "本次写入前建立的工作区检查点集合 ID"
                );
        ObjectNode outputs = properties.putObject("outputs");
        outputs.put("type", "array")
                .put(
                        "description",
                        "已写入工作区并登记为不可变 Artifact 的声明输出"
                );
        ObjectNode item = objectSchema();
        ObjectNode itemProperties = (ObjectNode) item.path("properties");
        itemProperties.putObject("outputName")
                .put("type", "string")
                .put("description", "输入契约中声明的输出名称");
        itemProperties.putObject("workspacePath")
                .put("type", "string")
                .put("description", "工作区围栏内的输出逻辑路径");
        itemProperties.putObject("bytesWritten")
                .put("type", "integer")
                .put("description", "核验后实际写入的字节数");
        itemProperties.putObject("afterHash")
                .put("type", "string")
                .put("description", "写入并核验后的文件内容哈希");
        itemProperties.putObject("artifact")
                .put("type", "object")
                .put(
                        "description",
                        "由该输出登记得到的不可变 Artifact 元数据"
                );
        item.putArray("required")
                .add("outputName").add("workspacePath")
                .add("bytesWritten").add("afterHash").add("artifact");
        outputs.set("items", item);
        schema.putArray("required")
                .add("runtimeMode").add("durationMs")
                .add("stdout").add("stderr")
                .add("stdoutTruncated").add("stderrTruncated")
                .add("checkpointId").add("outputs");
        return schema;
    }

    private ObjectNode objectSchema() {
        ObjectNode schema = objectMapper.createObjectNode();
        schema.put("type", "object");
        schema.put("additionalProperties", false);
        schema.putObject("properties");
        return schema;
    }

    private PreparedInput prepareInput(
            JsonNode declared,
            String mountName,
            ToolContext context
    ) throws IOException {
        requireInputShape(declared);
        ObjectNode normalized = objectMapper.createObjectNode();
        normalized.put("mount_name", mountName);

        if (hasText(declared, "workspace_path")) {
            TargetState source = files.inspect(
                    context.workspaceRoot(),
                    declared.path("workspace_path").asText()
            );
            if (!source.exists()) {
                throw ToolRuntimeException.beforeCommit(
                        "python_input_not_found",
                        "声明输入不存在：" + source.logicalPath()
                );
            }
            normalized.put("workspace_path", source.logicalPath());
            return new PreparedInput(
                    normalized,
                    new ResourceClaim(
                            "python_workspace_input",
                            source.logicalPath(),
                            source.version()
                    ),
                    source.sizeBytes()
            );
        }

        if (hasText(declared, "artifact_ref")) {
            String reference = requiredText(
                    declared, "artifact_ref", 120
            );
            ArtifactSnapshot artifact = artifacts.require(
                    reference,
                    context.conversationId()
            );
            normalized.put("artifact_ref", artifact.reference());
            return new PreparedInput(
                    normalized,
                    new ResourceClaim(
                            "python_artifact_input",
                            artifact.reference(),
                            artifact.contentHash()
                    ),
                    artifact.byteCount()
            );
        }

        String executionId = requiredText(
                declared, "tool_execution_id", 160
        );
        PayloadDescriptor payload = toolOutputs.findDescriptor(
                context.conversationId(),
                executionId
        ).orElseThrow(() -> ToolRuntimeException.beforeCommit(
                "tool_result_not_found",
                "当前对话中没有这条完整工具结果：" + executionId
        ));
        if (!"application/json".equals(payload.mediaType())) {
            throw ToolRuntimeException.beforeCommit(
                    "tool_result_not_json",
                    "Python staged tool result 当前只接受规范 JSON payload"
            );
        }
        normalized.put("tool_execution_id", payload.executionId());
        return new PreparedInput(
                normalized,
                new ResourceClaim(
                        "python_tool_result_input",
                        payload.executionId(),
                        payload.contentHash()
                ),
                payload.byteCount()
        );
    }

    private InputFile resolveInput(
            JsonNode declared,
            ResourceClaim resource,
            ToolContext context
    ) throws IOException {
        String mountName = declared.path("mount_name").asText();
        if (declared.has("workspace_path")) {
            TargetState current = files.inspect(
                    context.workspaceRoot(),
                    resource.logicalPath()
            );
            if (!current.exists()) {
                throw ToolRuntimeException.beforeCommit(
                        "python_input_not_found",
                        "声明输入在执行前消失：" + current.logicalPath()
                );
            }
            files.requireVersion(current, resource.expectedVersion());
            return InputFile.workspace(
                    current.logicalPath(),
                    current.physicalPath(),
                    resource.expectedVersion(),
                    mountName
            );
        }
        if (declared.has("artifact_ref")) {
            ArtifactSnapshot artifact = artifacts.require(
                    declared.path("artifact_ref").asText(),
                    context.conversationId()
            );
            requireInputVersion(
                    artifact.contentHash(),
                    resource.expectedVersion(),
                    artifact.reference()
            );
            ArtifactContent content = artifacts.content(
                    artifact.artifactId(),
                    artifact.version()
            );
            return InputFile.immutable(
                    artifact.reference(),
                    content.bytes(),
                    resource.expectedVersion(),
                    mountName
            );
        }
        BinaryPayload payload = toolOutputs.findBytes(
                context.conversationId(),
                declared.path("tool_execution_id").asText(),
                sandbox.maxInputBytes()
        ).orElseThrow(() -> ToolRuntimeException.beforeCommit(
                "tool_result_not_found",
                "当前对话中找不到声明的完整工具结果"
        ));
        requireInputVersion(
                payload.contentHash(),
                resource.expectedVersion(),
                payload.executionId()
        );
        return InputFile.immutable(
                "tool-result://" + payload.executionId(),
                payload.bytes(),
                resource.expectedVersion(),
                mountName
        );
    }

    private void requireInputShape(JsonNode declared) {
        if (!declared.isObject()) {
            throw ToolRuntimeException.beforeCommit(
                    "invalid_python_input",
                    "inputs 的每一项都必须是 object"
            );
        }
        Set<String> allowed = Set.of(
                "workspace_path",
                "artifact_ref",
                "tool_execution_id",
                "mount_name"
        );
        declared.fieldNames().forEachRemaining(field -> {
            if (!allowed.contains(field)) {
                throw ToolRuntimeException.beforeCommit(
                        "invalid_python_input",
                        "inputs 中存在未声明字段：" + field
                );
            }
        });
        int sources = 0;
        sources += hasText(declared, "workspace_path") ? 1 : 0;
        sources += hasText(declared, "artifact_ref") ? 1 : 0;
        sources += hasText(declared, "tool_execution_id") ? 1 : 0;
        if (sources != 1) {
            throw ToolRuntimeException.beforeCommit(
                    "invalid_python_input_source",
                    "每个 input 必须且只能声明 workspace_path、artifact_ref "
                            + "或 tool_execution_id 中的一项"
            );
        }
    }

    private boolean hasText(JsonNode node, String field) {
        return node.has(field)
                && node.get(field).isTextual()
                && !node.get(field).asText().isBlank();
    }

    private void requireInputVersion(
            String actual,
            String expected,
            String reference
    ) {
        if (!actual.equals(expected)) {
            throw ToolRuntimeException.beforeCommit(
                    "python_input_version_changed",
                    "声明输入版本发生变化：" + reference
            );
        }
    }

    private JsonNode requireArray(
            JsonNode input,
            String field,
            int minimum,
            int maximum
    ) {
        JsonNode value = input.path(field);
        if (!value.isArray()
                || value.size() < minimum
                || value.size() > maximum) {
            throw ToolRuntimeException.beforeCommit(
                    "invalid_python_" + field,
                    field + " 数量必须为 " + minimum + " 到 " + maximum
            );
        }
        return value;
    }

    private String requiredText(
            JsonNode input,
            String field,
            int maximum
    ) {
        String value = input.path(field).asText("").trim();
        if (value.isBlank() || value.length() > maximum) {
            throw ToolRuntimeException.beforeCommit(
                    "invalid_python_" + field,
                    field + " 必须是 1 到 " + maximum + " 字符的非空文本"
            );
        }
        return value;
    }

    private String safeFileName(String value, String field) {
        if (!SAFE_FILE_NAME.matcher(value).matches()
                || ".".equals(value)
                || "..".equals(value)) {
            throw ToolRuntimeException.beforeCommit(
                    "invalid_python_" + field,
                    field + " 必须是安全的扁平文件名，不能包含目录"
            );
        }
        return value;
    }

    private void requireUnique(
            Set<String> values,
            String value,
            String field
    ) {
        if (!values.add(value.toLowerCase(Locale.ROOT))) {
            throw ToolRuntimeException.beforeCommit(
                    "python_" + field + "_conflict",
                    field + " 不能重复：" + value
            );
        }
    }

    private void requireExistingParent(TargetState target) {
        if (target.physicalPath().getParent() == null
                || !Files.isDirectory(
                target.physicalPath().getParent(),
                LinkOption.NOFOLLOW_LINKS
        )) {
            throw ToolRuntimeException.beforeCommit(
                    "workspace_parent_not_found",
                    "输出父目录不存在；请先使用 make_directory 创建："
                            + target.logicalPath()
            );
        }
    }

    private String failureMessage(ExecutionResult result) {
        StringBuilder message = new StringBuilder(
                result.failureMessage() == null
                        ? "Python 执行失败，staged output 未提交"
                        : result.failureMessage()
        );
        if (!result.stderr().isBlank()) {
            message.append("\nstderr:\n").append(result.stderr());
        }
        if (!result.stdout().isBlank()) {
            message.append("\nstdout:\n").append(result.stdout());
        }
        return message.toString();
    }

    private record PreparedInput(
            ObjectNode normalized,
            ResourceClaim resource,
            long byteCount
    ) {
    }
}
