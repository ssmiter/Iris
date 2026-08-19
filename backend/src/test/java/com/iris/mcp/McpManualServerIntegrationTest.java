package com.iris.mcp;

import com.fasterxml.jackson.databind.ObjectMapper;
import com.iris.tools.core.CommittedOperation;
import com.iris.tools.core.ToolContext;
import com.iris.tools.core.ToolOutcome;
import com.iris.tools.core.ToolRegistry;
import org.junit.jupiter.api.MethodOrderer;
import org.junit.jupiter.api.Order;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.TestMethodOrder;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.test.context.DynamicPropertyRegistry;
import org.springframework.test.context.DynamicPropertySource;

import java.io.IOException;
import java.lang.reflect.Field;
import java.nio.file.Files;
import java.nio.file.Path;
import java.time.Instant;
import java.util.List;
import java.util.Locale;
import java.util.Map;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

/**
 * 管理页手工 MCP 连接器全链路（docs/34 M8b）：支持 streamable_http 与 stdio，
 * 可验证/持久化/调用；断线后 execute 自动重连一次，失败再返回 mcp_not_connected。
 */
@SpringBootTest
@TestMethodOrder(MethodOrderer.OrderAnnotation.class)
class McpManualServerIntegrationTest {

    private static final Path DATABASE = Path.of(
            "target", "test-data", "mcp-manual.db"
    ).toAbsolutePath();
    private static final Path WORKSPACE = Path.of(
            "target", "test-mcp-manual-workspace"
    ).toAbsolutePath();

    private static final String FIXTURE_SOURCE = """
            import java.io.BufferedReader;
            import java.io.BufferedWriter;
            import java.io.InputStreamReader;
            import java.io.OutputStreamWriter;
            import java.nio.charset.StandardCharsets;

            public class EchoMcpServer {
                public static void main(String[] args) throws Exception {
                    BufferedReader in = new BufferedReader(new InputStreamReader(
                            System.in, StandardCharsets.UTF_8));
                    BufferedWriter out = new BufferedWriter(new OutputStreamWriter(
                            System.out, StandardCharsets.UTF_8));
                    String line;
                    while ((line = in.readLine()) != null) {
                        String method = method(line);
                        Long id = id(line);
                        if (method == null || id == null) {
                            continue;
                        }
                        String result = switch (method) {
                            case "initialize" -> json(
                                    "{'protocolVersion':'2025-06-18',"
                                    + "'capabilities':{},'serverInfo':{"
                                    + "'name':'echo-fixture','version':'1.0'}}");
                            case "tools/list" -> json(
                                    "{'tools':[{'name':'echo',"
                                    + "'description':'回显输入文本',"
                                    + "'inputSchema':{'type':'object',"
                                    + "'properties':{'text':{'type':'string',"
                                    + "'description':'要回显的文本'}}},"
                                    + "'annotations':{'readOnlyHint':true}}]}");
                            case "tools/call" -> json(
                                    "{'content':[{'type':'text','text':'pong'}],"
                                    + "'isError':false}");
                            default -> null;
                        };
                        if (result == null) {
                            out.write(json("{'jsonrpc':'2.0','id':" + id
                                    + ",'error':{'code':-32601,"
                                    + "'message':'unknown method'}}"));
                        } else {
                            out.write(json("{'jsonrpc':'2.0','id':" + id
                                    + ",'result':") + result + "}");
                        }
                        out.newLine();
                        out.flush();
                    }
                }

                private static String method(String line) {
                    String key = "\\"method\\":\\"";
                    int i = line.indexOf(key);
                    if (i < 0) {
                        return null;
                    }
                    i += key.length();
                    int j = line.indexOf('"', i);
                    return j < 0 ? null : line.substring(i, j);
                }

                private static Long id(String line) {
                    String key = "\\"id\\":";
                    int i = line.indexOf(key);
                    if (i < 0) {
                        return null;
                    }
                    i += key.length();
                    while (i < line.length() && line.charAt(i) == ' ') {
                        i++;
                    }
                    int j = i;
                    while (j < line.length()
                            && Character.isDigit(line.charAt(j))) {
                        j++;
                    }
                    return j > i ? Long.parseLong(line.substring(i, j)) : null;
                }

                private static String json(String text) {
                    return text.replace('\\'', '"');
                }
            }
            """;

    @Autowired
    private McpServerService mcpServers;

    @Autowired
    private ToolRegistry toolRegistry;

    @Autowired
    private JdbcTemplate jdbc;

    @Autowired
    private ObjectMapper objectMapper;

    @DynamicPropertySource
    static void testProperties(DynamicPropertyRegistry registry)
            throws IOException {
        Files.createDirectories(DATABASE.getParent());
        Files.deleteIfExists(DATABASE);
        Files.deleteIfExists(Path.of(DATABASE + "-wal"));
        Files.deleteIfExists(Path.of(DATABASE + "-shm"));
        Files.createDirectories(WORKSPACE);

        registry.add(
                "spring.datasource.url",
                () -> "jdbc:sqlite:" + DATABASE.toString().replace('\\', '/')
        );
        registry.add("iris.workspace", WORKSPACE::toString);
    }

    @Test
    @Order(1)
    void manualStdioServerConnectsAndRegistersNamespacedTools()
            throws Exception {
        Path fixture = WORKSPACE.resolve("EchoMcpServer.java");
        Files.writeString(fixture, FIXTURE_SOURCE);
        String javaBin = Path.of(System.getProperty("java.home"), "bin",
                isWindows() ? "java.exe" : "java").toString();

        McpServerService.ServerView server = mcpServers.create(
                new McpServerService.ServerDraft(
                        "manual_echo", "手工回显服务器",
                        "stdio", null, null,
                        javaBin, List.of(fixture.toString()), List.of(),
                        true
                )
        );

        assertThat(server.transport()).isEqualTo("stdio");
        assertThat(server.endpoint()).isEqualTo("stdio://manual_echo");
        assertThat(server.command()).isEqualTo(javaBin);
        assertThat(server.args()).containsExactly(fixture.toString());

        // 创建即刷新，但等异步 discovery 落库收敛
        McpServerService.ServerView connected = awaitConnected(
                server.serverId(), "mcp__manual_echo__echo");
        assertThat(connected.connectionState()).isEqualTo("connected");
        assertThat(connected.remoteServerName()).isEqualTo("echo-fixture");

        // stdio 配置持久化到既有 mcp_server_stdio 表
        String persistedCommand = jdbc.queryForObject(
                "SELECT command_json FROM mcp_server_stdio WHERE server_id = ?",
                String.class, server.serverId()
        );
        List<String> parsedCommand = objectMapper.readValue(
                persistedCommand, objectMapper.getTypeFactory()
                        .constructCollectionType(List.class, String.class)
        );
        assertThat(parsedCommand).startsWith(javaBin);

        var binding = toolRegistry.find("mcp__manual_echo__echo");
        assertThat(binding).isPresent();

        ToolOutcome outcome = binding.get().tool().execute(
                new CommittedOperation(
                        "exec-mcp-manual-1", "snap-1", "hash-1",
                        objectMapper.createObjectNode().put("text", "hi"),
                        List.of()
                ),
                new TestToolContext()
        );
        assertThat(outcome.kind()).isEqualTo(ToolOutcome.Kind.SUCCEEDED);
        assertThat(outcome.output().path("content").get(0)
                .path("text").asText()).isEqualTo("pong");
    }

    @Test
    @Order(2)
    void duplicateSlugIsRejected() {
        assertThat(jdbc.queryForObject(
                "SELECT COUNT(*) FROM mcp_server WHERE slug = ?",
                Integer.class, "manual_echo"
        )).isEqualTo(1);

        assertThatThrownBy(() -> mcpServers.create(new McpServerService.ServerDraft(
                "manual_echo", "同名冲突",
                "streamable_http", "http://127.0.0.1:9/mcp",
                null, null, null, null, false
        ))).isInstanceOf(org.springframework.dao.DataAccessException.class);

        assertThat(jdbc.queryForObject(
                "SELECT display_name FROM mcp_server WHERE slug = ?",
                String.class, "manual_echo"
        )).isEqualTo("手工回显服务器");
    }

    @Test
    @Order(3)
    void executeReconnectsOnceWhenDisconnected() throws Exception {
        McpServerService.ServerView server = mcpServers.list().stream()
                .filter(view -> view.slug().equals("manual_echo"))
                .findFirst()
                .orElseThrow();

        // 模拟连接丢失：直接从 live map 摘除，但不改库
        evictLiveConnection(server.serverId());
        assertThat(toolRegistry.find("mcp__manual_echo__echo")).isPresent();

        var binding = toolRegistry.find("mcp__manual_echo__echo").orElseThrow();
        ToolOutcome outcome = binding.tool().execute(
                new CommittedOperation(
                        "exec-mcp-manual-2", "snap-2", "hash-2",
                        objectMapper.createObjectNode().put("text", "reconnect"),
                        List.of()
                ),
                new TestToolContext()
        );
        assertThat(outcome.kind()).isEqualTo(ToolOutcome.Kind.SUCCEEDED);
        assertThat(outcome.output().path("content").get(0)
                .path("text").asText()).isEqualTo("pong");
    }

    @Test
    @Order(4)
    void executeReturnsNotConnectedAfterOneFailedReconnect() throws Exception {
        McpServerService.ServerView server = mcpServers.list().stream()
                .filter(view -> view.slug().equals("manual_echo"))
                .findFirst()
                .orElseThrow();

        // 先拿到有效连接上的 tool 引用
        ToolRegistry.ToolBinding binding = toolRegistry
                .find("mcp__manual_echo__echo")
                .orElseThrow();

        // 把配置改成不可执行命令：update 会卸载旧连接并尝试刷新，必然失败
        mcpServers.update(
                server.serverId(),
                server.version(),
                new McpServerService.ServerDraft(
                        server.slug(), server.displayName(),
                        "stdio", null, null,
                        "__nonexistent_executable_for_test__",
                        List.of(), List.of(), true
                )
        );

        // update 失败后 live 为空，且注册表已卸载工具；但我们仍持有旧 tool 引用
        assertThat(toolRegistry.find("mcp__manual_echo__echo")).isEmpty();

        ToolOutcome outcome = binding.tool().execute(
                new CommittedOperation(
                        "exec-mcp-dead", "snap-dead", "hash-dead",
                        objectMapper.createObjectNode().put("text", "dead"),
                        List.of()
                ),
                new TestToolContext()
        );
        assertThat(outcome.kind()).isEqualTo(ToolOutcome.Kind.FAILED);
        assertThat(outcome.errorCode()).isEqualTo("mcp_not_connected");
    }

    private McpServerService.ServerView awaitConnected(
            String serverId,
            String expectedTool
    ) throws InterruptedException {
        for (int attempt = 0; attempt < 150; attempt++) {
            McpServerService.ServerView view = mcpServers.require(serverId);
            if ("connected".equals(view.connectionState())
                    && toolRegistry.find(expectedTool).isPresent()) {
                return view;
            }
            Thread.sleep(200);
        }
        throw new AssertionError("MCP server did not connect: " + serverId);
    }

    @SuppressWarnings("unchecked")
    private void evictLiveConnection(String serverId) throws Exception {
        Field liveField = McpServerService.class.getDeclaredField("live");
        liveField.setAccessible(true);
        Map<String, ?> live = (Map<String, ?>) liveField.get(mcpServers);
        Object connection = live.remove(serverId);
        if (connection instanceof AutoCloseable closeable) {
            closeable.close();
        }
    }

    private static boolean isWindows() {
        return System.getProperty("os.name")
                .toLowerCase(Locale.ROOT).contains("win");
    }

    private record TestToolContext() implements ToolContext {
        @Override
        public String conversationId() {
            return "conv-mcp-manual-test";
        }

        @Override
        public String turnId() {
            return "turn-mcp-manual-test";
        }

        @Override
        public String runId() {
            return "run-mcp-manual-test";
        }

        @Override
        public String roundId() {
            return "round-mcp-manual-test";
        }

        @Override
        public Path workspaceRoot() {
            return WORKSPACE;
        }

        @Override
        public boolean cancelled() {
            return false;
        }
    }
}
