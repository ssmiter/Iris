package com.iris.extension;

import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;

import java.io.IOException;
import java.nio.file.Files;
import java.nio.file.Path;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertTrue;

class ExtensionScannerTest {

    private final ExtensionScanner scanner = new ExtensionScanner();

    @TempDir
    Path root;

    @Test
    void scansValidToolAndDerivesPathFromDirectory() throws IOException {
        writeTool("industry/mes/_02mixing/_01base/material-info.tool.yml", """
                name: mes_material_info
                kind: template
                description: 查询胶料主数据
                input_schema:
                  type: object
                  properties:
                    material: { type: string }
                runtime:
                  entry: [python, "{pluginDir}/material.py", "--material", "{material}"]
                """);

        ExtensionScanner.ScanResult result = scanner.scan(root);

        assertTrue(result.problems().isEmpty(), () -> result.problems().toString());
        assertEquals(1, result.tools().size());
        ExtensionScanner.ScannedTool tool = result.tools().getFirst();
        assertEquals(
                "/industry/mes/_02mixing/_01base/mes_material_info",
                tool.capabilityPath()
        );
        assertTrue(tool.contentVersion().length() == 16);
    }

    @Test
    void rejectsInvalidManifestsFailClosed() throws IOException {
        writeTool("code/python/ok.tool.yml", """
                name: ok_tool
                kind: template
                description: 合法工具
                input_schema: { type: object, properties: {} }
                runtime:
                  entry: [python, ok.py]
                """);
        writeTool("code/python/bad-name.tool.yml", """
                name: BadName
                kind: template
                description: 名字非法
                input_schema: { type: object, properties: {} }
                runtime:
                  entry: [python, bad.py]
                """);
        writeTool("code/python/explicit-without-impact.tool.yml", """
                name: needs_impact
                kind: template
                description: 缺影响陈述
                input_schema: { type: object, properties: {} }
                risk: { level: standard, side_effect: workspace_write }
                approval: { mode: explicit }
                runtime:
                  entry: [python, write.py]
                """);
        writeTool("code/python/process-param.tool.yml", """
                name: resident_tool
                kind: process
                description: 常驻形态参数只能走 invoke 帧
                input_schema: { type: object, properties: {} }
                runtime:
                  entry: ["{javaBin}", "{pluginDir}/resident.py", "{input}"]
                """);

        ExtensionScanner.ScanResult result = scanner.scan(root);

        assertEquals(1, result.tools().size());
        assertEquals("ok_tool", result.tools().getFirst().definition().name());
        assertEquals(3, result.problems().size(),
                () -> result.problems().toString());
    }

    @Test
    void scansResidentProcessManifest() throws IOException {
        writeTool("system/time/current-time.tool.yml", """
                name: current_time
                kind: process
                description: 读取当前时间
                input_schema: { type: object, properties: {} }
                runtime:
                  entry: ["{javaBin}", "{pluginDir}/CurrentTime.java"]
                """);

        ExtensionScanner.ScanResult result = scanner.scan(root);

        assertTrue(result.problems().isEmpty(),
                () -> result.problems().toString());
        assertEquals(1, result.tools().size());
        assertEquals("/system/time/current_time",
                result.tools().getFirst().capabilityPath());
    }

    @Test
    void readsDirectoryMetadataAndHiddenFlag() throws IOException {
        Path directory = root.resolve("industry/mes/_05curing");
        Files.createDirectories(directory);
        Files.writeString(directory.resolve("_directory.yml"), """
                label: 硫化
                summary: 硫化计划、生产实绩、模具与周期
                order: 50
                tags: [curing]
                """);
        Path hidden = root.resolve("code/bash");
        Files.createDirectories(hidden);
        Files.writeString(hidden.resolve("_directory.yml"), """
                label: 通用 shell
                visibility: hidden
                """);

        ExtensionScanner.ScanResult result = scanner.scan(root);

        assertEquals(2, result.directories().size());
        ExtensionScanner.ScannedDirectory curing = result.directories().stream()
                .filter(item -> item.directoryPath()
                        .equals("/industry/mes/_05curing"))
                .findFirst()
                .orElseThrow();
        assertEquals("硫化", curing.metadata().label());
        assertTrue(!curing.metadata().hidden());
        ExtensionScanner.ScannedDirectory bash = result.directories().stream()
                .filter(item -> item.directoryPath().equals("/code/bash"))
                .findFirst()
                .orElseThrow();
        assertTrue(bash.metadata().hidden());
    }

    @Test
    void scansMcpDeclarationsAndRejectsInvalidOnes() throws IOException {
        writeTool("mcp/filesystem.mcp.yml", """
                slug: filesystem
                display_name: 文件系统
                transport: stdio
                command: [npx, -y, "@modelcontextprotocol/server-filesystem", "."]
                env: [SOME_TOKEN]
                enabled: true
                """);
        writeTool("mcp/remote-search.mcp.yml", """
                slug: remote_search
                display_name: 远端检索
                transport: streamable_http
                endpoint: https://example.com/mcp
                authorization_env: MCP_TOKEN
                enabled: false
                """);
        writeTool("mcp/bad-transport.mcp.yml", """
                slug: bad_transport
                display_name: 非法传输
                transport: websocket
                """);
        writeTool("mcp/stdio-without-command.mcp.yml", """
                slug: no_command
                display_name: 缺启动命令
                transport: stdio
                """);

        ExtensionScanner.ScanResult result = scanner.scan(root);

        assertEquals(2, result.mcpServers().size(),
                () -> result.problems().toString());
        assertEquals(2, result.problems().size(),
                () -> result.problems().toString());
        ExtensionScanner.ScannedMcpServer filesystem = result.mcpServers()
                .stream()
                .filter(item -> item.declaration().slug().equals("filesystem"))
                .findFirst()
                .orElseThrow();
        assertEquals("stdio", filesystem.declaration().transport());
        assertEquals(4, filesystem.declaration().command().size());
        assertTrue(filesystem.declaration().enabledOrDefault());
        ExtensionScanner.ScannedMcpServer remote = result.mcpServers().stream()
                .filter(item -> item.declaration().slug()
                        .equals("remote_search"))
                .findFirst()
                .orElseThrow();
        assertTrue(!remote.declaration().enabledOrDefault());
    }

    @Test
    void skipsHiddenDirectoriesAndMissingRoot() {
        assertTrue(scanner.scan(root.resolve("absent")).tools().isEmpty());
    }

    private void writeTool(String relative, String content) throws IOException {
        Path file = root.resolve(relative);
        Files.createDirectories(file.getParent());
        Files.writeString(file, content);
    }
}
