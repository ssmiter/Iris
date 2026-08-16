package com.iris.extension;

import com.fasterxml.jackson.databind.ObjectMapper;
import com.iris.tools.core.CommittedOperation;
import com.iris.tools.core.ToolContext;
import com.iris.tools.core.ToolOutcome;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;

import java.nio.file.Files;
import java.nio.file.Path;
import java.util.List;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertTrue;

/**
 * 常驻进程协议（docs/31 §4）端到端：真实 spawn 单文件 Java 插件，
 * 验证 invoke/progress/result 帧、错误帧、崩溃重启一次与回收。
 */
class ResidentProcessToolTest {

    private final ObjectMapper objectMapper = new ObjectMapper();

    @TempDir
    Path workspace;

    @TempDir
    Path pluginDir;

    /** 测试夹具插件：NDJSON 回环，识别 please_fail / crash 指令。 */
    private static final String PROBE_SOURCE = """
            import java.io.*;
            public class Probe {
                public static void main(String[] args) throws Exception {
                    BufferedReader in = new BufferedReader(
                            new InputStreamReader(System.in, "UTF-8"));
                    BufferedWriter out = new BufferedWriter(
                            new OutputStreamWriter(System.out, "UTF-8"));
                    java.util.regex.Pattern callId = java.util.regex.Pattern
                            .compile("\\"callId\\":\\"([^\\"]+)\\"");
                    String line;
                    while ((line = in.readLine()) != null) {
                        var matcher = callId.matcher(line);
                        if (!line.contains("invoke") || !matcher.find()) {
                            continue;
                        }
                        String id = matcher.group(1);
                        if (line.contains("crash")) {
                            System.exit(1);
                        }
                        if (line.contains("please_fail")) {
                            out.write("{\\"type\\":\\"result\\",\\"callId\\":\\""
                                    + id + "\\",\\"success\\":false,"
                                    + "\\"error\\":{\\"code\\":\\"asked_to_fail\\","
                                    + "\\"message\\":\\"输入要求失败\\"}}");
                        } else {
                            out.write("{\\"type\\":\\"progress\\",\\"callId\\":\\""
                                    + id + "\\",\\"text\\":\\"halfway\\"}");
                            out.newLine();
                            out.flush();
                            out.write("{\\"type\\":\\"result\\",\\"callId\\":\\""
                                    + id + "\\",\\"success\\":true,\\"data\\":\\"pong\\","
                                    + "\\"structuredData\\":{\\"value\\":42}}");
                        }
                        out.newLine();
                        out.flush();
                    }
                }
            }
            """;

    @Test
    void invokeRoundTripCollectsProgressAndStructured() throws Exception {
        ResidentProcessTool tool = tool();

        ToolOutcome outcome = execute(tool, "{\"text\": \"hello\"}");

        assertEquals(ToolOutcome.Kind.SUCCEEDED, outcome.kind());
        assertEquals("pong", outcome.output().path("content").asText());
        assertEquals(42,
                outcome.output().path("structured").path("value").asInt());
        assertEquals("halfway",
                outcome.output().path("progress").get(0).asText());

        // 常驻：第二次调用复用进程，仍然成功
        ToolOutcome second = execute(tool, "{\"text\": \"again\"}");
        assertEquals(ToolOutcome.Kind.SUCCEEDED, second.kind());
        tool.retire();
    }

    @Test
    void pluginErrorFrameBecomesFailedOutcome() throws Exception {
        ResidentProcessTool tool = tool();

        ToolOutcome outcome = execute(tool, "{\"text\": \"please_fail\"}");

        assertEquals(ToolOutcome.Kind.FAILED, outcome.kind());
        assertEquals("asked_to_fail", outcome.errorCode());
        tool.retire();
    }

    @Test
    void crashRestartsOnceThenReportsAndRecovers() throws Exception {
        ResidentProcessTool tool = tool();

        ToolOutcome crashed = execute(tool, "{\"text\": \"crash\"}");
        assertEquals(ToolOutcome.Kind.FAILED, crashed.kind());
        assertEquals("process_crashed", crashed.errorCode());

        // 崩溃不传染：下一次调用惰性拉起新进程
        ToolOutcome recovered = execute(tool, "{\"text\": \"ok\"}");
        assertEquals(ToolOutcome.Kind.SUCCEEDED, recovered.kind());
        assertEquals("pong", recovered.output().path("content").asText());
        tool.retire();
    }

    @Test
    void retiredToolRejectsNewInvocations() throws Exception {
        ResidentProcessTool tool = tool();
        tool.retire();

        ToolOutcome outcome = execute(tool, "{\"text\": \"hello\"}");

        assertEquals(ToolOutcome.Kind.FAILED, outcome.kind());
        assertEquals("extension_retired", outcome.errorCode());
    }

    private ResidentProcessTool tool() throws Exception {
        Files.writeString(pluginDir.resolve("Probe.java"), PROBE_SOURCE);
        ObjectMapper yaml = new ObjectMapper(
                new com.fasterxml.jackson.dataformat.yaml.YAMLFactory());
        ProcessToolDefinition definition = yaml.readValue("""
                name: probe_tool
                kind: process
                description: 协议探针
                input_schema: { type: object, properties: { text: { type: string } } }
                runtime:
                  entry: ["{javaBin}", "{pluginDir}/Probe.java"]
                limits: { timeout_ms: 60000 }
                """, ProcessToolDefinition.class);
        return new ResidentProcessTool(
                definition, pluginDir, "test-version", objectMapper);
    }

    private ToolOutcome execute(ResidentProcessTool tool, String inputJson)
            throws Exception {
        return tool.execute(
                new CommittedOperation(
                        "exec-" + System.nanoTime(), "snap-1", "hash-1",
                        objectMapper.readTree(inputJson), List.of()),
                context()
        );
    }

    private ToolContext context() {
        return new ToolContext() {
            @Override
            public String conversationId() {
                return "conv-test";
            }

            @Override
            public String turnId() {
                return "turn-test";
            }

            @Override
            public String runId() {
                return "run-test";
            }

            @Override
            public String roundId() {
                return "round-test";
            }

            @Override
            public Path workspaceRoot() {
                return workspace;
            }

            @Override
            public boolean cancelled() {
                return false;
            }
        };
    }
}
