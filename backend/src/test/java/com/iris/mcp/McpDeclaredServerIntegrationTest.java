package com.iris.mcp;

import com.fasterxml.jackson.databind.ObjectMapper;
import com.iris.extension.McpServerDeclaration;
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
import java.nio.file.Files;
import java.nio.file.Path;
import java.time.Instant;
import java.util.List;
import java.util.Locale;

import static org.assertj.core.api.Assertions.assertThat;

/**
 * {@code *.mcp.yml} 声明全链路（docs/31 §5.3）：拓展根扫描 → 落库（来源记到
 * mcp_server_origin）→ stdio 拉起 → 工具以 mcp__&lt;server&gt;__&lt;tool&gt;
 * 入注册表并可真实调用；与手工连接器冲突 fail-closed；根卸载即停用。
 */
@SpringBootTest
@TestMethodOrder(MethodOrderer.OrderAnnotation.class)
class McpDeclaredServerIntegrationTest {

    private static final Path DATABASE = Path.of(
            "target", "test-data", "mcp-declared.db"
    ).toAbsolutePath();
    private static final Path WORKSPACE = Path.of(
            "target", "test-mcp-workspace"
    ).toAbsolutePath();
    private static final Path EXTENSION_ROOT = Path.of(
            "target", "test-mcp-extensions"
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

        Path mcpDir = EXTENSION_ROOT.resolve("mcp");
        Files.createDirectories(mcpDir);
        Path fixture = mcpDir.resolve("EchoMcpServer.java");
        Files.writeString(fixture, FIXTURE_SOURCE);
        String javaBin = Path.of(System.getProperty("java.home"), "bin",
                isWindows() ? "java.exe" : "java").toString();
        Files.writeString(
                mcpDir.resolve("echo-fixture.mcp.yml"),
                """
                slug: echo_fixture
                display_name: 回显测试服务器
                transport: stdio
                command: ["%s", "%s"]
                enabled: true
                """.formatted(
                        javaBin.replace('\\', '/'),
                        fixture.toString().replace('\\', '/')
                )
        );

        registry.add(
                "spring.datasource.url",
                () -> "jdbc:sqlite:" + DATABASE.toString().replace('\\', '/')
        );
        registry.add("iris.workspace", WORKSPACE::toString);
        registry.add(
                "iris.extension.roots[0]",
                () -> EXTENSION_ROOT.toString()
        );
    }

    @Test
    @Order(1)
    void declaredStdioServerConnectsAndRegistersNamespacedTools()
            throws Exception {
        // 声明落库后即同步连接；ApplicationReadyEvent 还会异步重连一轮，
        // 这里等它收敛到 connected，避免断言撞上 connecting 中间态。
        McpServerService.ServerView server = null;
        for (int attempt = 0; attempt < 150; attempt++) {
            server = mcpServers.list().stream()
                    .filter(view -> view.slug().equals("echo_fixture"))
                    .findFirst()
                    .orElse(null);
            if (server != null
                    && "connected".equals(server.connectionState())
                    && toolRegistry.find("mcp__echo_fixture__echo").isPresent()) {
                break;
            }
            Thread.sleep(200);
        }
        assertThat(server).as("声明的连接器未落库").isNotNull();
        assertThat(server.connectionState())
                .as("声明落库即连接: %s", server.lastError())
                .isEqualTo("connected");
        assertThat(server.transport()).isEqualTo("stdio");
        assertThat(server.remoteServerName()).isEqualTo("echo-fixture");

        // mcp__ 命名空间（docs/31 §5.3，与 Claude Code / dsh 同形）
        var binding = toolRegistry.find("mcp__echo_fixture__echo");
        assertThat(binding).isPresent();
        assertThat(binding.get().capabilityPath())
                .isEqualTo("/connectors/mcp/echo_fixture/echo");

        // 来源记录
        String origin = jdbc.queryForObject(
                "SELECT extension_root FROM mcp_server_origin WHERE server_id = ?",
                String.class, server.serverId()
        );
        assertThat(origin).isEqualTo(
                EXTENSION_ROOT.toAbsolutePath().normalize().toString()
        );

        // 真实调用：经 stdio 进程回路
        ToolOutcome outcome = binding.get().tool().execute(
                new CommittedOperation(
                        "exec-mcp-1", "snap-1", "hash-1",
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
    void declarationConflictingWithManualServerIsRejectedFailClosed() {
        McpServerService.ServerView manual = mcpServers.create(
                new McpServerService.ServerDraft(
                        "taken_slug", "手工连接器",
                        "http://127.0.0.1:9/mcp", null, false
                )
        );
        String warning = mcpServers.upsertDeclared(
                new McpServerDeclaration(
                        "taken_slug", "声明来的同名连接器", "stdio",
                        List.of("java", "-version"), null,
                        null, null, true
                ),
                EXTENSION_ROOT.toAbsolutePath().normalize().toString(),
                "test/taken.mcp.yml"
        );
        assertThat(warning).isNotNull().contains("冲突");
        // 既有连接器原样保留
        McpServerService.ServerView kept = mcpServers.require(manual.serverId());
        assertThat(kept.displayName()).isEqualTo("手工连接器");
        assertThat(kept.transport()).isEqualTo("streamable_http");
        assertThat(jdbc.queryForObject(
                "SELECT COUNT(*) FROM mcp_server_origin WHERE server_id = ?",
                Integer.class, manual.serverId()
        )).isZero();
    }

    @Test
    @Order(3)
    void removingRootDisablesItsDeclaredServers() {
        McpServerService.ServerView server = mcpServers.list().stream()
                .filter(view -> view.slug().equals("echo_fixture"))
                .findFirst()
                .orElseThrow();
        mcpServers.disableDeclaredByRoot(
                EXTENSION_ROOT.toAbsolutePath().normalize().toString()
        );
        McpServerService.ServerView disabled =
                mcpServers.require(server.serverId());
        assertThat(disabled.enabled()).isFalse();
        assertThat(disabled.connectionState()).isEqualTo("disabled");
        assertThat(toolRegistry.find("mcp__echo_fixture__echo")).isEmpty();

        // 恢复，避免影响共享上下文里的其他测试
        mcpServers.setEnabled(server.serverId(), disabled.version(), true);
        assertThat(toolRegistry.find("mcp__echo_fixture__echo")).isPresent();
    }

    private static boolean isWindows() {
        return System.getProperty("os.name")
                .toLowerCase(Locale.ROOT).contains("win");
    }

    private record TestToolContext() implements ToolContext {
        @Override
        public String conversationId() {
            return "conv-mcp-test";
        }

        @Override
        public String turnId() {
            return "turn-mcp-test";
        }

        @Override
        public String runId() {
            return "run-mcp-test";
        }

        @Override
        public String roundId() {
            return "round-mcp-test";
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
