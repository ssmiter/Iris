package com.iris.extension;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.node.ObjectNode;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;

import java.io.BufferedReader;
import java.io.BufferedWriter;
import java.io.IOException;
import java.io.InputStreamReader;
import java.io.OutputStreamWriter;
import java.nio.charset.StandardCharsets;
import java.nio.file.Path;
import java.time.Duration;
import java.time.Instant;
import java.util.ArrayList;
import java.util.List;
import java.util.Map;
import java.util.concurrent.BlockingQueue;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.LinkedBlockingQueue;
import java.util.concurrent.TimeUnit;
import java.util.function.BooleanSupplier;

/**
 * 一个常驻插件进程（docs/31 §4）：stdin/stdout NDJSON 一帧一行，
 * 惰性拉起、崩溃后在本次调用内重启一次、取消三层（cancel 帧 →
 * 200ms → SIGTERM → SIGKILL）、禁用/卸载时随最后一个在途引用回收。
 *
 * <p>调用以 callId 多路复用；读线程按 callId 分帧。进程崩溃时所有
 * 在途调用收到毒丸帧，由 {@link ResidentProcessTool} 决定重试一次。</p>
 */
final class ResidentPluginProcess {

    private static final Logger log =
            LoggerFactory.getLogger(ResidentPluginProcess.class);
    private static final String POISON_TYPE = "__process_dead__";
    private static final Duration GRACE_AFTER_CANCEL_FRAME =
            Duration.ofMillis(200);
    private static final Duration SIGTERM_GRACE = Duration.ofSeconds(2);

    private final Object lifecycleLock = new Object();
    private final ConcurrentHashMap<String, BlockingQueue<ObjectNode>> framesByCall =
            new ConcurrentHashMap<>();
    private final List<String> argv;
    private final Path pluginDir;
    private final Map<String, String> declaredEnv;
    private final ObjectMapper objectMapper;

    private Process process;
    private BufferedWriter stdin;
    private boolean retired;
    private int inFlight;

    ResidentPluginProcess(
            List<String> argv,
            Path pluginDir,
            Map<String, String> declaredEnv,
            ObjectMapper objectMapper
    ) {
        this.argv = List.copyOf(argv);
        this.pluginDir = pluginDir;
        this.declaredEnv = Map.copyOf(declaredEnv);
        this.objectMapper = objectMapper;
    }

    /** 进入一次调用；返回的句柄必须 {@link #release()}。 */
    boolean acquire() {
        synchronized (lifecycleLock) {
            if (retired) {
                return false;
            }
            inFlight++;
            return true;
        }
    }

    void release() {
        boolean destroyNow;
        synchronized (lifecycleLock) {
            inFlight--;
            destroyNow = retired && inFlight <= 0;
        }
        if (destroyNow) {
            destroy();
        }
    }

    /** 标记回收：不再接受新调用，最后一个在途引用退出时销毁进程。 */
    void retire() {
        boolean destroyNow;
        synchronized (lifecycleLock) {
            retired = true;
            destroyNow = inFlight <= 0;
        }
        if (destroyNow) {
            destroy();
        }
    }

    /**
     * 发送 invoke 帧并等待 result 帧，沿途收集 progress 文本。
     * 超时或取消走取消三层。进程崩溃抛 {@link ProcessDiedException}
     * （调用方决定是否重启重试一次）。
     */
    InvokeOutcome invoke(
            String callId,
            JsonNode input,
            Path workspaceRoot,
            Duration timeout,
            BooleanSupplier cancelled
    ) throws IOException, InterruptedException, CallCancelledException {
        ensureStarted();
        BlockingQueue<ObjectNode> frames = new LinkedBlockingQueue<>();
        framesByCall.put(callId, frames);
        List<String> progress = new ArrayList<>();
        Instant deadline = Instant.now().plus(timeout);
        try {
            ObjectNode invoke = objectMapper.createObjectNode();
            invoke.put("type", "invoke");
            invoke.put("callId", callId);
            invoke.set("input", input);
            ObjectNode context = invoke.putObject("context");
            context.put("workspace",
                    workspaceRoot.toAbsolutePath().toString());
            ObjectNode env = context.putObject("env");
            declaredEnv.forEach(env::put);
            writeFrame(invoke);

            while (true) {
                if (cancelled.getAsBoolean()
                        || Instant.now().isAfter(deadline)) {
                    cancelLadder(callId);
                    throw new CallCancelledException();
                }
                ObjectNode frame = frames.poll(50, TimeUnit.MILLISECONDS);
                if (frame == null) {
                    continue;
                }
                String type = frame.path("type").asText("");
                if (POISON_TYPE.equals(type)) {
                    throw new ProcessDiedException(
                            frame.path("reason").asText("进程退出"));
                }
                if ("progress".equals(type)) {
                    String text = frame.path("text").asText(null);
                    if (text != null) {
                        progress.add(text);
                    }
                    continue;
                }
                if ("result".equals(type)) {
                    return new InvokeOutcome(frame, List.copyOf(progress));
                }
                log.warn("extension plugin {} sent unknown frame type {}",
                        pluginDir, type);
            }
        } finally {
            framesByCall.remove(callId);
        }
    }

    /** 一次调用的归宿：result 帧全文 + 依序收集的 progress 文本。 */
    record InvokeOutcome(ObjectNode result, List<String> progress) {
    }

    private void ensureStarted() throws IOException {
        synchronized (lifecycleLock) {
            if (process != null && process.isAlive()) {
                return;
            }
            ProcessBuilder builder = new ProcessBuilder(argv);
            builder.directory(pluginDir.toFile());
            builder.redirectErrorStream(false);
            declaredEnv.forEach(builder.environment()::put);
            process = builder.start();
            stdin = new BufferedWriter(new OutputStreamWriter(
                    process.getOutputStream(), StandardCharsets.UTF_8));
            BufferedReader stdout = new BufferedReader(new InputStreamReader(
                    process.getInputStream(), StandardCharsets.UTF_8));
            BufferedReader stderr = new BufferedReader(new InputStreamReader(
                    process.getErrorStream(), StandardCharsets.UTF_8));
            Process watched = process;
            Thread.ofVirtual()
                    .name("extension-plugin-reader-" + pluginDir.getFileName())
                    .start(() -> readLoop(watched, stdout));
            // stderr 必须排空，否则管道缓冲写满会堵死插件（claude-code 同形处理）。
            Thread.ofVirtual()
                    .name("extension-plugin-stderr-" + pluginDir.getFileName())
                    .start(() -> drainStderr(watched, stderr));
        }
    }

    private void readLoop(Process watched, BufferedReader stdout) {
        String line;
        try {
            while ((line = stdout.readLine()) != null) {
                ObjectNode frame;
                try {
                    JsonNode parsed = objectMapper.readTree(line);
                    frame = parsed instanceof ObjectNode object ? object : null;
                } catch (Exception parseFailure) {
                    log.warn("extension plugin {} emitted non-JSON line: {}",
                            pluginDir,
                            line.length() > 200
                                    ? line.substring(0, 200) : line);
                    continue;
                }
                if (frame == null) {
                    continue;
                }
                String callId = frame.path("callId").asText(null);
                BlockingQueue<ObjectNode> queue = callId == null
                        ? null : framesByCall.get(callId);
                if (queue != null) {
                    queue.offer(frame);
                } else {
                    log.warn("extension plugin {} frame for unknown callId {}",
                            pluginDir, callId);
                }
            }
        } catch (IOException readFailure) {
            if (watched.isAlive()) {
                log.warn("extension plugin {} stdout read failed: {}",
                        pluginDir, readFailure.getMessage());
            }
        }
        // EOF 或读失败 = 进程不可用：毒丸所有在途调用。
        ObjectNode poison = objectMapper.createObjectNode();
        poison.put("type", POISON_TYPE);
        poison.put("reason", "插件进程结束或 stdout 不可读");
        for (BlockingQueue<ObjectNode> queue : framesByCall.values()) {
            queue.offer(poison);
        }
        synchronized (lifecycleLock) {
            if (process == watched) {
                process = null;
                stdin = null;
            }
        }
    }

    /** stderr 只进日志，不进协议通道；截断单行避免刷屏。 */
    private void drainStderr(Process watched, BufferedReader stderr) {
        try {
            String line;
            while ((line = stderr.readLine()) != null) {
                log.debug("extension plugin {} stderr: {}", pluginDir,
                        line.length() > 500 ? line.substring(0, 500) : line);
            }
        } catch (IOException ignored) {
            // 进程结束即管道关闭，正常。
        }
    }

    /** 取消三层：cancel 帧 → 200ms → destroy（SIGTERM）→ 2s → destroyForcibly。 */
    private void cancelLadder(String callId) {
        try {
            ObjectNode cancel = objectMapper.createObjectNode();
            cancel.put("type", "cancel");
            cancel.put("callId", callId);
            writeFrame(cancel);
            Thread.sleep(GRACE_AFTER_CANCEL_FRAME.toMillis());
        } catch (IOException | InterruptedException ignored) {
            if (ignored instanceof InterruptedException) {
                Thread.currentThread().interrupt();
            }
        }
        Process snapshot;
        synchronized (lifecycleLock) {
            snapshot = process;
        }
        if (snapshot == null || !snapshot.isAlive()) {
            return;
        }
        snapshot.destroy();
        try {
            if (!snapshot.waitFor(
                    SIGTERM_GRACE.toMillis(), TimeUnit.MILLISECONDS)) {
                snapshot.destroyForcibly();
            }
        } catch (InterruptedException interrupted) {
            Thread.currentThread().interrupt();
            snapshot.destroyForcibly();
        }
    }

    private void writeFrame(ObjectNode frame) throws IOException {
        BufferedWriter target;
        synchronized (lifecycleLock) {
            if (stdin == null || process == null || !process.isAlive()) {
                throw new ProcessDiedException("插件进程未在运行");
            }
            target = stdin;
        }
        synchronized (target) {
            target.write(objectMapper.writeValueAsString(frame));
            target.newLine();
            target.flush();
        }
    }

    private void destroy() {
        Process snapshot;
        synchronized (lifecycleLock) {
            snapshot = process;
            process = null;
            stdin = null;
        }
        if (snapshot != null) {
            snapshot.destroy();
            try {
                if (!snapshot.waitFor(2, TimeUnit.SECONDS)) {
                    snapshot.destroyForcibly();
                }
            } catch (InterruptedException interrupted) {
                Thread.currentThread().interrupt();
                snapshot.destroyForcibly();
            }
        }
    }

    /** 进程在结果帧之前死亡/不可用；调用方可重启一次重试。 */
    static final class ProcessDiedException extends IOException {
        ProcessDiedException(String reason) {
            super(reason);
        }
    }

    /** 超时或取消信号触发，取消三层已执行。 */
    static final class CallCancelledException extends Exception {
    }
}
