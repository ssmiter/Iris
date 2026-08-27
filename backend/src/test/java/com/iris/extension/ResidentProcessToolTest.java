package com.iris.extension;

import com.fasterxml.jackson.databind.ObjectMapper;
import com.iris.tools.core.CommittedOperation;
import com.iris.tools.core.PreparedOperation;
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
    void prepareDeclaresCoarseResourceForSideEffectTools() throws Exception {
        ResidentProcessTool tool = toolWithRisk(
                "writer_tool",
                "{ level: standard, side_effect: workspace_write }");

        PreparedOperation prepared = tool.prepare(
                objectMapper.createObjectNode(), context());

        assertEquals(1, prepared.resources().size());
        PreparedOperation.ResourceClaim claim = prepared.resources().getFirst();
        assertEquals("extension_workspace", claim.kind());
        assertEquals("writer_tool", claim.logicalPath());
        tool.retire();
    }

    @Test
    void prepareKeepsEmptyResourcesForReadOnlyTools() throws Exception {
        ResidentProcessTool tool = toolWithRisk(
                "reader_tool",
                "{ level: read_only, side_effect: none }");

        PreparedOperation prepared = tool.prepare(
                objectMapper.createObjectNode(), context());

        assertTrue(prepared.resources().isEmpty());
        tool.retire();
    }

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

    /**
     * §3.2 共享常驻进程：同目录两个清单共用一个进程，插件按 invoke
     * 帧的 tool 字段分发；任一清单 retire 即回收共享进程。
     */
    @Test
    void sharedProcessDispatchesByToolField() throws Exception {
        Files.writeString(pluginDir.resolve("ToolEcho.java"), """
                import java.io.*;
                public class ToolEcho {
                    public static void main(String[] args) throws Exception {
                        BufferedReader in = new BufferedReader(
                                new InputStreamReader(System.in, "UTF-8"));
                        BufferedWriter out = new BufferedWriter(
                                new OutputStreamWriter(System.out, "UTF-8"));
                        java.util.regex.Pattern callId = java.util.regex.Pattern
                                .compile("\\"callId\\":\\"([^\\"]+)\\"");
                        java.util.regex.Pattern tool = java.util.regex.Pattern
                                .compile("\\"tool\\":\\"([^\\"]+)\\"");
                        String line;
                        while ((line = in.readLine()) != null) {
                            var idMatcher = callId.matcher(line);
                            var toolMatcher = tool.matcher(line);
                            if (!line.contains("invoke") || !idMatcher.find()) {
                                continue;
                            }
                            toolMatcher.find();
                            out.write("{\\"type\\":\\"result\\",\\"callId\\":\\""
                                    + idMatcher.group(1)
                                    + "\\",\\"success\\":true,\\"data\\":\\""
                                    + toolMatcher.group(1) + "\\"}");
                            out.newLine();
                            out.flush();
                        }
                    }
                }
                """);
        ObjectMapper yaml = new ObjectMapper(
                new com.fasterxml.jackson.dataformat.yaml.YAMLFactory());
        String manifestTemplate = """
                name: %s
                kind: process
                description: 共享进程探针
                input_schema: { type: object, properties: {} }
                risk: { level: read_only, side_effect: none }
                runtime:
                  entry: ["{javaBin}", "{pluginDir}/ToolEcho.java"]
                limits: { timeout_ms: 60000 }
                """;
        ProcessToolDefinition alpha = yaml.readValue(
                manifestTemplate.formatted("alpha_tool"),
                ProcessToolDefinition.class);
        ProcessToolDefinition beta = yaml.readValue(
                manifestTemplate.formatted("beta_tool"),
                ProcessToolDefinition.class);
        ResidentPluginProcess shared = new ResidentPluginProcess(
                TemplateProcessTool.renderSpawnArgv(
                        alpha.runtime().entry(), pluginDir),
                pluginDir,
                java.util.Map.of(),
                objectMapper
        );
        ResidentProcessTool alphaTool = new ResidentProcessTool(
                alpha, "v1", shared, objectMapper);
        ResidentProcessTool betaTool = new ResidentProcessTool(
                beta, "v1", shared, objectMapper);

        ToolOutcome alphaOutcome = execute(alphaTool, "{}");
        ToolOutcome betaOutcome = execute(betaTool, "{}");

        assertEquals(ToolOutcome.Kind.SUCCEEDED, alphaOutcome.kind());
        assertEquals("alpha_tool",
                alphaOutcome.output().path("content").asText());
        assertEquals(ToolOutcome.Kind.SUCCEEDED, betaOutcome.kind());
        assertEquals("beta_tool",
                betaOutcome.output().path("content").asText());

        alphaTool.retire();
        assertEquals("extension_retired",
                execute(betaTool, "{}").errorCode());
    }

    /** 构造带指定 risk 声明的工具；prepare 不触碰进程，无需真实插件文件。 */
    private ResidentProcessTool toolWithRisk(String name, String risk)
            throws Exception {
        ObjectMapper yaml = new ObjectMapper(
                new com.fasterxml.jackson.dataformat.yaml.YAMLFactory());
        ProcessToolDefinition definition = yaml.readValue("""
                name: %s
                kind: process
                description: 资源声明探针
                input_schema: { type: object, properties: {} }
                risk: %s
                runtime:
                  entry: ["{javaBin}", "{pluginDir}/Probe.java"]
                """.formatted(name, risk), ProcessToolDefinition.class);
        return new ResidentProcessTool(
                definition, pluginDir, "test-version", objectMapper);
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
                risk: { level: read_only, side_effect: none }
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
