package com.iris.extension;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.node.ObjectNode;
import com.iris.execution.WorkspaceProcessRunner;
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
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

/**
 * 过程工具的 template 形态（docs/31 §4）：清单给 argv 模板，内核代为
 * spawn 一次性进程，stdout 即结果。审批、超时、取消、截断都在内核裁决，
 * 插件进程在审批通过前不会被启动。
 */
public class TemplateProcessTool implements Tool {

    private static final Pattern PLACEHOLDER =
            Pattern.compile("\\{([a-zA-Z][a-zA-Z0-9_]*)}");
    private static final Duration APPROVAL_TTL = Duration.ofSeconds(300);
    private static final int CAPTURE_BYTES = 256 * 1024;
    private static final int STDERR_TAIL_CHARS = 2_000;

    private final ProcessToolDefinition definition;
    private final Path pluginDir;
    private final ToolManifest manifest;
    private final WorkspaceProcessRunner runner;
    private final ObjectMapper objectMapper;

    public TemplateProcessTool(
            ProcessToolDefinition definition,
            Path pluginDir,
            String contentVersion,
            WorkspaceProcessRunner runner,
            ObjectMapper objectMapper
    ) {
        this.definition = definition;
        this.pluginDir = pluginDir;
        this.runner = runner;
        this.objectMapper = objectMapper;
        RiskLevel riskLevel = riskLevel(definition);
        ToolManifest.SideEffect sideEffect = sideEffect(definition);
        this.manifest = new ToolManifest(
                "extension." + definition.name(),
                contentVersion,
                definition.name(),
                definition.description(),
                definition.inputSchema(),
                outputSchema(objectMapper),
                riskLevel,
                sideEffect,
                timeoutSeconds(definition),
                resultLimit(definition),
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
    }

    @Override
    public ToolManifest manifest() {
        return manifest;
    }

    @Override
    public PreparedOperation prepare(JsonNode input, ToolContext context) {
        return new PreparedOperation(
                input,
                renderImpact(definition, input),
                List.of(),
                Instant.now().plus(APPROVAL_TTL)
        );
    }

    @Override
    public ToolOutcome execute(
            CommittedOperation operation,
            ToolContext context
    ) throws Exception {
        JsonNode input = operation.normalizedInput();
        List<String> argv = renderArgv(definition.runtime().entry(), input);
        resolveDeclaredEnv(definition);

        WorkspaceProcessRunner.Result result = runner.run(
                context.workspaceRoot(),
                new WorkspaceProcessRunner.Request(
                        argv,
                        ".",
                        Duration.ofSeconds(timeoutSeconds(definition)),
                        CAPTURE_BYTES,
                        null,
                        true,
                        Map.of()
                ),
                context::cancelled
        );

        if (result.termination()
                == WorkspaceProcessRunner.Termination.CANCELLED) {
            if (manifest.sideEffect() == ToolManifest.SideEffect.NONE) {
                return ToolOutcome.failed(
                        "process_cancelled",
                        "进程已被取消，未产生副作用"
                );
            }
            throw ToolRuntimeException.beforeCommit(
                    "cancelled_before_commit",
                    "任务已停止，进程未完成提交"
            );
        }
        if (result.termination()
                == WorkspaceProcessRunner.Termination.TIMED_OUT) {
            return ToolOutcome.failed(
                    "process_timeout",
                    "进程超过 " + timeoutSeconds(definition)
                            + " 秒未结束，已被终止"
            );
        }
        int exitCode = result.exitCode().orElse(-1);
        if (exitCode != 0) {
            ObjectNode details = objectMapper.createObjectNode();
            details.put("exitCode", exitCode);
            details.put("stderr", tail(result.stderr().text()));
            return ToolOutcome.failed(
                    details,
                    "process_exit_" + exitCode,
                    "进程以退出码 " + exitCode + " 结束"
            );
        }

        ObjectNode output = objectMapper.createObjectNode();
        output.put("content", result.stdout().text());
        output.put("exitCode", exitCode);
        output.put("durationMs", result.duration().toMillis());
        output.put("truncated", result.stdout().truncated());
        if (!result.stderr().text().isBlank()) {
            output.put("stderr", tail(result.stderr().text()));
        }
        try {
            JsonNode structured = objectMapper.readTree(
                    result.stdout().text().trim()
            );
            if (structured != null && structured.isObject()) {
                output.set("structured", structured);
            }
        } catch (Exception ignored) {
            // stdout 不是 JSON 对象时按纯文本内容对待。
        }
        return ToolOutcome.succeeded(output);
    }

    @Override
    public VerificationResult verify(
            ToolOutcome outcome,
            CommittedOperation operation,
            ToolContext context
    ) {
        // template 进程的成功判定即退出码 0；进程级副作用由插件自证，
        // 内核不伪造证据。
        return VerificationResult.confirmed(List.of());
    }

    /** argv 模板渲染：{param} 取输入参数，{pluginDir} 取插件目录绝对路径。 */
    List<String> renderArgv(List<String> entry, JsonNode input) {
        List<String> argv = new ArrayList<>(entry.size());
        for (String element : entry) {
            Matcher matcher = PLACEHOLDER.matcher(element);
            StringBuffer rendered = new StringBuffer();
            while (matcher.find()) {
                String key = matcher.group(1);
                String replacement;
                if ("pluginDir".equals(key)) {
                    replacement = pluginDir.toAbsolutePath().toString();
                } else {
                    JsonNode value = input.path(key);
                    if (value.isMissingNode() || value.isNull()) {
                        throw new ToolRuntimeException(
                                "template_param_missing",
                                "命令模板引用了未提供的参数 {" + key + "}"
                        );
                    }
                    replacement = value.isTextual()
                            ? value.asText()
                            : value.toString();
                }
                matcher.appendReplacement(
                        rendered,
                        Matcher.quoteReplacement(replacement)
                );
            }
            matcher.appendTail(rendered);
            argv.add(rendered.toString());
        }
        return argv;
    }

    private String renderImpact(
            ProcessToolDefinition definition,
            JsonNode input
    ) {
        return renderImpact(definition, manifest.sideEffect(), input);
    }

    /** 影响陈述模板渲染：{param} 取输入参数；无模板时给默认人话。 */
    static String renderImpact(
            ProcessToolDefinition definition,
            ToolManifest.SideEffect sideEffect,
            JsonNode input
    ) {
        String template = definition.approval() == null
                ? null
                : definition.approval().impactStatement();
        if (template == null || template.isBlank()) {
            return "将运行过程工具 " + definition.name()
                    + (sideEffect == ToolManifest.SideEffect.NONE
                            ? "（只读，无外部副作用）"
                            : "（副作用：" + sideEffect + "）");
        }
        Matcher matcher = PLACEHOLDER.matcher(template);
        StringBuffer rendered = new StringBuffer();
        while (matcher.find()) {
            String key = matcher.group(1);
            JsonNode value = input.path(key);
            String text = value.isMissingNode() || value.isNull()
                    ? "{" + key + "}"
                    : value.isTextual() ? value.asText() : value.toString();
            matcher.appendReplacement(
                    rendered,
                    Matcher.quoteReplacement(text)
            );
        }
        matcher.appendTail(rendered);
        return rendered.toString();
    }

    /**
     * 常驻进程的 spawn argv：只允许内核供给占位符（参数走 invoke 帧）：
     * {pluginDir} = 插件目录绝对路径；{javaBin} = 当前 JVM 的 java 可执行
     * 文件（产品不引入新运行时，docs/31 §3.1）。
     */
    static List<String> renderSpawnArgv(List<String> entry, Path pluginDir) {
        List<String> argv = new ArrayList<>(entry.size());
        for (String element : entry) {
            Matcher matcher = PLACEHOLDER.matcher(element);
            StringBuffer rendered = new StringBuffer();
            while (matcher.find()) {
                String key = matcher.group(1);
                String replacement = switch (key) {
                    case "pluginDir" -> pluginDir.toAbsolutePath().toString();
                    case "javaBin" -> javaBin();
                    default -> throw new ToolRuntimeException(
                            "extension_manifest_invalid",
                            "kind=process 的 runtime.entry 只允许 "
                                    + "{pluginDir}/{javaBin} 占位符: {"
                                    + key + "}"
                    );
                };
                matcher.appendReplacement(
                        rendered,
                        Matcher.quoteReplacement(replacement)
                );
            }
            matcher.appendTail(rendered);
            argv.add(rendered.toString());
        }
        return argv;
    }

    /** 当前 JVM 的 java 可执行文件绝对路径（随内核发行，永远存在）。 */
    static String javaBin() {
        String executable = System.getProperty("os.name")
                .toLowerCase(Locale.ROOT).contains("win")
                ? "java.exe" : "java";
        return Path.of(System.getProperty("java.home"), "bin", executable)
                .toAbsolutePath().toString();
    }

    /** 声明的环境变量解析；缺任一即 fail-fast。 */
    static Map<String, String> resolveDeclaredEnv(
            ProcessToolDefinition definition
    ) {
        if (definition.runtime().env() == null
                || definition.runtime().env().isEmpty()) {
            return Map.of();
        }
        Map<String, String> env = new LinkedHashMap<>();
        for (String name : definition.runtime().env()) {
            String value = System.getenv(name);
            if (value == null) {
                throw new ToolRuntimeException(
                        "extension_env_missing",
                        "过程工具声明的环境变量 " + name + " 不存在；"
                                + "请在本机环境中配置后重试"
                );
            }
            env.put(name, value);
        }
        return env;
    }

    /** template 形态的统一输出结构：stdout 文本 + 进程事实 + 可选结构化解析。 */
    private static JsonNode outputSchema(ObjectMapper objectMapper) {
        ObjectNode schema = objectMapper.createObjectNode();
        schema.put("type", "object");
        schema.put("additionalProperties", false);
        ObjectNode properties = schema.putObject("properties");
        properties.putObject("content")
                .put("type", "string")
                .put("description", "进程 stdout 文本");
        properties.putObject("exitCode")
                .put("type", "integer")
                .put("description", "进程退出码，成功为 0");
        properties.putObject("durationMs")
                .put("type", "integer")
                .put("description", "进程墙钟耗时（毫秒）");
        properties.putObject("truncated")
                .put("type", "boolean")
                .put("description", "stdout 是否因输出预算被截断");
        properties.putObject("stderr")
                .put("type", "string")
                .put("description", "stderr 尾部（非空时存在）");
        properties.putObject("structured")
                .put("type", "object")
                .put("description", "stdout 为 JSON 对象时的结构化解析");
        schema.putArray("required")
                .add("content").add("exitCode")
                .add("durationMs").add("truncated");
        return schema;
    }

    private static String tail(String text) {
        if (text == null) {
            return "";
        }
        return text.length() <= STDERR_TAIL_CHARS
                ? text
                : text.substring(text.length() - STDERR_TAIL_CHARS);
    }

    static RiskLevel riskLevel(ProcessToolDefinition definition) {
        String level = definition.risk() == null
                ? null
                : definition.risk().level();
        if (level == null) {
            return RiskLevel.READ_ONLY;
        }
        return switch (level) {
            case "read_only" -> RiskLevel.READ_ONLY;
            case "standard" -> RiskLevel.STANDARD;
            case "elevated" -> RiskLevel.ELEVATED;
            case "destructive" -> RiskLevel.DESTRUCTIVE;
            default -> throw new ToolRuntimeException(
                    "extension_manifest_invalid",
                    "未知风险等级: " + level
            );
        };
    }

    static ToolManifest.SideEffect sideEffect(
            ProcessToolDefinition definition
    ) {
        String value = definition.risk() == null
                ? null
                : definition.risk().sideEffect();
        if (value == null) {
            return ToolManifest.SideEffect.NONE;
        }
        return switch (value) {
            case "none" -> ToolManifest.SideEffect.NONE;
            case "internal_state" -> ToolManifest.SideEffect.INTERNAL_STATE;
            case "workspace_write" -> ToolManifest.SideEffect.WORKSPACE_WRITE;
            case "external_write" -> ToolManifest.SideEffect.EXTERNAL_WRITE;
            case "destructive" -> ToolManifest.SideEffect.DESTRUCTIVE;
            default -> throw new ToolRuntimeException(
                    "extension_manifest_invalid",
                    "未知副作用类型: " + value
            );
        };
    }

    static int timeoutSeconds(ProcessToolDefinition definition) {
        Long ms = definition.limits() == null
                ? null
                : definition.limits().timeoutMs();
        if (ms == null) {
            return 30;
        }
        return (int) Math.max(1, Math.min(1800, (ms + 999) / 1000));
    }

    static int resultLimit(ProcessToolDefinition definition) {
        Integer limit = definition.limits() == null
                ? null
                : definition.limits().maxResultChars();
        return limit == null ? 100_000 : Math.max(1_024, limit);
    }
}
