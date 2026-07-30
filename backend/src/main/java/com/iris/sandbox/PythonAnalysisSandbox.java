package com.iris.sandbox;

import com.iris.execution.WorkspaceProcessRunner;
import com.iris.execution.WorkspaceProcessRunner.Request;
import com.iris.execution.WorkspaceProcessRunner.Result;
import com.iris.tools.core.ToolRuntimeException;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.stereotype.Service;

import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.LinkOption;
import java.nio.file.Path;
import java.security.DigestInputStream;
import java.security.MessageDigest;
import java.security.NoSuchAlgorithmException;
import java.time.Duration;
import java.util.ArrayList;
import java.util.Comparator;
import java.util.HashMap;
import java.util.HashSet;
import java.util.HexFormat;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.OptionalInt;
import java.util.Set;
import java.util.UUID;
import java.util.function.BooleanSupplier;
import java.util.regex.Pattern;

/**
 * Python 数据分析的 staged execution adapter。
 *
 * <p>trusted_process 只提供生命周期和 I/O 围栏，不是 OS 安全沙箱。
 * 工具契约不暴露运行模式，因此以后可替换为 container/helper。</p>
 */
@Service
public class PythonAnalysisSandbox {
    private static final Pattern SAFE_MOUNT_NAME = Pattern.compile(
            "[A-Za-z0-9][A-Za-z0-9._-]{0,119}"
    );
    private static final Pattern RUN_DIRECTORY = Pattern.compile(
            "run_[a-f0-9]{32}"
    );
    private static final int MAX_INPUTS = 16;
    private static final int MAX_OUTPUTS = 8;

    private final WorkspaceProcessRunner processes;
    private final Mode mode;
    private final String pythonExecutable;
    private final Path runRoot;
    private final Duration timeout;
    private final int captureBytes;
    private final long maxInputBytes;
    private final long maxOutputBytes;

    public PythonAnalysisSandbox(
            WorkspaceProcessRunner processes,
            @Value("${iris.sandbox.python.mode:disabled}") String mode,
            @Value("${iris.sandbox.python.executable:python}")
            String pythonExecutable,
            @Value("${iris.sandbox.python.run-root:"
                    + "${user.home}/Iris/data/python-runs}")
            String runRoot,
            @Value("${iris.sandbox.python.timeout-sec:120}")
            long timeoutSeconds,
            @Value("${iris.sandbox.python.capture-limit-kb:64}")
            int captureLimitKb,
            @Value("${iris.sandbox.python.max-input-mb:64}")
            long maxInputMb,
            @Value("${iris.sandbox.python.max-output-mb:32}")
            long maxOutputMb
    ) throws IOException {
        this.processes = processes;
        this.mode = Mode.parse(mode);
        this.pythonExecutable = pythonExecutable;
        this.runRoot = Path.of(expandHome(runRoot))
                .toAbsolutePath().normalize();
        this.timeout = Duration.ofSeconds(requireRange(
                timeoutSeconds, 1, 1_800, "timeout-sec"
        ));
        this.captureBytes = Math.toIntExact(
                requireRange(
                        captureLimitKb,
                        1,
                        1_024,
                        "capture-limit-kb"
                ) * 1_024L
        );
        this.maxInputBytes = requireRange(
                maxInputMb, 1, 1_024, "max-input-mb"
        ) * 1024L * 1024L;
        this.maxOutputBytes = requireRange(
                maxOutputMb, 1, 1_024, "max-output-mb"
        ) * 1024L * 1024L;
        Files.createDirectories(this.runRoot);
        if (!Files.isDirectory(this.runRoot, LinkOption.NOFOLLOW_LINKS)
                || Files.isSymbolicLink(this.runRoot)) {
            throw new IOException(
                    "Python run root must be a regular directory"
            );
        }
    }

    public Assessment assessment() {
        return switch (mode) {
            case DISABLED -> new Assessment(
                    false,
                    false,
                    "Python analysis runtime 未启用"
            );
            case TRUSTED_PROCESS -> new Assessment(
                    true,
                    true,
                    "本机 trusted_process 已显式启用；具备 staged I/O，"
                            + "但不提供 OS 级文件与网络隔离"
            );
        };
    }

    public long maxInputBytes() {
        return maxInputBytes;
    }

    public ExecutionResult execute(
            String code,
            List<InputFile> inputs,
            List<String> expectedOutputs,
            BooleanSupplier cancelled
    ) throws IOException, InterruptedException {
        requireEnabled();
        validateNames(inputs, expectedOutputs);
        Path runDirectory = createRunDirectory();
        Path inputDirectory = Files.createDirectory(
                runDirectory.resolve("input")
        );
        Path outputDirectory = Files.createDirectory(
                runDirectory.resolve("output")
        );
        Path tempDirectory = Files.createDirectory(
                runDirectory.resolve("tmp")
        );
        try {
            stageInputs(inputDirectory, inputs, cancelled);
            Path script = runDirectory.resolve("analysis.py");
            Files.writeString(
                    script,
                    normalizeCode(code),
                    StandardCharsets.UTF_8
            );
            Map<String, String> environment = minimalEnvironment();
            environment.put(
                    "IRIS_INPUT_DIR",
                    inputDirectory.toString()
            );
            environment.put(
                    "IRIS_OUTPUT_DIR",
                    outputDirectory.toString()
            );
            environment.put("MPLBACKEND", "Agg");
            environment.put(
                    "MPLCONFIGDIR",
                    tempDirectory.resolve("matplotlib").toString()
            );
            environment.put("PYTHONIOENCODING", "utf-8");
            environment.put("PYTHONUTF8", "1");
            environment.put("PYTHONNOUSERSITE", "1");

            Result process = processes.run(
                    runDirectory,
                    new Request(
                            List.of(
                                    pythonExecutable,
                                    "-I",
                                    "-B",
                                    "-X",
                                    "utf8",
                                    script.getFileName().toString()
                            ),
                            ".",
                            timeout,
                            captureBytes,
                            StandardCharsets.UTF_8,
                            false,
                            environment
                    ),
                    cancelled
            );
            if (!process.succeeded()) {
                return failed(process);
            }
            List<OutputFile> outputs = collectOutputs(
                    outputDirectory,
                    expectedOutputs
            );
            return new ExecutionResult(
                    true,
                    mode.value,
                    process.stdout().text(),
                    process.stderr().text(),
                    process.stdout().truncated(),
                    process.stderr().truncated(),
                    process.exitCode(),
                    process.duration().toMillis(),
                    null,
                    outputs
            );
        } finally {
            deleteRunDirectory(runDirectory);
        }
    }

    private ExecutionResult failed(Result process) {
        String message = switch (process.termination()) {
            case TIMED_OUT -> "Python 执行超时，staged output 未提交";
            case CANCELLED -> "Python 执行已取消，staged output 未提交";
            case EXITED -> "Python 进程退出码不是 0，staged output 未提交";
        };
        return new ExecutionResult(
                false,
                mode.value,
                process.stdout().text(),
                process.stderr().text(),
                process.stdout().truncated(),
                process.stderr().truncated(),
                process.exitCode(),
                process.duration().toMillis(),
                message,
                List.of()
        );
    }

    private void stageInputs(
            Path inputDirectory,
            List<InputFile> inputs,
            BooleanSupplier cancelled
    ) throws IOException {
        long total = 0;
        byte[] buffer = new byte[64 * 1024];
        for (InputFile input : inputs) {
            if (cancelled.getAsBoolean()) {
                throw ToolRuntimeException.beforeCommit(
                        "cancelled_before_commit",
                        "任务已停止，Python 尚未启动"
                );
            }
            Path target = inputDirectory.resolve(input.mountName());
            MessageDigest digest = sha256();
            InputStream rawSource = input.physicalPath() == null
                    ? new java.io.ByteArrayInputStream(input.inlineContent())
                    : Files.newInputStream(input.physicalPath());
            try (InputStream source = new DigestInputStream(
                    rawSource,
                    digest
            );
                 OutputStream destination = Files.newOutputStream(target)) {
                int read;
                while ((read = source.read(buffer)) != -1) {
                    total += read;
                    if (total > maxInputBytes) {
                        throw ToolRuntimeException.beforeCommit(
                                "python_input_budget_exceeded",
                                "声明输入总量超过 Python staged input 上限"
                        );
                    }
                    destination.write(buffer, 0, read);
                }
            }
            String actual = HexFormat.of().formatHex(digest.digest());
            if (!actual.equals(input.expectedContentHash())) {
                throw ToolRuntimeException.beforeCommit(
                        "python_input_version_changed",
                        "输入内容在准备后发生变化：" + input.sourceReference()
                );
            }
        }
    }

    private List<OutputFile> collectOutputs(
            Path outputDirectory,
            List<String> expectedOutputs
    ) throws IOException {
        Set<String> expected = Set.copyOf(expectedOutputs);
        List<Path> entries;
        try (var stream = Files.list(outputDirectory)) {
            entries = stream.toList();
        }
        Set<String> actual = new HashSet<>();
        for (Path entry : entries) {
            if (!Files.isRegularFile(entry, LinkOption.NOFOLLOW_LINKS)
                    || Files.isSymbolicLink(entry)) {
                throw ToolRuntimeException.beforeCommit(
                        "python_output_invalid",
                        "staged output 只允许顶层普通文件"
                );
            }
            actual.add(entry.getFileName().toString());
        }
        if (!actual.equals(expected)) {
            throw ToolRuntimeException.beforeCommit(
                    "python_output_set_mismatch",
                    "脚本输出与声明不一致；期望 " + expected
                            + "，实际 " + actual
            );
        }
        long total = 0;
        List<OutputFile> outputs = new ArrayList<>();
        for (String name : expectedOutputs) {
            Path path = outputDirectory.resolve(name);
            long size = Files.size(path);
            total += size;
            if (total > maxOutputBytes) {
                throw ToolRuntimeException.beforeCommit(
                        "python_output_budget_exceeded",
                        "Python staged output 总量超过限制"
                );
            }
            outputs.add(new OutputFile(
                    name,
                    Files.readAllBytes(path)
            ));
        }
        return List.copyOf(outputs);
    }

    private void validateNames(
            List<InputFile> inputs,
            List<String> outputs
    ) {
        if (inputs.size() > MAX_INPUTS) {
            throw ToolRuntimeException.beforeCommit(
                    "python_input_count_exceeded",
                    "Python 输入文件最多 " + MAX_INPUTS + " 个"
            );
        }
        if (outputs.isEmpty() || outputs.size() > MAX_OUTPUTS) {
            throw ToolRuntimeException.beforeCommit(
                    "python_output_count_invalid",
                    "Python 输出文件必须为 1 到 " + MAX_OUTPUTS + " 个"
            );
        }
        Set<String> names = new HashSet<>();
        for (InputFile input : inputs) {
            requireSafeName(input.mountName(), "mount_name");
            if (!names.add(input.mountName().toLowerCase(Locale.ROOT))) {
                throw ToolRuntimeException.beforeCommit(
                        "python_input_name_conflict",
                        "Python 输入 mount_name 不能重复"
                );
            }
        }
        names.clear();
        for (String output : outputs) {
            requireSafeName(output, "output_name");
            if (!names.add(output.toLowerCase(Locale.ROOT))) {
                throw ToolRuntimeException.beforeCommit(
                        "python_output_name_conflict",
                        "Python output_name 不能重复"
                );
            }
        }
    }

    private void requireSafeName(String value, String field) {
        if (value == null || !SAFE_MOUNT_NAME.matcher(value).matches()
                || ".".equals(value) || "..".equals(value)) {
            throw ToolRuntimeException.beforeCommit(
                    "invalid_python_" + field,
                    field + " 必须是 1 到 120 字符的安全文件名，不能包含目录"
            );
        }
    }

    private Path createRunDirectory() throws IOException {
        Path directory = runRoot.resolve(
                "run_" + UUID.randomUUID().toString().replace("-", "")
        );
        if (!directory.normalize().getParent().equals(runRoot)) {
            throw new IOException("Python run path escaped root");
        }
        return Files.createDirectory(directory);
    }

    private void deleteRunDirectory(Path directory) throws IOException {
        Path normalized = directory.toAbsolutePath().normalize();
        if (!normalized.getParent().equals(runRoot)
                || !RUN_DIRECTORY.matcher(
                normalized.getFileName().toString()
        ).matches()) {
            throw new IOException("Refusing to delete invalid Python run");
        }
        try (var paths = Files.walk(normalized)) {
            for (Path path : paths.sorted(Comparator.reverseOrder()).toList()) {
                Files.deleteIfExists(path);
            }
        }
    }

    private Map<String, String> minimalEnvironment() {
        Map<String, String> environment = new HashMap<>();
        copyEnvironment(environment, "SystemRoot");
        copyEnvironment(environment, "WINDIR");
        copyEnvironment(environment, "PATH");
        copyEnvironment(environment, "PATHEXT");
        copyEnvironment(environment, "TEMP");
        copyEnvironment(environment, "TMP");
        return environment;
    }

    private void copyEnvironment(Map<String, String> target, String name) {
        String value = System.getenv(name);
        if (value != null && !value.isBlank()) {
            target.put(name, value);
        }
    }

    private String normalizeCode(String code) {
        return code.replace("\r\n", "\n")
                .replace('\r', '\n')
                .strip() + "\n";
    }

    private void requireEnabled() {
        if (mode == Mode.DISABLED) {
            throw ToolRuntimeException.beforeCommit(
                    "python_runtime_unavailable",
                    "Python analysis runtime 未启用"
            );
        }
    }

    private long requireRange(
            long value,
            long minimum,
            long maximum,
            String field
    ) {
        if (value < minimum || value > maximum) {
            throw new IllegalArgumentException(
                    "iris.sandbox.python." + field + " out of range"
            );
        }
        return value;
    }

    private String expandHome(String configured) {
        return configured.startsWith("~/")
                || configured.startsWith("~\\")
                ? System.getProperty("user.home") + configured.substring(1)
                : configured;
    }

    private MessageDigest sha256() {
        try {
            return MessageDigest.getInstance("SHA-256");
        } catch (NoSuchAlgorithmException exception) {
            throw new IllegalStateException("SHA-256 unavailable", exception);
        }
    }

    private enum Mode {
        DISABLED("disabled"),
        TRUSTED_PROCESS("trusted_process");

        private final String value;

        Mode(String value) {
            this.value = value;
        }

        private static Mode parse(String value) {
            for (Mode mode : values()) {
                if (mode.value.equalsIgnoreCase(value)) {
                    return mode;
                }
            }
            throw new IllegalArgumentException(
                    "Unknown Python runtime mode: " + value
            );
        }
    }

    public record Assessment(
            boolean executable,
            boolean degraded,
            String reason
    ) {
    }

    public record InputFile(
            String sourceReference,
            Path physicalPath,
            byte[] inlineContent,
            String expectedContentHash,
            String mountName
    ) {
        public InputFile {
            if ((physicalPath == null) == (inlineContent == null)) {
                throw new IllegalArgumentException(
                        "Python input needs exactly one content source"
                );
            }
            inlineContent = inlineContent == null
                    ? null
                    : inlineContent.clone();
        }

        public static InputFile workspace(
                String sourceReference,
                Path physicalPath,
                String expectedContentHash,
                String mountName
        ) {
            return new InputFile(
                    sourceReference,
                    physicalPath,
                    null,
                    expectedContentHash,
                    mountName
            );
        }

        public static InputFile immutable(
                String sourceReference,
                byte[] content,
                String expectedContentHash,
                String mountName
        ) {
            return new InputFile(
                    sourceReference,
                    null,
                    content,
                    expectedContentHash,
                    mountName
            );
        }

        @Override
        public byte[] inlineContent() {
            return inlineContent == null ? null : inlineContent.clone();
        }
    }

    public record OutputFile(String name, byte[] bytes) {
        public OutputFile {
            bytes = bytes.clone();
        }

        @Override
        public byte[] bytes() {
            return bytes.clone();
        }
    }

    public record ExecutionResult(
            boolean success,
            String runtimeMode,
            String stdout,
            String stderr,
            boolean stdoutTruncated,
            boolean stderrTruncated,
            OptionalInt exitCode,
            long durationMs,
            String failureMessage,
            List<OutputFile> outputs
    ) {
        public ExecutionResult {
            outputs = List.copyOf(outputs);
        }
    }
}
