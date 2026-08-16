package com.iris.extension;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.iris.execution.WorkspaceProcessRunner;
import com.iris.tools.core.CommittedOperation;
import com.iris.tools.core.ToolContext;
import com.iris.tools.core.ToolOutcome;
import com.iris.tools.core.ToolRegistry;
import com.iris.tools.core.ToolRuntimeException;
import com.iris.workspace.WorkspacePathGuard;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;

import java.nio.file.Path;
import java.util.List;
import java.util.Locale;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.junit.jupiter.api.Assertions.assertTrue;

class TemplateProcessToolTest {

    private final ObjectMapper objectMapper = new ObjectMapper();
    private final WorkspaceProcessRunner runner =
            new WorkspaceProcessRunner(new WorkspacePathGuard());

    @TempDir
    Path workspace;

    @TempDir
    Path pluginDir;

    @Test
    void rendersArgvTemplates() throws Exception {
        ProcessToolDefinition definition = definition("""
                name: echo_tool
                kind: template
                description: 回显
                input_schema: { type: object, properties: { text: { type: string } } }
                runtime:
                  entry: [python, "{pluginDir}/echo.py", "--text", "{text}"]
                """);
        TemplateProcessTool tool = tool(definition);
        JsonNode input = objectMapper.readTree("{\"text\": \"你好\"}");

        List<String> argv = tool.renderArgv(definition.runtime().entry(), input);

        assertEquals("python", argv.get(0));
        assertEquals(pluginDir.toAbsolutePath() + "/echo.py", argv.get(1));
        assertEquals("你好", argv.get(3));
    }

    @Test
    void missingTemplateParamFailsFast() throws Exception {
        ProcessToolDefinition definition = definition("""
                name: echo_tool
                kind: template
                description: 回显
                input_schema: { type: object, properties: { text: { type: string } } }
                runtime:
                  entry: [python, echo.py, "{text}"]
                """);
        TemplateProcessTool tool = tool(definition);
        JsonNode input = objectMapper.readTree("{}");

        assertThrows(
                ToolRuntimeException.class,
                () -> tool.renderArgv(definition.runtime().entry(), input)
        );
    }

    @Test
    void executesRealProcessAndCapturesStdout() throws Exception {
        String javaBin = Path.of(System.getProperty("java.home"), "bin",
                isWindows() ? "java.exe" : "java").toString();
        TemplateProcessTool tool = tool(definition("""
                name: java_version
                kind: template
                description: 打印 JVM 版本
                input_schema: { type: object, properties: {} }
                runtime:
                  entry: ["%s", "-version"]
                limits: { timeout_ms: 30000 }
                """.formatted(javaBin.replace("\\", "\\\\"))));

        ToolOutcome outcome = tool.execute(
                new CommittedOperation(
                        "exec-1", "snap-1", "hash-1",
                        objectMapper.createObjectNode(), List.of()),
                context()
        );

        assertEquals(ToolOutcome.Kind.SUCCEEDED, outcome.kind());
        assertEquals(0, outcome.output().path("exitCode").asInt());
    }

    @Test
    void registersThroughExternalProviderWithUnderscoreDirectory()
            throws Exception {
        ToolRegistry registry = new ToolRegistry(List.of(), objectMapper);
        TemplateProcessTool tool = tool(definition("""
                name: mes_material_info
                kind: template
                description: 查询胶料主数据
                input_schema: { type: object, properties: {} }
                runtime:
                  entry: [python, material.py]
                """));

        registry.replaceExternal(
                "extension:test",
                List.of(new ToolRegistry.ExternalToolRegistration(
                        "/industry/mes/_02mixing/_01base/mes_material_info",
                        tool
                )),
                objectMapper
        );

        assertTrue(registry.find("mes_material_info").isPresent());
        registry.unregisterExternal("extension:test");
        assertTrue(registry.find("mes_material_info").isEmpty());
    }

    private boolean isWindows() {
        return System.getProperty("os.name")
                .toLowerCase(Locale.ROOT).contains("win");
    }

    private ProcessToolDefinition definition(String yaml) throws Exception {
        ObjectMapper yamlMapper = new ObjectMapper(
                new com.fasterxml.jackson.dataformat.yaml.YAMLFactory());
        return yamlMapper.readValue(yaml, ProcessToolDefinition.class);
    }

    private TemplateProcessTool tool(ProcessToolDefinition definition) {
        return new TemplateProcessTool(
                definition, pluginDir, "test-version", runner, objectMapper);
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
