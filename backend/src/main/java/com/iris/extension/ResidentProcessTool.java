package com.iris.extension;

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

import java.nio.file.Path;
import java.time.Duration;
import java.time.Instant;
import java.util.List;
import java.util.Map;

/**
 * 过程工具的 process 形态（docs/31 §4）：常驻 NDJSON 进程，惰性拉起，
 * 崩溃后本次调用内重启一次，超时/取消走三层取消。审批与六闸全在内核；
 * 进程在审批通过前不会被启动（首次 execute 才 spawn）。
 */
public class ResidentProcessTool implements Tool {

    private static final Duration APPROVAL_TTL = Duration.ofSeconds(300);

    private final ProcessToolDefinition definition;
    private final ToolManifest manifest;
    private final ResidentPluginProcess process;
    private final ObjectMapper objectMapper;

    public ResidentProcessTool(
            ProcessToolDefinition definition,
            Path pluginDir,
            String contentVersion,
            ObjectMapper objectMapper
    ) {
        this(
                definition,
                contentVersion,
                new ResidentPluginProcess(
                        TemplateProcessTool.renderSpawnArgv(
                                definition.runtime().entry(), pluginDir),
                        pluginDir,
                        resolveEnvLazily(definition),
                        objectMapper
                ),
                objectMapper
        );
    }

    /**
     * 共享进程形态（docs/31 §3.2）：同目录多个 process 清单共用一个
     * {@link ResidentPluginProcess}；进程的生命周期由 ExtensionProviderService
     * 按目录裁决（所有清单的 entry/env 已校验一致）。
     */
    public ResidentProcessTool(
            ProcessToolDefinition definition,
            String contentVersion,
            ResidentPluginProcess sharedProcess,
            ObjectMapper objectMapper
    ) {
        this.definition = definition;
        this.objectMapper = objectMapper;
        RiskLevel riskLevel = TemplateProcessTool.riskLevel(definition);
        ToolManifest.SideEffect sideEffect =
                TemplateProcessTool.sideEffect(definition);
        this.manifest = new ToolManifest(
                "extension." + definition.name(),
                contentVersion,
                definition.name(),
                definition.description(),
                definition.inputSchema(),
                outputSchema(objectMapper),
                riskLevel,
                sideEffect,
                TemplateProcessTool.timeoutSeconds(definition),
                TemplateProcessTool.resultLimit(definition),
                sideEffect == ToolManifest.SideEffect.NONE
                        ? ToolManifest.IdempotencySemantics.IDEMPOTENT
                        : ToolManifest.IdempotencySemantics.NON_IDEMPOTENT,
                sideEffect == ToolManifest.SideEffect.NONE
                        ? ToolManifest.EvidencePolicy.NONE
                        : ToolManifest.EvidencePolicy.SUMMARY,
                ToolManifest.ContextRetention.PINNED,
                sideEffect == ToolManifest.SideEffect.NONE
                        ? ToolManifest.ConcurrencySemantics.PARALLEL_SAFE
                        : ToolManifest.ConcurrencySemantics.SERIAL,
                sideEffect == ToolManifest.SideEffect.NONE
                        ? ToolManifest.CancellationSemantics.COOPERATIVE
                        : ToolManifest.CancellationSemantics.COMMIT_BOUNDARY
        );
        this.process = sharedProcess;
    }

    /** 环境变量在 spawn 前解析——进程未拉起时缺变量不阻塞注册。 */
    private static Map<String, String> resolveEnvLazily(
            ProcessToolDefinition definition
    ) {
        if (definition.runtime().env() == null
                || definition.runtime().env().isEmpty()) {
            return Map.of();
        }
        // 值延迟到 spawn：这里只记录名字，缺变量在首次调用时报
        // extension_env_missing（与 template 形态同语义）。
        Map<String, String> names = new java.util.LinkedHashMap<>();
        for (String name : definition.runtime().env()) {
            String value = System.getenv(name);
            if (value != null) {
                names.put(name, value);
            }
        }
        return names;
    }

    @Override
    public ToolManifest manifest() {
        return manifest;
    }

    @Override
    public PreparedOperation prepare(JsonNode input, ToolContext context) {
        return new PreparedOperation(
                input,
                TemplateProcessTool.renderImpact(
                        definition, manifest.sideEffect(), input),
                List.of(),
                Instant.now().plus(APPROVAL_TTL)
        );
    }

    @Override
    public ToolOutcome execute(
            CommittedOperation operation,
            ToolContext context
    ) throws Exception {
        requireDeclaredEnvPresent();
        if (!process.acquire()) {
            return ToolOutcome.failed(
                    "extension_retired",
                    "插件已被禁用或替换，本次调用的能力快照不再可用"
            );
        }
        try {
            return invokeWithSingleRetry(operation, context);
        } finally {
            process.release();
        }
    }

    /** 崩溃后在本次调用内重启一次重发；第二次死亡才报错（docs/31 §4）。 */
    private ToolOutcome invokeWithSingleRetry(
            CommittedOperation operation,
            ToolContext context
    ) throws Exception {
        Duration timeout = Duration.ofSeconds(
                TemplateProcessTool.timeoutSeconds(definition));
        int attempts = 0;
        while (true) {
            attempts++;
            long startedNanos = System.nanoTime();
            try {
                ResidentPluginProcess.InvokeOutcome outcome = process.invoke(
                        operation.executionId(),
                        definition.name(),
                        operation.normalizedInput(),
                        context.workspaceRoot(),
                        timeout,
                        context::cancelled
                );
                return toToolOutcome(outcome, startedNanos);
            } catch (ResidentPluginProcess.CallCancelledException cancelled) {
                if (manifest.sideEffect() == ToolManifest.SideEffect.NONE) {
                    return ToolOutcome.failed(
                            "process_cancelled",
                            "调用已超时或被取消，进程已终止"
                    );
                }
                throw ToolRuntimeException.beforeCommit(
                        "cancelled_before_commit",
                        "任务已停止，插件进程未返回结果帧"
                );
            } catch (ResidentPluginProcess.ProcessDiedException died) {
                if (attempts >= 2) {
                    if (manifest.sideEffect()
                            == ToolManifest.SideEffect.NONE) {
                        return ToolOutcome.failed(
                                "process_crashed",
                                "插件进程两次启动后仍未返回结果: "
                                        + died.getMessage()
                        );
                    }
                    return ToolOutcome.unknown(
                            "process_crashed",
                            "插件进程崩溃，副作用状态不明: " + died.getMessage()
                    );
                }
                log.info(
                        "extension plugin {} crashed ({}); restarting once",
                        definition.name(), died.getMessage()
                );
            }
        }
    }

    private ToolOutcome toToolOutcome(
            ResidentPluginProcess.InvokeOutcome outcome,
            long startedNanos
    ) {
        JsonNode result = outcome.result();
        long durationMs =
                (System.nanoTime() - startedNanos) / 1_000_000L;
        if (!result.path("success").asBoolean(false)) {
            JsonNode error = result.path("error");
            String code = error.isObject()
                    ? error.path("code").asText("plugin_error")
                    : "plugin_error";
            String message = error.isObject()
                    ? error.path("message").asText(error.toString())
                    : error.asText("插件报告失败");
            ObjectNode details = objectMapper.createObjectNode();
            details.set("error", error);
            details.putPOJO("progress", outcome.progress());
            return ToolOutcome.failed(details, code, message);
        }
        ObjectNode output = objectMapper.createObjectNode();
        JsonNode data = result.get("data");
        output.put("content",
                data == null ? ""
                        : data.isTextual() ? data.asText() : data.toString());
        JsonNode structured = result.get("structuredData");
        if (structured != null && structured.isObject()) {
            output.set("structured", structured);
        }
        if (!outcome.progress().isEmpty()) {
            ArrayNode progress = output.putArray("progress");
            outcome.progress().forEach(progress::add);
        }
        output.put("durationMs", durationMs);
        return ToolOutcome.succeeded(output);
    }

    private void requireDeclaredEnvPresent() {
        // 与 template 形态同语义的 fail-fast；构造期不抛（fail-closed
        // 留给扫描层），首次调用前进程尚未拉起。
        TemplateProcessTool.resolveDeclaredEnv(definition);
    }

    /** 禁用/卸载时调用：不再接受新调用，最后一个在途引用退出时销毁进程。 */
    public void retire() {
        process.retire();
    }

    @Override
    public VerificationResult verify(
            ToolOutcome outcome,
            CommittedOperation operation,
            ToolContext context
    ) {
        // 结果帧即插件的自证；内核不伪造证据。
        return VerificationResult.confirmed(List.of());
    }

    /** process 形态的统一输出结构（docs/31 §4 result 帧投影）。 */
    private static JsonNode outputSchema(ObjectMapper objectMapper) {
        ObjectNode schema = objectMapper.createObjectNode();
        schema.put("type", "object");
        schema.put("additionalProperties", false);
        ObjectNode properties = schema.putObject("properties");
        properties.putObject("content")
                .put("type", "string")
                .put("description", "result 帧 data 的文本投影");
        properties.putObject("structured")
                .put("type", "object")
                .put("description", "result 帧的 structuredData 对象");
        properties.putObject("progress")
                .put("type", "array")
                .put("description", "调用期间插件依序报告的 progress 文本");
        properties.putObject("durationMs")
                .put("type", "integer")
                .put("description", "从发送 invoke 到收到 result 的墙钟毫秒");
        schema.putArray("required").add("content").add("durationMs");
        return schema;
    }

    private static final org.slf4j.Logger log =
            org.slf4j.LoggerFactory.getLogger(ResidentProcessTool.class);
}
