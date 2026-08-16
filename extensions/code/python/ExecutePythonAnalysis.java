import java.io.BufferedReader;
import java.io.BufferedWriter;
import java.io.ByteArrayOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.InputStreamReader;
import java.io.OutputStreamWriter;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.Comparator;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.TimeUnit;
import java.util.regex.Pattern;
import java.util.stream.Stream;

/**
 * execute_python_analysis 常驻插件（docs/31 §4）：受控 Python 分析运行时。
 *
 * <p>宿主是 Java 单文件源码（随内核发行，永远可拉起）；被分析的脚本由
 * 本机 python 解释器执行。找不到解释器时本次调用以
 * python_runtime_unavailable 明确报错，不静默降级。</p>
 *
 * <p>边界：脚本只读 IRIS_INPUT_DIR（声明输入的只读副本）、只写
 * IRIS_OUTPUT_DIR；声明输出集合必须精确匹配，核验后写入工作区围栏内
 * 的声明路径。审批、超时与取消三层在内核；cancel 帧到达时本插件
 * 主动终止在途子进程。</p>
 */
public class ExecutePythonAnalysis {

    private static final int MAX_CODE_CHARACTERS = 120_000;
    private static final int MAX_INPUTS = 16;
    private static final int MAX_OUTPUTS = 8;
    private static final long MAX_INPUT_BYTES_TOTAL = 64L * 1024 * 1024;
    private static final long MAX_OUTPUT_BYTES_EACH = 32L * 1024 * 1024;
    private static final int MAX_CAPTURE_CHARS = 64 * 1024;
    private static final long PYTHON_PROBE_TIMEOUT_MS = 10_000;
    private static final Pattern SAFE_FILE_NAME = Pattern.compile(
            "[A-Za-z0-9][A-Za-z0-9._-]{0,119}");

    private static final Map<String, CallTask> inFlight =
            new ConcurrentHashMap<>();
    private static BufferedWriter out;
    /** 解释器探测只做一次；null 元素表示"已探测且不可用"。 */
    private static volatile String pythonExecutable;

    public static void main(String[] args) throws Exception {
        BufferedReader in = new BufferedReader(new InputStreamReader(
                System.in, StandardCharsets.UTF_8));
        out = new BufferedWriter(new OutputStreamWriter(
                System.out, StandardCharsets.UTF_8));
        String line;
        while ((line = in.readLine()) != null) {
            if (line.isBlank()) {
                continue;
            }
            Object frame;
            try {
                frame = Json.parse(line);
            } catch (RuntimeException parseFailure) {
                continue;
            }
            if (!(frame instanceof Map<?, ?> message)) {
                continue;
            }
            String callId = message.get("callId") instanceof String text
                    ? text : null;
            if (callId == null) {
                continue;
            }
            if ("cancel".equals(message.get("type"))) {
                CallTask task = inFlight.get(callId);
                if (task != null) {
                    task.cancel();
                }
                continue;
            }
            if (!"invoke".equals(message.get("type"))) {
                continue;
            }
            CallTask task = new CallTask(callId, message);
            inFlight.put(callId, task);
            Thread.ofVirtual()
                    .name("python-analysis-" + callId)
                    .start(task);
        }
        // stdin EOF = 内核退出：取消全部在途调用并等它们写出结果帧，
        // 再退出（虚拟线程是 daemon，main 返回即 JVM 退出，不能留半截）。
        inFlight.values().forEach(CallTask::cancel);
        long drainDeadline = System.currentTimeMillis() + 10_000;
        while (!inFlight.isEmpty()
                && System.currentTimeMillis() < drainDeadline) {
            try {
                Thread.sleep(20);
            } catch (InterruptedException interrupted) {
                Thread.currentThread().interrupt();
                break;
            }
        }
    }

    /** 一次 invoke 的执行体；结果帧恰好写一次。 */
    private static final class CallTask implements Runnable {
        private final String callId;
        private final Map<?, ?> message;
        private volatile Process child;
        private volatile boolean cancelled;

        CallTask(String callId, Map<?, ?> message) {
            this.callId = callId;
            this.message = message;
        }

        void cancel() {
            cancelled = true;
            Process snapshot = child;
            if (snapshot != null) {
                snapshot.destroyForcibly();
            }
        }

        @Override
        public void run() {
            Map<String, Object> result = new LinkedHashMap<>();
            result.put("type", "result");
            result.put("callId", callId);
            try {
                result.putAll(execute());
            } catch (Cancelled ignored) {
                result.clear();
                result.put("type", "result");
                result.put("callId", callId);
                result.put("success", false);
                result.put("error", error(
                        "cancelled", "调用已被取消，Python 子进程已终止"));
            } catch (Failure failure) {
                result.put("success", false);
                result.put("error", error(failure.code, failure.getMessage()));
            } catch (Exception unexpected) {
                result.put("success", false);
                result.put("error", error(
                        "python_plugin_internal_error",
                        "插件内部错误: " + unexpected));
            } finally {
                inFlight.remove(callId);
                writeFrame(result);
            }
        }

        private Map<String, Object> execute() throws Exception {
            Map<?, ?> input = message.get("input")
                    instanceof Map<?, ?> map ? map : Map.of();
            Path workspace = workspaceRoot(message);

            String code = input.get("code") instanceof String text
                    ? text : "";
            if (code.isBlank() || code.length() > MAX_CODE_CHARACTERS) {
                throw new Failure("invalid_python_code",
                        "code 必须为 1 到 " + MAX_CODE_CHARACTERS
                                + " 字符的非空 Python 源码");
            }
            List<DeclaredInput> inputs = declaredInputs(input, workspace);
            List<DeclaredOutput> outputs = declaredOutputs(input, workspace);

            String python = requirePython();
            throwIfCancelled();

            Path runDir = Files.createTempDirectory("iris-python-analysis-");
            try {
                Path inputDir = Files.createDirectory(runDir.resolve("input"));
                Path outputDir = Files.createDirectory(
                        runDir.resolve("output"));
                for (DeclaredInput declared : inputs) {
                    Files.copy(declared.source(),
                            inputDir.resolve(declared.mountName()));
                }
                Path script = runDir.resolve("analysis.py");
                Files.writeString(script, code, StandardCharsets.UTF_8);

                long startedNanos = System.nanoTime();
                RunOutcome run = runPython(python, script, runDir,
                        inputDir, outputDir);
                long durationMs =
                        (System.nanoTime() - startedNanos) / 1_000_000L;
                throwIfCancelled();
                if (run.exitCode() != 0) {
                    throw new Failure("python_execution_failed",
                            "Python 退出码 " + run.exitCode()
                                    + "；staged output 未提交"
                                    + tailBlock("stderr", run.stderr())
                                    + tailBlock("stdout", run.stdout()));
                }

                Map<String, byte[]> produced = readProduced(outputDir);
                List<String> expectedNames = outputs.stream()
                        .map(DeclaredOutput::outputName).sorted().toList();
                List<String> actualNames =
                        produced.keySet().stream().sorted().toList();
                if (!expectedNames.equals(actualNames)) {
                    throw new Failure("python_output_set_mismatch",
                            "声明输出与实际产物不一致：声明 " + expectedNames
                                    + "，实际 " + actualNames);
                }

                List<Map<String, Object>> committed = new ArrayList<>();
                for (DeclaredOutput declared : outputs) {
                    byte[] bytes = produced.get(declared.outputName());
                    Files.write(declared.target(), bytes);
                    Map<String, Object> item = new LinkedHashMap<>();
                    item.put("output_name", declared.outputName());
                    item.put("workspace_path",
                            workspace.relativize(declared.target())
                                    .toString().replace('\\', '/'));
                    item.put("bytes_written", bytes.length);
                    committed.add(item);
                }

                Map<String, Object> structured = new LinkedHashMap<>();
                structured.put("python", python);
                structured.put("duration_ms", durationMs);
                structured.put("stdout", run.stdout());
                structured.put("stderr", run.stderr());
                structured.put("stdout_truncated", run.stdoutTruncated());
                structured.put("stderr_truncated", run.stderrTruncated());
                structured.put("outputs", committed);

                Map<String, Object> success = new LinkedHashMap<>();
                success.put("success", true);
                success.put("data", "Python 运行成功，已写入 "
                        + committed.size() + " 个声明输出（"
                        + durationMs + "ms）");
                success.put("structuredData", structured);
                return success;
            } finally {
                deleteRecursively(runDir);
            }
        }

        private RunOutcome runPython(
                String python,
                Path script,
                Path runDir,
                Path inputDir,
                Path outputDir
        ) throws IOException, InterruptedException, Cancelled {
            ProcessBuilder builder = new ProcessBuilder(
                    python, script.toAbsolutePath().toString());
            builder.directory(runDir.toFile());
            builder.environment().put(
                    "IRIS_INPUT_DIR", inputDir.toAbsolutePath().toString());
            builder.environment().put(
                    "IRIS_OUTPUT_DIR", outputDir.toAbsolutePath().toString());
            builder.environment().put("PYTHONIOENCODING", "utf-8");
            Process process = builder.start();
            child = process;
            CapturedStream stdout = new CapturedStream(
                    process.getInputStream());
            CapturedStream stderr = new CapturedStream(
                    process.getErrorStream());
            try {
                while (true) {
                    throwIfCancelled();
                    try {
                        int exit = process.exitValue();
                        stdout.join();
                        stderr.join();
                        return new RunOutcome(exit,
                                stdout.text(), stdout.truncated(),
                                stderr.text(), stderr.truncated());
                    } catch (IllegalThreadStateException stillRunning) {
                        Thread.sleep(50);
                    }
                }
            } finally {
                if (process.isAlive()) {
                    process.destroyForcibly();
                }
                child = null;
            }
        }

        private void throwIfCancelled() throws Cancelled {
            if (cancelled) {
                Process snapshot = child;
                if (snapshot != null) {
                    snapshot.destroyForcibly();
                }
                throw new Cancelled();
            }
        }
    }

    private record DeclaredInput(Path source, String mountName) {
    }

    private record DeclaredOutput(String outputName, Path target) {
    }

    private record RunOutcome(
            int exitCode,
            String stdout,
            boolean stdoutTruncated,
            String stderr,
            boolean stderrTruncated
    ) {
    }

    /** 有界捕获子进程输出：超过上限即丢弃后续字节并标记截断。 */
    private static final class CapturedStream {
        private final ByteArrayOutputStream buffer =
                new ByteArrayOutputStream();
        private final Thread reader;
        private volatile boolean truncated;

        CapturedStream(InputStream stream) {
            reader = Thread.ofVirtual().start(() -> {
                byte[] chunk = new byte[8192];
                try {
                    int read;
                    while ((read = stream.read(chunk)) != -1) {
                        synchronized (buffer) {
                            if (buffer.size() < MAX_CAPTURE_CHARS * 4L) {
                                buffer.write(chunk, 0, read);
                            } else {
                                truncated = true;
                            }
                        }
                    }
                } catch (IOException ignored) {
                    // 进程结束即管道关闭，正常。
                }
            });
        }

        void join() throws InterruptedException {
            reader.join(TimeUnit.SECONDS.toMillis(5));
        }

        String text() {
            String decoded;
            synchronized (buffer) {
                decoded = buffer.toString(StandardCharsets.UTF_8);
            }
            return decoded.length() <= MAX_CAPTURE_CHARS
                    ? decoded
                    : decoded.substring(0, MAX_CAPTURE_CHARS);
        }

        boolean truncated() {
            return truncated;
        }
    }

    private static Path workspaceRoot(Map<?, ?> message) throws Failure {
        Object context = message.get("context");
        Object workspace = context instanceof Map<?, ?> map
                ? map.get("workspace") : null;
        if (!(workspace instanceof String text) || text.isBlank()) {
            throw new Failure("workspace_root_missing",
                    "invoke 帧缺少 context.workspace");
        }
        return Path.of(text).toAbsolutePath().normalize();
    }

    /** 工作区围栏（fail-close）：拒绝绝对路径与任何越界解析。 */
    private static Path fence(Path root, String relative, String field)
            throws Failure {
        Path candidate;
        try {
            candidate = Path.of(relative);
        } catch (RuntimeException invalid) {
            throw new Failure("invalid_python_" + field,
                    field + " 不是合法相对路径: " + relative);
        }
        if (candidate.isAbsolute()) {
            throw new Failure("workspace_fence_violation",
                    field + " 必须是工作区内相对路径: " + relative);
        }
        Path resolved = root.resolve(candidate).normalize();
        if (!resolved.startsWith(root) || resolved.equals(root)) {
            throw new Failure("workspace_fence_violation",
                    field + " 越过工作区围栏: " + relative);
        }
        return resolved;
    }

    private static List<DeclaredInput> declaredInputs(
            Map<?, ?> input, Path workspace) throws Failure {
        List<?> raw = input.get("inputs") instanceof List<?> list
                ? list : List.of();
        if (raw.size() > MAX_INPUTS) {
            throw new Failure("python_input_count_exceeded",
                    "inputs 数量不能超过 " + MAX_INPUTS);
        }
        List<DeclaredInput> declared = new ArrayList<>();
        List<String> names = new ArrayList<>();
        long totalBytes = 0;
        for (Object element : raw) {
            if (!(element instanceof Map<?, ?> item)) {
                throw new Failure("invalid_python_input",
                        "inputs 的每一项都必须是 object");
            }
            String workspacePath = item.get("workspace_path")
                    instanceof String text ? text : "";
            String mountName = item.get("mount_name")
                    instanceof String text ? text : "";
            if (workspacePath.isBlank()
                    || !SAFE_FILE_NAME.matcher(mountName).matches()) {
                throw new Failure("invalid_python_input",
                        "每个 input 必须声明 workspace_path 与安全的扁平 "
                                + "mount_name");
            }
            if (!names.add(mountName.toLowerCase(java.util.Locale.ROOT))) {
                throw new Failure("python_mount_name_conflict",
                        "mount_name 不能重复: " + mountName);
            }
            Path source = fence(workspace, workspacePath, "workspace_path");
            if (!Files.isRegularFile(source)) {
                throw new Failure("python_input_not_found",
                        "声明输入不存在: " + workspacePath);
            }
            try {
                totalBytes += Files.size(source);
            } catch (IOException readFailure) {
                throw new Failure("python_input_not_found",
                        "声明输入不可读: " + workspacePath);
            }
            if (totalBytes > MAX_INPUT_BYTES_TOTAL) {
                throw new Failure("python_input_budget_exceeded",
                        "声明输入总量超过 staged input 上限（64MB）");
            }
            declared.add(new DeclaredInput(source, mountName));
        }
        return declared;
    }

    private static List<DeclaredOutput> declaredOutputs(
            Map<?, ?> input, Path workspace) throws Failure {
        List<?> raw = input.get("outputs") instanceof List<?> list
                ? list : List.of();
        if (raw.isEmpty() || raw.size() > MAX_OUTPUTS) {
            throw new Failure("python_output_count_invalid",
                    "outputs 数量必须为 1 到 " + MAX_OUTPUTS);
        }
        List<DeclaredOutput> declared = new ArrayList<>();
        List<String> names = new ArrayList<>();
        List<String> paths = new ArrayList<>();
        for (Object element : raw) {
            if (!(element instanceof Map<?, ?> item)) {
                throw new Failure("invalid_python_output",
                        "outputs 的每一项都必须是 object");
            }
            String outputName = item.get("output_name")
                    instanceof String text ? text : "";
            String workspacePath = item.get("workspace_path")
                    instanceof String text ? text : "";
            if (!SAFE_FILE_NAME.matcher(outputName).matches()
                    || workspacePath.isBlank()) {
                throw new Failure("invalid_python_output",
                        "每个 output 必须声明安全的扁平 output_name 与 "
                                + "workspace_path");
            }
            if (!names.add(outputName.toLowerCase(java.util.Locale.ROOT))) {
                throw new Failure("python_output_name_conflict",
                        "output_name 不能重复: " + outputName);
            }
            Path target = fence(workspace, workspacePath, "workspace_path");
            if (!paths.add(target.toString().toLowerCase(
                    java.util.Locale.ROOT))) {
                throw new Failure("python_workspace_path_conflict",
                        "workspace_path 不能重复: " + workspacePath);
            }
            if (!Files.isDirectory(target.getParent())) {
                throw new Failure("workspace_parent_not_found",
                        "输出父目录不存在；请先创建目录: " + workspacePath);
            }
            declared.add(new DeclaredOutput(outputName, target));
        }
        return declared;
    }

    private static Map<String, byte[]> readProduced(Path outputDir)
            throws Failure {
        Map<String, byte[]> produced = new LinkedHashMap<>();
        try (Stream<Path> files = Files.list(outputDir)) {
            for (Path file : files.sorted(
                    Comparator.comparing(Path::toString)).toList()) {
                if (!Files.isRegularFile(file)) {
                    continue;
                }
                long size = Files.size(file);
                if (size > MAX_OUTPUT_BYTES_EACH) {
                    throw new Failure("python_output_budget_exceeded",
                            "单个输出超过 32MB 上限: "
                                    + file.getFileName());
                }
                produced.put(file.getFileName().toString(),
                        Files.readAllBytes(file));
            }
        } catch (IOException readFailure) {
            throw new Failure("python_output_invalid",
                    "读取 staged output 失败: " + readFailure.getMessage());
        }
        return produced;
    }

    /**
     * 解释器解析：IRIS_PYTHON 环境变量优先，其次 PATH 上的 python/python3；
     * 以 --version 实跑探测，结果缓存。找不到 = 本次调用明确报错。
     */
    private static String requirePython() throws Failure {
        String cached = pythonExecutable;
        if (cached != null) {
            if (cached.isEmpty()) {
                throw unavailable();
            }
            return cached;
        }
        synchronized (ExecutePythonAnalysis.class) {
            if (pythonExecutable != null) {
                return pythonExecutable.isEmpty() ? throwUnavailable()
                        : pythonExecutable;
            }
            List<String> candidates = new ArrayList<>();
            String override = System.getenv("IRIS_PYTHON");
            if (override != null && !override.isBlank()) {
                candidates.add(override.trim());
            }
            candidates.add("python");
            candidates.add("python3");
            for (String candidate : candidates) {
                if (probe(candidate)) {
                    pythonExecutable = candidate;
                    return candidate;
                }
            }
            pythonExecutable = "";
            throw unavailable();
        }
    }

    private static String throwUnavailable() throws Failure {
        throw unavailable();
    }

    private static Failure unavailable() {
        return new Failure("python_runtime_unavailable",
                "未找到可用的 Python 解释器：已尝试 IRIS_PYTHON 环境变量与 "
                        + "PATH 上的 python/python3；请安装 Python 或设置 "
                        + "IRIS_PYTHON 指向解释器可执行文件");
    }

    private static boolean probe(String executable) {
        try {
            Process probe = new ProcessBuilder(executable, "--version")
                    .redirectErrorStream(true).start();
            boolean done = probe.waitFor(
                    PYTHON_PROBE_TIMEOUT_MS, TimeUnit.MILLISECONDS);
            if (!done) {
                probe.destroyForcibly();
                return false;
            }
            return probe.exitValue() == 0;
        } catch (IOException | InterruptedException failure) {
            if (failure instanceof InterruptedException) {
                Thread.currentThread().interrupt();
            }
            return false;
        }
    }

    private static String tailBlock(String label, String content) {
        if (content == null || content.isBlank()) {
            return "";
        }
        String tail = content.length() <= 4_000
                ? content : content.substring(content.length() - 4_000);
        return "\n" + label + ":\n" + tail;
    }

    private static void deleteRecursively(Path dir) {
        try (Stream<Path> walk = Files.walk(dir)) {
            walk.sorted(Comparator.reverseOrder()).forEach(path -> {
                try {
                    Files.deleteIfExists(path);
                } catch (IOException ignored) {
                    // 临时目录清理失败不影响结果。
                }
            });
        } catch (IOException ignored) {
            // 同上。
        }
    }

    private static Map<String, Object> error(String code, String message) {
        Map<String, Object> error = new LinkedHashMap<>();
        error.put("code", code);
        error.put("message", message);
        return error;
    }

    private static synchronized void writeFrame(Map<String, Object> frame) {
        try {
            out.write(Json.write(frame));
            out.newLine();
            out.flush();
        } catch (IOException ignored) {
            // 管道已断，内核侧按进程死亡处理。
        }
    }

    private static final class Failure extends Exception {
        final String code;

        Failure(String code, String message) {
            super(message);
            this.code = code;
        }
    }

    private static final class Cancelled extends Exception {
    }

    /**
     * 最小 JSON 编解码（对象/数组/字符串/数字/布尔/null），
     * 与 calculate 插件同形。
     */
    static final class Json {

        static Object parse(String text) {
            Parser parser = new Parser(text);
            Object value = parser.parseValue();
            parser.skipWhitespace();
            if (!parser.atEnd()) {
                throw new IllegalArgumentException("JSON 尾部有多余字符");
            }
            return value;
        }

        static String write(Object value) {
            StringBuilder out = new StringBuilder();
            writeValue(value, out);
            return out.toString();
        }

        private static void writeValue(Object value, StringBuilder out) {
            if (value == null) {
                out.append("null");
            } else if (value instanceof String text) {
                writeString(text, out);
            } else if (value instanceof Number || value instanceof Boolean) {
                out.append(value.toString());
            } else if (value instanceof Map<?, ?> map) {
                out.append('{');
                boolean first = true;
                for (Map.Entry<?, ?> entry : map.entrySet()) {
                    if (!first) {
                        out.append(',');
                    }
                    first = false;
                    writeString(String.valueOf(entry.getKey()), out);
                    out.append(':');
                    writeValue(entry.getValue(), out);
                }
                out.append('}');
            } else if (value instanceof List<?> list) {
                out.append('[');
                boolean first = true;
                for (Object element : list) {
                    if (!first) {
                        out.append(',');
                    }
                    first = false;
                    writeValue(element, out);
                }
                out.append(']');
            } else {
                writeString(String.valueOf(value), out);
            }
        }

        private static void writeString(String text, StringBuilder out) {
            out.append('"');
            for (int i = 0; i < text.length(); i++) {
                char c = text.charAt(i);
                switch (c) {
                    case '"' -> out.append("\\\"");
                    case '\\' -> out.append("\\\\");
                    case '\n' -> out.append("\\n");
                    case '\r' -> out.append("\\r");
                    case '\t' -> out.append("\\t");
                    default -> {
                        if (c < 0x20) {
                            out.append(String.format("\\u%04x", (int) c));
                        } else {
                            out.append(c);
                        }
                    }
                }
            }
            out.append('"');
        }

        private static final class Parser {
            private final String text;
            private int position;

            Parser(String text) {
                this.text = text;
            }

            Object parseValue() {
                skipWhitespace();
                if (atEnd()) {
                    throw new IllegalArgumentException("JSON 意外结束");
                }
                char c = text.charAt(position);
                return switch (c) {
                    case '{' -> parseObject();
                    case '[' -> parseArray();
                    case '"' -> parseString();
                    case 't' -> literal("true", Boolean.TRUE);
                    case 'f' -> literal("false", Boolean.FALSE);
                    case 'n' -> literal("null", null);
                    default -> parseNumber();
                };
            }

            private Map<String, Object> parseObject() {
                Map<String, Object> map = new LinkedHashMap<>();
                position++; // '{'
                skipWhitespace();
                if (!atEnd() && text.charAt(position) == '}') {
                    position++;
                    return map;
                }
                while (true) {
                    skipWhitespace();
                    String key = parseString();
                    skipWhitespace();
                    expect(':');
                    map.put(key, parseValue());
                    skipWhitespace();
                    if (!atEnd() && text.charAt(position) == ',') {
                        position++;
                        continue;
                    }
                    expect('}');
                    return map;
                }
            }

            private List<Object> parseArray() {
                List<Object> list = new ArrayList<>();
                position++; // '['
                skipWhitespace();
                if (!atEnd() && text.charAt(position) == ']') {
                    position++;
                    return list;
                }
                while (true) {
                    list.add(parseValue());
                    skipWhitespace();
                    if (!atEnd() && text.charAt(position) == ',') {
                        position++;
                        continue;
                    }
                    expect(']');
                    return list;
                }
            }

            private String parseString() {
                expect('"');
                StringBuilder value = new StringBuilder();
                while (!atEnd()) {
                    char c = text.charAt(position++);
                    if (c == '"') {
                        return value.toString();
                    }
                    if (c == '\\') {
                        if (atEnd()) {
                            break;
                        }
                        char escape = text.charAt(position++);
                        switch (escape) {
                            case '"' -> value.append('"');
                            case '\\' -> value.append('\\');
                            case '/' -> value.append('/');
                            case 'n' -> value.append('\n');
                            case 'r' -> value.append('\r');
                            case 't' -> value.append('\t');
                            case 'b' -> value.append('\b');
                            case 'f' -> value.append('\f');
                            case 'u' -> {
                                value.append((char) Integer.parseInt(
                                        text.substring(position, position + 4),
                                        16));
                                position += 4;
                            }
                            default -> throw new IllegalArgumentException(
                                    "非法转义: \\" + escape);
                        }
                    } else {
                        value.append(c);
                    }
                }
                throw new IllegalArgumentException("字符串未闭合");
            }

            private Object parseNumber() {
                int start = position;
                while (!atEnd()) {
                    char c = text.charAt(position);
                    if ((c >= '0' && c <= '9') || c == '-' || c == '+'
                            || c == '.' || c == 'e' || c == 'E') {
                        position++;
                    } else {
                        break;
                    }
                }
                if (start == position) {
                    throw new IllegalArgumentException(
                            "此处需要 JSON 值（位置 " + position + "）");
                }
                try {
                    return Double.valueOf(text.substring(start, position));
                } catch (NumberFormatException failure) {
                    throw new IllegalArgumentException("数字格式无效", failure);
                }
            }

            private Object literal(String word, Object value) {
                if (text.startsWith(word, position)) {
                    position += word.length();
                    return value;
                }
                throw new IllegalArgumentException(
                        "无法识别的字面量（位置 " + position + "）");
            }

            private void expect(char expected) {
                if (atEnd() || text.charAt(position) != expected) {
                    throw new IllegalArgumentException(
                            "期望 '" + expected + "'（位置 " + position + "）");
                }
                position++;
            }

            void skipWhitespace() {
                while (!atEnd()
                        && Character.isWhitespace(text.charAt(position))) {
                    position++;
                }
            }

            boolean atEnd() {
                return position >= text.length();
            }
        }
    }
}
