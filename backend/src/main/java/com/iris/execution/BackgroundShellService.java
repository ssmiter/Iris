package com.iris.execution;

import com.iris.tools.core.ToolRuntimeException;
import com.iris.workspace.WorkspacePathGuard;
import org.springframework.stereotype.Service;

import java.io.BufferedReader;
import java.io.BufferedWriter;
import java.io.IOException;
import java.io.InputStreamReader;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.time.Duration;
import java.util.ArrayDeque;
import java.util.Deque;
import java.util.Map;
import java.util.UUID;
import java.util.concurrent.CompletableFuture;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.Executors;
import java.util.concurrent.ScheduledExecutorService;
import java.util.concurrent.TimeUnit;

/**
 * 后台命令的最小生命周期管理器。
 *
 * <p>命令本身仍由前端 Runtime 决定是否调用；这里仅负责启动、持久化完整输出、
 * 等待终态和终止进程树。输出文件是交接锚点，后端重启后任务不伪造恢复，文件仍可读。</p>
 */
@Service
public final class BackgroundShellService {
    private static final int TAIL_LINES = 40;
    private static final Duration WAIT_WINDOW = Duration.ofSeconds(45);
    private static final Duration RETAIN_AFTER_EXIT = Duration.ofMinutes(10);

    private final WorkspacePathGuard pathGuard;
    private final Map<String, Task> tasks = new ConcurrentHashMap<>();
    private final ScheduledExecutorService scheduler =
            Executors.newScheduledThreadPool(1, Thread.ofVirtual().factory());

    public BackgroundShellService(WorkspacePathGuard pathGuard) {
        this.pathGuard = pathGuard;
    }

    public Handle start(
            Path workspaceRoot,
            String command,
            String workingDirectory,
            Duration timeout
    ) throws IOException {
        Path cwd = pathGuard.resolveExistingDirectory(
                workspaceRoot,
                workingDirectory == null || workingDirectory.isBlank()
                        ? "." : workingDirectory
        ).physicalPath();
        String taskId = "shell_" + UUID.randomUUID();
        Path output = workspaceRoot.resolve(".iris/commands").resolve(taskId + ".log");
        Files.createDirectories(output.getParent());
        Process process = new ProcessBuilder(
                "powershell.exe", "-NoLogo", "-NoProfile", "-NonInteractive",
                "-Command", command
        ).directory(cwd.toFile()).redirectErrorStream(true).start();
        Task task = new Task(taskId, process, output, cwd);
        tasks.put(taskId, task);
        Thread.startVirtualThread(() -> collect(task));
        scheduler.schedule(() -> stop(taskId), timeout.toMillis(), TimeUnit.MILLISECONDS);
        // 返回物理输出锚点；上层若使用默认工作区，会将它映射成稳定的
        // /workspace/.iris/... 逻辑路径。外部登记根必须保留物理路径，避免
        // 把另一棵目录误报成当前工作区。
        return new Handle(taskId, output.toString().replace('\\', '/'), cwd.toString());
    }

    public Event waitFor(String taskId) {
        Task task = tasks.get(taskId);
        if (task == null) {
            throw new ToolRuntimeException("shell_task_not_found", "后台命令任务不存在：" + taskId);
        }
        try {
            return task.finished.get(WAIT_WINDOW.toMillis(), TimeUnit.MILLISECONDS);
        } catch (java.util.concurrent.TimeoutException timeout) {
            long silentFor = System.currentTimeMillis() - task.lastOutputAt;
            return silentFor >= WAIT_WINDOW.toMillis()
                    ? task.stalledEvent() : Event.heartbeat();
        } catch (InterruptedException interrupted) {
            Thread.currentThread().interrupt();
            throw new ToolRuntimeException("shell_wait_interrupted", "后台命令等待被中断");
        } catch (java.util.concurrent.ExecutionException failure) {
            throw new ToolRuntimeException("shell_task_failed", "后台命令状态读取失败");
        }
    }

    public boolean stop(String taskId) {
        Task task = tasks.get(taskId);
        if (task == null || task.finished.isDone()) return false;
        task.killed = true;
        ProcessHandle handle = task.process.toHandle();
        handle.descendants().forEach(ProcessHandle::destroy);
        handle.destroy();
        return true;
    }

    private void collect(Task task) {
        try (BufferedReader reader = new BufferedReader(new InputStreamReader(
                task.process.getInputStream(), StandardCharsets.UTF_8));
             BufferedWriter writer = Files.newBufferedWriter(
                     task.output, StandardCharsets.UTF_8)) {
            String line;
            while ((line = reader.readLine()) != null) {
                writer.write(line);
                writer.newLine();
                writer.flush();
                task.lastOutputAt = System.currentTimeMillis();
                synchronized (task.tail) {
                    task.tail.addLast(line);
                    while (task.tail.size() > TAIL_LINES) task.tail.removeFirst();
                }
            }
            int exitCode = task.process.waitFor();
            task.finished.complete(task.exitedEvent(exitCode));
        } catch (Exception failure) {
            task.finished.complete(task.exitedEvent(null));
        } finally {
            scheduler.schedule(() -> tasks.remove(task.id, task),
                    RETAIN_AFTER_EXIT.toMillis(), TimeUnit.MILLISECONDS);
        }
    }

    public record Handle(String taskId, String outputPath, String cwd) { }

    public record Event(
            String type,
            Integer exit_code,
            boolean killed,
            String last_line,
            String tail
    ) {
        static Event heartbeat() { return new Event("heartbeat", null, false, null, null); }
    }

    private static final class Task {
        private final String id;
        private final Process process;
        private final Path output;
        private final Path cwd;
        private final CompletableFuture<Event> finished = new CompletableFuture<>();
        private final Deque<String> tail = new ArrayDeque<>();
        private volatile long lastOutputAt = System.currentTimeMillis();
        private volatile boolean killed;

        private Task(String id, Process process, Path output, Path cwd) {
            this.id = id;
            this.process = process;
            this.output = output;
            this.cwd = cwd;
        }

        private Event stalledEvent() {
            synchronized (tail) {
                String last = tail.peekLast();
                return new Event("stalled", null, killed, last, String.join("\n", tail));
            }
        }

        private Event exitedEvent(Integer code) {
            synchronized (tail) {
                String last = tail.peekLast();
                return new Event("exited", code, killed, last, String.join("\n", tail));
            }
        }
    }
}
