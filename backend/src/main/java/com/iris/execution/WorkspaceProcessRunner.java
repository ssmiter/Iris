package com.iris.execution;

import com.iris.tools.core.ToolRuntimeException;
import com.iris.workspace.WorkspacePathGuard;
import org.springframework.stereotype.Component;

import java.io.ByteArrayOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.nio.charset.Charset;
import java.nio.charset.StandardCharsets;
import java.nio.file.Path;
import java.time.Duration;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.List;
import java.util.Map;
import java.util.Objects;
import java.util.OptionalInt;
import java.util.concurrent.ExecutionException;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.Future;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.TimeoutException;
import java.util.function.BooleanSupplier;

/**
 * 在工作区围栏内运行一个本地进程。
 *
 * 这是可信执行的生命周期内核，不是安全沙箱，也不直接注册为模型 Tool。
 * 调用方必须用 argv 表达命令；需要 shell 语义时，由更上层能力显式选择并审查 shell。
 */
@Component
public class WorkspaceProcessRunner {

    private static final Duration MAX_TIMEOUT = Duration.ofMinutes(30);
    private static final Duration TERMINATION_GRACE = Duration.ofSeconds(2);
    private static final int STREAM_BUFFER_BYTES = 16 * 1024;
    private static final int MIN_CAPTURE_BYTES = 1_024;
    private static final int MAX_CAPTURE_BYTES = 1_048_576;

    private final WorkspacePathGuard pathGuard;

    public WorkspaceProcessRunner(WorkspacePathGuard pathGuard) {
        this.pathGuard = pathGuard;
    }

    public Result run(
            Path workspaceRoot,
            Request request,
            BooleanSupplier cancelled,
            OutputListener outputListener
    ) throws IOException, InterruptedException {
        Objects.requireNonNull(request, "request");
        BooleanSupplier liveCancellation = cancelled == null
                ? () -> false
                : cancelled;
        OutputListener listener = outputListener == null
                ? OutputListener.ignoring()
                : outputListener;
        WorkspacePathGuard.ResolvedPath workingDirectory =
                pathGuard.resolveExistingDirectory(
                        workspaceRoot,
                        request.workingDirectory()
                );

        ProcessBuilder builder = new ProcessBuilder(request.command());
        builder.directory(workingDirectory.physicalPath().toFile());
        configureEnvironment(builder, request);
        builder.redirectInput(ProcessBuilder.Redirect.PIPE);

        long startedNanos = System.nanoTime();
        Process process = builder.start();
        process.getOutputStream().close();

        CapturedStream stdout;
        CapturedStream stderr;
        Termination termination;
        OptionalInt exitCode;
        try (ExecutorService streams =
                     Executors.newVirtualThreadPerTaskExecutor()) {
            Future<CapturedStream> stdoutFuture = streams.submit(
                    new StreamCollector(
                            process.getInputStream(),
                            Stream.STDOUT,
                            request.captureBytesPerStream(),
                            request.outputCharset(),
                            listener
                    )
            );
            Future<CapturedStream> stderrFuture = streams.submit(
                    new StreamCollector(
                            process.getErrorStream(),
                            Stream.STDERR,
                            request.captureBytesPerStream(),
                            request.outputCharset(),
                            listener
                    )
            );

            termination = awaitTermination(
                    process,
                    request.timeout(),
                    liveCancellation
            );
            if (termination != Termination.EXITED) {
                terminateTree(process);
            }
            exitCode = process.isAlive()
                    ? OptionalInt.empty()
                    : OptionalInt.of(process.exitValue());
            stdout = finishCapture(
                    stdoutFuture,
                    process.getInputStream(),
                    request.outputCharset()
            );
            stderr = finishCapture(
                    stderrFuture,
                    process.getErrorStream(),
                    request.outputCharset()
            );
        } catch (InterruptedException exception) {
            terminateTree(process);
            Thread.currentThread().interrupt();
            throw exception;
        }

        return new Result(
                workingDirectory.logicalPath(),
                termination,
                exitCode,
                stdout,
                stderr,
                Duration.ofNanos(System.nanoTime() - startedNanos)
        );
    }

    public Result run(
            Path workspaceRoot,
            Request request,
            BooleanSupplier cancelled
    ) throws IOException, InterruptedException {
        return run(
                workspaceRoot,
                request,
                cancelled,
                OutputListener.ignoring()
        );
    }

    private void configureEnvironment(
            ProcessBuilder builder,
            Request request
    ) {
        Map<String, String> environment = builder.environment();
        if (!request.inheritEnvironment()) {
            environment.clear();
        }
        environment.putAll(request.environment());
    }

    private Termination awaitTermination(
            Process process,
            Duration timeout,
            BooleanSupplier cancelled
    ) throws InterruptedException {
        long deadline = System.nanoTime() + timeout.toNanos();
        while (true) {
            if (process.waitFor(50, TimeUnit.MILLISECONDS)) {
                return Termination.EXITED;
            }
            if (cancelled.getAsBoolean()) {
                return Termination.CANCELLED;
            }
            if (System.nanoTime() >= deadline) {
                return Termination.TIMED_OUT;
            }
        }
    }

    private void terminateTree(Process process) throws InterruptedException {
        List<ProcessHandle> descendants = new ArrayList<>(
                process.descendants().toList()
        );
        for (int index = descendants.size() - 1; index >= 0; index--) {
            descendants.get(index).destroy();
        }
        process.destroy();
        if (process.waitFor(
                TERMINATION_GRACE.toMillis(),
                TimeUnit.MILLISECONDS
        )) {
            return;
        }
        for (int index = descendants.size() - 1; index >= 0; index--) {
            ProcessHandle descendant = descendants.get(index);
            if (descendant.isAlive()) {
                descendant.destroyForcibly();
            }
        }
        process.destroyForcibly();
        process.waitFor(
                TERMINATION_GRACE.toMillis(),
                TimeUnit.MILLISECONDS
        );
    }

    private CapturedStream finishCapture(
            Future<CapturedStream> future,
            InputStream stream,
            Charset charset
    ) throws IOException, InterruptedException {
        try {
            return future.get(
                    TERMINATION_GRACE.toMillis(),
                    TimeUnit.MILLISECONDS
            );
        } catch (TimeoutException exception) {
            stream.close();
            future.cancel(true);
            return new CapturedStream(
                    "",
                    0,
                    true,
                    charset.name()
            );
        } catch (ExecutionException exception) {
            Throwable cause = exception.getCause();
            if (cause instanceof IOException ioException) {
                throw ioException;
            }
            throw new IOException("无法读取子进程输出", cause);
        }
    }

    public enum Termination {
        EXITED,
        TIMED_OUT,
        CANCELLED
    }

    public enum Stream {
        STDOUT,
        STDERR
    }

    public record Request(
            List<String> command,
            String workingDirectory,
            Duration timeout,
            int captureBytesPerStream,
            Charset outputCharset,
            boolean inheritEnvironment,
            Map<String, String> environment
    ) {
        public Request {
            if (command == null
                    || command.isEmpty()
                    || command.getFirst() == null
                    || command.getFirst().isBlank()) {
                throw new ToolRuntimeException(
                        "process_command_empty",
                        "进程命令不能为空"
                );
            }
            command = List.copyOf(command);
            for (String argument : command) {
                if (argument == null || argument.indexOf('\0') >= 0) {
                    throw new ToolRuntimeException(
                            "invalid_process_argument",
                            "进程参数不能为 null 或包含 NUL"
                    );
                }
            }
            workingDirectory = workingDirectory == null
                    || workingDirectory.isBlank()
                    ? "."
                    : workingDirectory;
            if (timeout == null
                    || timeout.isZero()
                    || timeout.isNegative()
                    || timeout.compareTo(MAX_TIMEOUT) > 0) {
                throw new ToolRuntimeException(
                        "invalid_process_timeout",
                        "进程超时必须大于 0 且不超过 30 分钟"
                );
            }
            if (captureBytesPerStream < MIN_CAPTURE_BYTES
                    || captureBytesPerStream > MAX_CAPTURE_BYTES) {
                throw new ToolRuntimeException(
                        "invalid_process_output_budget",
                        "单路进程输出留存预算必须在 1KB 到 1MB 之间"
                );
            }
            outputCharset = outputCharset == null
                    ? StandardCharsets.UTF_8
                    : outputCharset;
            environment = environment == null
                    ? Map.of()
                    : Map.copyOf(environment);
            for (Map.Entry<String, String> entry : environment.entrySet()) {
                if (entry.getKey().isBlank()
                        || entry.getKey().indexOf('=') >= 0
                        || entry.getKey().indexOf('\0') >= 0
                        || entry.getValue().indexOf('\0') >= 0) {
                    throw new ToolRuntimeException(
                            "invalid_process_environment",
                            "进程环境变量名称或值无效"
                    );
                }
            }
        }
    }

    public record Result(
            String workingDirectory,
            Termination termination,
            OptionalInt exitCode,
            CapturedStream stdout,
            CapturedStream stderr,
            Duration duration
    ) {
        public boolean succeeded() {
            return termination == Termination.EXITED
                    && exitCode.isPresent()
                    && exitCode.getAsInt() == 0;
        }
    }

    public record CapturedStream(
            String text,
            long totalBytes,
            boolean truncated,
            String charset
    ) {
    }

    @FunctionalInterface
    public interface OutputListener {
        /**
         * stdout 与 stderr 可由不同虚拟线程并发调用；实现必须线程安全。
         */
        void onOutput(Stream stream, byte[] bytes);

        static OutputListener ignoring() {
            return (stream, bytes) -> {
            };
        }
    }

    private static final class StreamCollector
            implements java.util.concurrent.Callable<CapturedStream> {

        private final InputStream input;
        private final Stream stream;
        private final int captureLimit;
        private final Charset charset;
        private final OutputListener listener;

        private StreamCollector(
                InputStream input,
                Stream stream,
                int captureLimit,
                Charset charset,
                OutputListener listener
        ) {
            this.input = input;
            this.stream = stream;
            this.captureLimit = captureLimit;
            this.charset = charset;
            this.listener = listener;
        }

        @Override
        public CapturedStream call() throws IOException {
            byte[] buffer = new byte[STREAM_BUFFER_BYTES];
            ByteArrayOutputStream captured = new ByteArrayOutputStream(
                    Math.min(captureLimit, STREAM_BUFFER_BYTES)
            );
            long totalBytes = 0;
            boolean listenerHealthy = true;
            int read;
            while ((read = input.read(buffer)) != -1) {
                if (read == 0) {
                    continue;
                }
                totalBytes += read;
                if (listenerHealthy) {
                    try {
                        listener.onOutput(
                                stream,
                                Arrays.copyOf(buffer, read)
                        );
                    } catch (RuntimeException ignored) {
                        // 进度投影故障不能阻塞底层管道，仍需把子进程输出排空。
                        listenerHealthy = false;
                    }
                }
                int remaining = captureLimit - captured.size();
                if (remaining > 0) {
                    captured.write(buffer, 0, Math.min(remaining, read));
                }
            }
            return new CapturedStream(
                    captured.toString(charset),
                    totalBytes,
                    totalBytes > captured.size(),
                    charset.name()
            );
        }
    }
}
