package com.iris.mcp;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;

import java.io.IOException;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.List;
import java.util.Locale;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

/**
 * MCP stdio 客户端的真实进程回路（docs/31 §5.3）：换行分隔 JSON-RPC、
 * initialize 握手、tools/list 分页、tools/call 参数透传、进程死后的
 * fail-fast。fixture 是自包含的单文件 Java 服务器（产品已有 java 运行时）。
 */
class McpStdioClientTest {

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
                            continue; // 通知或无 id：不应答
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
                                    + "'isError':false,'echoed':"
                                    + arguments(line) + "}");
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

                private static String arguments(String line) {
                    String key = "\\"arguments\\":";
                    int i = line.indexOf(key);
                    if (i < 0) {
                        return "{}";
                    }
                    // 尾部是 arguments}params}envelope} 三层括号，取倒数第二层
                    int end = line.lastIndexOf('}');
                    end = line.lastIndexOf('}', end - 1);
                    return end > i + key.length()
                            ? line.substring(i + key.length(), end) : "{}";
                }

                private static String json(String text) {
                    return text.replace('\\'', '"');
                }
            }
            """;

    private final ObjectMapper objectMapper = new ObjectMapper();
    private final McpStdioClient client = new McpStdioClient(objectMapper);

    @TempDir
    private Path fixtureDir;

    private List<String> command;

    @BeforeEach
    void writeFixture() throws IOException {
        Path source = fixtureDir.resolve("EchoMcpServer.java");
        Files.writeString(source, FIXTURE_SOURCE);
        String javaBin = Path.of(System.getProperty("java.home"), "bin",
                isWindows() ? "java.exe" : "java").toString();
        command = List.of(javaBin, source.toString());
    }

    @Test
    void connectPerformsHandshakeAndDiscoversTools() throws Exception {
        try (McpStdioClient.Connection connection =
                     client.connect("echo_fixture", command, List.of())) {
            assertThat(connection.discovery().serverName())
                    .isEqualTo("echo-fixture");
            assertThat(connection.discovery().serverVersion()).isEqualTo("1.0");
            assertThat(connection.discovery().protocolVersion())
                    .isEqualTo("2025-06-18");
            assertThat(connection.discovery().tools()).hasSize(1);
            JsonNode tool = connection.discovery().tools().get(0);
            assertThat(tool.path("name").asText()).isEqualTo("echo");
            assertThat(tool.path("annotations")
                    .path("readOnlyHint").asBoolean()).isTrue();
        }
    }

    @Test
    void callRoundTripsArgumentsOverStdio() throws Exception {
        try (McpStdioClient.Connection connection =
                     client.connect("echo_fixture", command, List.of())) {
            JsonNode result = connection.call(
                    "echo",
                    objectMapper.createObjectNode().put("text", "hello")
            );
            assertThat(result.path("isError").asBoolean()).isFalse();
            assertThat(result.path("content").get(0)
                    .path("text").asText()).isEqualTo("pong");
            assertThat(result.path("echoed").path("text").asText())
                    .isEqualTo("hello");
        }
    }

    @Test
    void closedProcessFailsFastInsteadOfHanging() throws Exception {
        McpStdioClient.Connection connection =
                client.connect("echo_fixture", command, List.of());
        connection.close();
        assertThatThrownBy(() -> connection.call(
                "echo", objectMapper.createObjectNode()))
                .isInstanceOf(McpHttpClient.McpProtocolException.class)
                .hasMessageContaining("进程");
    }

    private static boolean isWindows() {
        return System.getProperty("os.name")
                .toLowerCase(Locale.ROOT).contains("win");
    }
}
