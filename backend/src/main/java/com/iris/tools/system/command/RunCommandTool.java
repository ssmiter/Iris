package com.iris.tools.system.command;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.node.ObjectNode;
import com.iris.execution.WorkspaceProcessRunner;
import com.iris.execution.BackgroundShellService;
import com.iris.tools.core.CommittedOperation;
import com.iris.tools.core.PreparedOperation;
import com.iris.tools.core.RiskLevel;
import com.iris.tools.core.Tool;
import com.iris.tools.core.ToolContext;
import com.iris.tools.core.ToolManifest;
import com.iris.tools.core.ToolOutcome;
import com.iris.tools.core.VerificationResult;
import com.iris.tools.core.ToolRuntimeException;
import com.iris.workspace.WorkspaceRootRegistry;
import org.springframework.stereotype.Component;

import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.charset.StandardCharsets;
import java.time.Duration;
import java.time.Instant;
import java.util.List;
import java.util.Map;

/** Windows-native escape hatch for tasks better expressed as a command than a bespoke Tool. */
@Component
public class RunCommandTool implements Tool {
    private static final int DEFAULT_TIMEOUT_SECONDS = 120;
    private static final int CAPTURE_BYTES = 256 * 1024;

    private final ObjectMapper json;
    private final WorkspaceProcessRunner processes;
    private final BackgroundShellService backgroundShell;
    private final WorkspaceRootRegistry roots;
    private final ToolManifest manifest;

    public RunCommandTool(
            ObjectMapper json,
            WorkspaceProcessRunner processes,
            BackgroundShellService backgroundShell,
            WorkspaceRootRegistry roots
    ) {
        this.json = json;
        this.processes = processes;
        this.backgroundShell = backgroundShell;
        this.roots = roots;
        this.manifest = new ToolManifest(
                "iris.system.command.run",
                "2",
                "run_command",
                "在 Windows PowerShell 中执行一条本机命令并返回退出码、stdout 与 stderr；适合已有 CLI 能直接完成的任务",
                inputSchema(),
                outputSchema(),
                RiskLevel.ELEVATED,
                ToolManifest.SideEffect.EXTERNAL_WRITE,
                1800,
                80_000,
                ToolManifest.IdempotencySemantics.NON_IDEMPOTENT,
                ToolManifest.EvidencePolicy.SUMMARY,
                ToolManifest.ContextRetention.REFETCHABLE,
                ToolManifest.ConcurrencySemantics.SERIAL,
                ToolManifest.CancellationSemantics.COMMIT_BOUNDARY,
                "powershell terminal cli execute process command",
                "workingDirectory 必须是工作区相对目录。命令可能改变本机状态，执行前会显示完整影响并经过审批；"
                        + "不要用它替代已有的文件读取、局部补丁或领域能力。退出码只证明进程结果，不证明用户目标完成。"
        );
    }

    @Override
    public ToolManifest manifest() { return manifest; }

    @Override
    public PreparedOperation prepare(JsonNode input, ToolContext context) {
        String command = input.path("command").asText().trim();
        if (command.isBlank() || command.indexOf('\0') >= 0) {
            throw new IllegalArgumentException("command 不能为空或包含 NUL");
        }
        String workingDirectory = input.path("workingDirectory").asText("").trim();
        if (workingDirectory.isBlank()) {
            workingDirectory = input.path("cwd").asText(".").trim();
        }
        boolean background = input.path("run_in_background").asBoolean(false);
        int timeoutSeconds = input.path("timeoutSeconds").asInt(DEFAULT_TIMEOUT_SECONDS);
        if (timeoutSeconds < 1 || timeoutSeconds > 1800) {
            throw new IllegalArgumentException("timeoutSeconds 必须在 1 到 1800 之间");
        }
        ObjectNode normalized = json.createObjectNode();
        normalized.put("command", command);
        normalized.put("workingDirectory", workingDirectory.isBlank() ? "." : workingDirectory);
        normalized.put("timeoutSeconds", timeoutSeconds);
        normalized.put("runInBackground", background);
        return new PreparedOperation(
                normalized,
                "在工作区目录 " + normalized.path("workingDirectory").asText()
                        + " 执行 PowerShell 命令：" + oneLine(command, 240),
                List.of(new PreparedOperation.ResourceClaim(
                        "process", "powershell:" + normalized.path("workingDirectory").asText(), null)),
                Instant.now().plusSeconds(300)
        );
    }

    @Override
    public ToolOutcome execute(CommittedOperation operation, ToolContext context) throws Exception {
        JsonNode input = operation.normalizedInput();
        String command = input.path("command").asText();
        String workingDirectory = input.path("workingDirectory").asText(".");
        int timeoutSeconds = input.path("timeoutSeconds").asInt(DEFAULT_TIMEOUT_SECONDS);
        CommandDirectory directory = resolveDirectory(
                context.workspaceRoot(), workingDirectory);
        if (input.path("runInBackground").asBoolean(false)) {
            BackgroundShellService.Handle handle = backgroundShell.start(
                    directory.root(), command, directory.relative(),
                    Duration.ofSeconds(timeoutSeconds));
            ObjectNode background = json.createObjectNode();
            background.put("background", true);
            background.put("task_id", handle.taskId());
            Path defaultAbsolute = context.workspaceRoot().toAbsolutePath().normalize();
            Path commandRoot = directory.root().toAbsolutePath().normalize();
            String outputFile = commandRoot.equals(defaultAbsolute)
                    ? "/workspace/.iris/commands/" + handle.taskId() + ".log"
                    : handle.outputPath();
            background.put("output_file", outputFile);
            background.put("cwd", directory.display());
            background.put("shell", "powershell");
            return ToolOutcome.succeeded(background);
        }
        WorkspaceProcessRunner.Result result = processes.run(
                directory.root(),
                new WorkspaceProcessRunner.Request(
                        List.of(
                                "powershell.exe",
                                "-NoLogo",
                                "-NoProfile",
                                "-NonInteractive",
                                "-Command",
                                command
                        ),
                        directory.relative(),
                        Duration.ofSeconds(timeoutSeconds),
                        CAPTURE_BYTES,
                        StandardCharsets.UTF_8,
                        true,
                        Map.of()
                ),
                context::cancelled
        );
        ObjectNode output = json.createObjectNode();
        output.put("workingDirectory", directory.display());
        output.put("cwd", directory.display());
        output.put("shell", "powershell");
        output.put("termination", result.termination().name().toLowerCase());
        if (result.exitCode().isPresent()) output.put("exitCode", result.exitCode().getAsInt());
        else output.putNull("exitCode");
        output.put("stdout", result.stdout().text());
        output.put("stderr", result.stderr().text());
        output.put("stdoutTruncated", result.stdout().truncated());
        output.put("stderrTruncated", result.stderr().truncated());
        output.put("durationMs", result.duration().toMillis());
        if (result.termination() == WorkspaceProcessRunner.Termination.TIMED_OUT) {
            return ToolOutcome.unknown(output, "command_timed_out", "命令超时后进程树已停止；请核对它是否已产生外部影响");
        }
        if (result.termination() == WorkspaceProcessRunner.Termination.CANCELLED) {
            return ToolOutcome.unknown(output, "command_cancelled", "命令被停止；请核对它是否已产生外部影响");
        }
        if (!result.succeeded()) {
            return ToolOutcome.failed(output, "command_failed", "命令以非零退出码结束；stderr 已返回");
        }
        return ToolOutcome.succeeded(output);
    }

    @Override
    public VerificationResult verify(ToolOutcome outcome, CommittedOperation operation, ToolContext context) {
        int exitCode = outcome.output().path("exitCode").asInt(-1);
        return VerificationResult.confirmed(List.of(new VerificationResult.Evidence(
                "process_exit", null, "PowerShell 进程已结束，退出码 " + exitCode)));
    }

    private JsonNode inputSchema() {
        ObjectNode schema = json.createObjectNode();
        schema.put("type", "object");
        schema.put("additionalProperties", false);
        ObjectNode properties = schema.putObject("properties");
        properties.putObject("command").put("type", "string")
                .put("description", "要交给 Windows PowerShell 执行的完整命令文本");
        properties.putObject("workingDirectory").put("type", "string")
                .put("description", "工作区内的相对工作目录，默认 .");
        properties.putObject("cwd").put("type", "string")
                .put("description", "workingDirectory 的简写；工作区内相对目录");
        properties.putObject("timeoutSeconds").put("type", "integer")
                .put("minimum", 1).put("maximum", 1800)
                .put("description", "超时秒数，默认 120，最大 1800");
        properties.putObject("run_in_background").put("type", "boolean")
                .put("description", "是否立即返回后台任务句柄；完整输出会落到 output_file");
        schema.putArray("required").add("command");
        return schema;
    }

    private JsonNode outputSchema() {
        ObjectNode schema = json.createObjectNode();
        schema.put("type", "object");
        schema.put("additionalProperties", false);
        ObjectNode properties = schema.putObject("properties");
        properties.putObject("workingDirectory").put("type", "string").put("description", "实际工作区相对目录");
        properties.putObject("termination").put("type", "string").put("description", "exited、timed_out 或 cancelled");
        var exitCode = properties.putObject("exitCode");
        exitCode.putArray("type").add("integer").add("null");
        exitCode.put("description", "进程退出码；未能取得时为 null");
        properties.putObject("stdout").put("type", "string").put("description", "标准输出的有界前缀");
        properties.putObject("stderr").put("type", "string").put("description", "标准错误的有界前缀");
        properties.putObject("stdoutTruncated").put("type", "boolean").put("description", "stdout 是否因留存预算截断");
        properties.putObject("stderrTruncated").put("type", "boolean").put("description", "stderr 是否因留存预算截断");
        properties.putObject("durationMs").put("type", "integer").put("description", "执行耗时毫秒");
        return schema;
    }

    private String oneLine(String value, int limit) {
        String normalized = value.replaceAll("\\s+", " ").trim();
        return normalized.length() <= limit ? normalized : normalized.substring(0, limit) + "…";
    }

    private CommandDirectory resolveDirectory(Path defaultRoot, String raw) {
        String value = raw == null || raw.isBlank() ? "." : raw.trim();
        if (!looksAbsolute(value)) {
            return new CommandDirectory(defaultRoot, value, defaultRoot
                    .resolve(value.replace('/', java.io.File.separatorChar))
                    .normalize().toString());
        }
        final Path candidate;
        try {
            candidate = Path.of(value.replace('/', java.io.File.separatorChar))
                    .toAbsolutePath().normalize();
        } catch (RuntimeException exception) {
            throw new ToolRuntimeException("workspace_path_invalid", "cwd 路径格式无效：" + value);
        }
        try {
            if (!Files.isDirectory(candidate) || !roots.allows(candidate)) {
                throw new ToolRuntimeException(
                        "directory_not_registered",
                        "cwd 所在目录尚未登记：" + value
                                + "；请先在浏览面板授权该目录后重试");
            }
            Path root = roots.bestRoot(candidate);
            if (root == null) {
                throw new ToolRuntimeException("directory_not_registered", "cwd 尚未登记：" + value);
            }
            String relative = root.relativize(candidate).toString().replace('\\', '/');
            if (relative.isBlank()) relative = ".";
            return new CommandDirectory(root, relative, candidate.toString());
        } catch (java.io.IOException exception) {
            throw new ToolRuntimeException("directory_not_registered", "无法确认 cwd：" + value);
        }
    }

    private boolean looksAbsolute(String value) {
        return value.matches("^[A-Za-z]:[\\\\/].*")
                || value.startsWith("\\\\") || value.startsWith("//");
    }

    private record CommandDirectory(Path root, String relative, String display) { }
}
