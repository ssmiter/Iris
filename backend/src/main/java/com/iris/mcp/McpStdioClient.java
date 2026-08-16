package com.iris.mcp;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.node.ObjectNode;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.stereotype.Component;

import java.io.BufferedReader;
import java.io.BufferedWriter;
import java.io.IOException;
import java.io.InputStreamReader;
import java.io.OutputStreamWriter;
import java.nio.charset.StandardCharsets;
import java.time.Duration;
import java.time.Instant;
import java.util.ArrayList;
import java.util.List;
import java.util.concurrent.BlockingQueue;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.LinkedBlockingQueue;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicLong;

/**
 * MCP stdio 客户端（docs/31 §5.3）：spawn 本地进程，换行分隔 JSON-RPC，
 * stderr 只进日志不进协议——与 Claude Code 的 StdioClientTransport 同形。
 * 一个连接器一个长驻进程，随连接器停用/卸载回收。
 */
@Component
public class McpStdioClient {

    private static final Logger log = LoggerFactory.getLogger(McpStdioClient.class);
    private static final String PROTOCOL_VERSION = "2025-06-18";
    private static final int MAX_TOOL_PAGES = 20;
    private static final Duration REQUEST_TIMEOUT = Duration.ofSeconds(45);

    private final ObjectMapper objectMapper;

    public McpStdioClient(ObjectMapper objectMapper) {
        this.objectMapper = objectMapper;
    }

    /** 拉起进程并完成 initialize 握手 + tools/list。 */
    public Connection connect(
            String serverSlug,
            List<String> command,
            List<String> envNames
    ) throws IOException, InterruptedException {
        ProcessBuilder builder = new ProcessBuilder(command);
        builder.redirectErrorStream(false);
        if (envNames != null) {
            for (String name : envNames) {
                String value = System.getenv(name);
                if (value != null) {
                    builder.environment().put(name, value);
                }
            }
        }
        Process process = builder.start();
        Connection connection = new Connection(serverSlug, process);
        try {
            ObjectNode params = objectMapper.createObjectNode();
            params.put("protocolVersion", PROTOCOL_VERSION);
            params.set("capabilities", objectMapper.createObjectNode());
            ObjectNode clientInfo = params.putObject("clientInfo");
            clientInfo.put("name", "Iris");
            clientInfo.put("version", "0.1.0");
            JsonNode initialized =
                    connection.request("initialize", params);
            String negotiated = initialized.path("protocolVersion")
                    .asText(PROTOCOL_VERSION);
            connection.notify("notifications/initialized");

            List<JsonNode> tools = new ArrayList<>();
            String cursor = null;
            for (int page = 0; page < MAX_TOOL_PAGES; page++) {
                ObjectNode listParams = objectMapper.createObjectNode();
                if (cursor != null && !cursor.isBlank()) {
                    listParams.put("cursor", cursor);
                }
                JsonNode result = connection.request("tools/list", listParams);
                result.path("tools").forEach(tools::add);
                cursor = result.path("nextCursor").asText(null);
                if (cursor == null || cursor.isBlank()) {
                    break;
                }
            }
            JsonNode serverInfo = initialized.path("serverInfo");
            connection.discovery = new McpHttpClient.Discovery(
                    negotiated,
                    serverInfo.path("name").asText(null),
                    serverInfo.path("version").asText(null),
                    initialized.path("instructions").asText(null),
                    null,
                    List.copyOf(tools)
            );
            return connection;
        } catch (Exception failure) {
            connection.close();
            throw failure;
        }
    }

    /** 活连接：调用入口与进程回收。 */
    public final class Connection implements AutoCloseable {

        private final String serverSlug;
        private final Process process;
        private final BufferedWriter stdin;
        private final ConcurrentHashMap<Long, BlockingQueue<ObjectNode>>
                pending = new ConcurrentHashMap<>();
        private final AtomicLong requestIds = new AtomicLong();
        private volatile McpHttpClient.Discovery discovery;

        private Connection(String serverSlug, Process process) {
            this.serverSlug = serverSlug;
            this.process = process;
            this.stdin = new BufferedWriter(new OutputStreamWriter(
                    process.getOutputStream(), StandardCharsets.UTF_8));
            Thread.ofVirtual()
                    .name("mcp-stdio-reader-" + serverSlug)
                    .start(this::readLoop);
            Thread.ofVirtual()
                    .name("mcp-stdio-stderr-" + serverSlug)
                    .start(this::drainStderr);
        }

        public McpHttpClient.Discovery discovery() {
            return discovery;
        }

        public JsonNode call(String remoteToolName, JsonNode arguments)
                throws IOException, InterruptedException {
            ObjectNode params = objectMapper.createObjectNode();
            params.put("name", remoteToolName);
            params.set("arguments",
                    arguments == null || arguments.isNull()
                            ? objectMapper.createObjectNode() : arguments);
            return request("tools/call", params);
        }

        JsonNode request(String method, JsonNode params)
                throws IOException, InterruptedException {
            long id = requestIds.incrementAndGet();
            ObjectNode body = objectMapper.createObjectNode();
            body.put("jsonrpc", "2.0");
            body.put("id", id);
            body.put("method", method);
            body.set("params", params);
            BlockingQueue<ObjectNode> queue = new LinkedBlockingQueue<>();
            pending.put(id, queue);
            try {
                write(body);
                Instant deadline = Instant.now().plus(REQUEST_TIMEOUT);
                while (true) {
                    long remaining =
                            Duration.between(Instant.now(), deadline).toMillis();
                    if (remaining <= 0) {
                        throw new McpHttpClient.McpProtocolException(
                                "mcp_timeout",
                                "MCP stdio server " + serverSlug
                                        + " 未在 45 秒内应答 " + method
                        );
                    }
                    ObjectNode envelope =
                            queue.poll(remaining, TimeUnit.MILLISECONDS);
                    if (envelope == null) {
                        throw new McpHttpClient.McpProtocolException(
                                "mcp_timeout",
                                "MCP stdio server " + serverSlug
                                        + " 未在 45 秒内应答 " + method
                        );
                    }
                    if (envelope.has("__dead__")) {
                        throw new McpHttpClient.McpProtocolException(
                                "mcp_process_died",
                                "MCP stdio server " + serverSlug + " 进程结束"
                        );
                    }
                    if (envelope.has("error")) {
                        JsonNode error = envelope.path("error");
                        throw new McpHttpClient.McpProtocolException(
                                String.valueOf(error.path("code")),
                                error.path("message")
                                        .asText("MCP request failed")
                        );
                    }
                    if (!envelope.has("result")) {
                        throw new McpHttpClient.McpProtocolException(
                                "invalid_response",
                                "MCP response has no result"
                        );
                    }
                    return envelope.path("result");
                }
            } finally {
                pending.remove(id);
            }
        }

        void notify(String method) throws IOException {
            ObjectNode body = objectMapper.createObjectNode();
            body.put("jsonrpc", "2.0");
            body.put("method", method);
            body.set("params", objectMapper.createObjectNode());
            write(body);
        }

        private void write(ObjectNode body) throws IOException {
            if (!process.isAlive()) {
                throw new McpHttpClient.McpProtocolException(
                        "mcp_process_died",
                        "MCP stdio server " + serverSlug + " 进程未在运行"
                );
            }
            synchronized (stdin) {
                stdin.write(objectMapper.writeValueAsString(body));
                stdin.newLine();
                stdin.flush();
            }
        }

        private void readLoop() {
            try (BufferedReader stdout = new BufferedReader(
                    new InputStreamReader(
                            process.getInputStream(), StandardCharsets.UTF_8))) {
                String line;
                while ((line = stdout.readLine()) != null) {
                    JsonNode parsed;
                    try {
                        parsed = objectMapper.readTree(line);
                    } catch (Exception parseFailure) {
                        log.warn("mcp stdio {} non-JSON line: {}", serverSlug,
                                line.length() > 200
                                        ? line.substring(0, 200) : line);
                        continue;
                    }
                    if (!(parsed instanceof ObjectNode envelope)) {
                        continue;
                    }
                    if (!envelope.has("id")) {
                        continue; // 服务器通知：协议允许，当前无消费者
                    }
                    BlockingQueue<ObjectNode> queue = pending.get(
                            envelope.path("id").asLong());
                    if (queue != null) {
                        queue.offer(envelope);
                    }
                }
            } catch (IOException readFailure) {
                if (process.isAlive()) {
                    log.warn("mcp stdio {} read failed: {}",
                            serverSlug, readFailure.getMessage());
                }
            }
            ObjectNode dead = objectMapper.createObjectNode();
            dead.put("__dead__", true);
            pending.values().forEach(queue -> queue.offer(dead));
        }

        private void drainStderr() {
            try (BufferedReader stderr = new BufferedReader(
                    new InputStreamReader(
                            process.getErrorStream(), StandardCharsets.UTF_8))) {
                String line;
                while ((line = stderr.readLine()) != null) {
                    log.debug("mcp stdio {} stderr: {}", serverSlug,
                            line.length() > 500
                                    ? line.substring(0, 500) : line);
                }
            } catch (IOException ignored) {
                // 进程结束即管道关闭，正常。
            }
        }

        @Override
        public void close() {
            process.destroy();
            try {
                if (!process.waitFor(2, TimeUnit.SECONDS)) {
                    process.destroyForcibly();
                }
            } catch (InterruptedException interrupted) {
                Thread.currentThread().interrupt();
                process.destroyForcibly();
            }
        }
    }
}
