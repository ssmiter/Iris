package com.iris.extension;

import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;

import java.io.IOException;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.List;

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
                risk: { level: read_only, side_effect: none }
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
                risk: { level: read_only, side_effect: none }
                runtime:
                  entry: [python, ok.py]
                """);
        writeTool("code/python/bad-name.tool.yml", """
                name: BadName
                kind: template
                description: 名字非法
                input_schema: { type: object, properties: {} }
                risk: { level: read_only, side_effect: none }
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
                risk: { level: read_only, side_effect: none }
                runtime:
                  entry: ["{javaBin}", "{pluginDir}/resident.py", "{input}"]
                """);
        writeTool("code/python/missing-risk.tool.yml", """
                name: missing_risk
                kind: template
                description: 缺 risk 块
                input_schema: { type: object, properties: {} }
                runtime:
                  entry: [python, risky.py]
                """);

        ExtensionScanner.ScanResult result = scanner.scan(root);

        assertEquals(1, result.tools().size());
        assertEquals("ok_tool", result.tools().getFirst().definition().name());
        assertEquals(4, result.problems().size(),
                () -> result.problems().toString());
    }

    @Test
    void rejectsMissingRiskBlockAndMissingFields() throws IOException {
        writeTool("code/python/missing-risk-block.tool.yml", """
                name: missing_risk_block
                kind: template
                description: 缺整个 risk 块
                input_schema: { type: object, properties: {} }
                runtime:
                  entry: [python, risky.py]
                """);
        writeTool("code/python/missing-risk-level.tool.yml", """
                name: missing_risk_level
                kind: template
                description: 缺 risk.level
                input_schema: { type: object, properties: {} }
                risk: { side_effect: none }
                runtime:
                  entry: [python, risky.py]
                """);
        writeTool("code/python/missing-risk-side-effect.tool.yml", """
                name: missing_risk_side_effect
                kind: template
                description: 缺 risk.side_effect
                input_schema: { type: object, properties: {} }
                risk: { level: read_only }
                runtime:
                  entry: [python, risky.py]
                """);

        ExtensionScanner.ScanResult result = scanner.scan(root);

        assertTrue(result.tools().isEmpty());
        assertEquals(3, result.problems().size(),
                () -> result.problems().toString());
        assertTrue(result.problems().stream()
                        .map(ExtensionScanner.ScanProblem::description)
                        .allMatch(description -> description.contains("risk")),
                () -> result.problems().toString());
    }

    @Test
    void validatesOptionalPromptChannel() throws IOException {
        writeTool("code/python/with-prompt.tool.yml", """
                name: with_prompt
                kind: template
                description: 带行为合同的工具
                prompt: 参数 date 必须是 ISO 日期；单次批量上限 100 条。
                input_schema: { type: object, properties: {} }
                risk: { level: read_only, side_effect: none }
                runtime:
                  entry: [python, ok.py]
                """);
        writeTool("code/python/blank-prompt.tool.yml", """
                name: blank_prompt
                kind: template
                description: 空 prompt
                prompt: ""
                input_schema: { type: object, properties: {} }
                risk: { level: read_only, side_effect: none }
                runtime:
                  entry: [python, ok.py]
                """);
        writeTool("code/python/oversize-prompt.tool.yml", """
                name: oversize_prompt
                kind: template
                description: 超长 prompt
                input_schema: { type: object, properties: {} }
                risk: { level: read_only, side_effect: none }
                runtime:
                  entry: [python, ok.py]
                prompt: %s
                """.formatted("长".repeat(4_001)));

        ExtensionScanner.ScanResult result = scanner.scan(root);

        assertEquals(1, result.tools().size(),
                () -> result.problems().toString());
        assertEquals("with_prompt",
                result.tools().getFirst().definition().name());
        assertEquals("参数 date 必须是 ISO 日期；单次批量上限 100 条。",
                result.tools().getFirst().definition().prompt());
        assertEquals(2, result.problems().size(),
                () -> result.problems().toString());
        assertTrue(result.problems().stream()
                        .map(ExtensionScanner.ScanProblem::description)
                        .allMatch(description -> description.contains("prompt")),
                () -> result.problems().toString());
    }

    @Test
    void scansResidentProcessManifest() throws IOException {
        writeTool("system/time/current-time.tool.yml", """
                name: current_time
                kind: process
                description: 读取当前时间
                input_schema: { type: object, properties: {} }
                risk: { level: read_only, side_effect: none }
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

    @Test
    void projectsKnowledgeDocsWithSlugTitleAndHashNames() throws IOException {
        // ascii 名 → snake slug；标题取首个 # 标题行
        writeDoc("product/knowledge/getting-started.md", """
                # 入门指南

                正文第一行
                """);
        // 纯非 ascii 名 → doc_<内容hash前8位>；无标题行 → 首个非空行
        writeDoc("product/knowledge/周报模板.md", """
                本周模板正文
                """);
        // 无 knowledge 段的 .md 不投影
        writeDoc("product/notes/readme.md", """
                # 不应出现
                """);

        ExtensionScanner.ScanResult result = scanner.scan(root);

        assertTrue(result.problems().isEmpty(),
                () -> result.problems().toString());
        assertEquals(2, result.knowledge().size());
        ExtensionScanner.ScannedKnowledge guide = result.knowledge().stream()
                .filter(doc -> doc.name().equals("getting_started"))
                .findFirst()
                .orElseThrow();
        assertEquals("入门指南", guide.title());
        assertEquals("/product/knowledge/getting_started",
                guide.capabilityPath());
        assertEquals(16, guide.contentVersion().length());
        ExtensionScanner.ScannedKnowledge weekly = result.knowledge().stream()
                .filter(doc -> !doc.name().equals("getting_started"))
                .findFirst()
                .orElseThrow();
        assertTrue(weekly.name().startsWith("doc_"),
                () -> weekly.name());
        assertEquals(12, weekly.name().length()); // doc_ + hash8
        assertEquals("本周模板正文", weekly.title());
    }

    @Test
    void knowledgeNameCollisionGetsDeterministicHashSuffix() throws IOException {
        writeDoc("team/knowledge/a-b.md", "同名之一\n");
        writeDoc("team/knowledge/a_b.md", "同名之二\n");

        ExtensionScanner.ScanResult result = scanner.scan(root);

        assertEquals(2, result.knowledge().size(),
                () -> result.problems().toString());
        List<String> names = result.knowledge().stream()
                .map(ExtensionScanner.ScannedKnowledge::name)
                .sorted()
                .toList();
        assertEquals("a_b", names.get(0));
        assertTrue(names.get(1).startsWith("a_b_"),
                () -> names.toString());
        assertEquals(12, names.get(1).length()); // a_b_ + hash8

        // 确定性：同内容再扫一次，后缀一致
        ExtensionScanner.ScanResult again = scanner.scan(root);
        assertEquals(names, again.knowledge().stream()
                .map(ExtensionScanner.ScannedKnowledge::name)
                .sorted()
                .toList());
    }

    @Test
    void scansSkillBundleAndFlatForms() throws IOException {
        // 束形态：父目录 + 转换后能力名（叶段 snake_case 约束）
        writeDoc("skills/web-research/SKILL.md", """
                ---
                name: web-research
                description: 联网检索并归纳资料
                whenToUse: 需要查最新资料时
                metadata: { origin: community }
                ---
                # 联网研究

                先列问题再检索。
                """);
        // 扁平形态：路径 = 所在目录 + 派生名
        writeDoc("skills/summarize.SKILL.md", """
                ---
                name: summarize
                description: 归纳长文为要点
                ---
                正文
                """);

        ExtensionScanner.ScanResult result = scanner.scan(root);

        assertTrue(result.problems().isEmpty(),
                () -> result.problems().toString());
        assertEquals(2, result.skills().size());
        ExtensionScanner.ScannedSkill bundle = result.skills().stream()
                .filter(skill -> skill.name().equals("web_research"))
                .findFirst()
                .orElseThrow();
        assertEquals("/skills/web_research", bundle.capabilityPath());
        assertEquals(root.resolve("skills/web-research"), bundle.bundleDir());
        assertEquals("需要查最新资料时",
                bundle.definition().whenToUse());
        assertTrue(!bundle.definition().disabledForModel());
        ExtensionScanner.ScannedSkill flat = result.skills().stream()
                .filter(skill -> skill.name().equals("summarize"))
                .findFirst()
                .orElseThrow();
        assertEquals("/skills/summarize", flat.capabilityPath());
        assertEquals(null, flat.bundleDir());
    }

    @Test
    void rejectsInvalidSkillsFailClosed() throws IOException {
        // 缺 frontmatter
        writeDoc("skills/no-front.SKILL.md", "# 只有正文\n");
        // 白名单外字段
        writeDoc("skills/extra-field.SKILL.md", """
                ---
                name: extra-field
                description: 带未知字段
                license: MIT
                ---
                正文
                """);
        // name 非 kebab-case
        writeDoc("skills/bad-name.SKILL.md", """
                ---
                name: Bad_Name
                description: 名字非法
                ---
                正文
                """);
        // 缺 description
        writeDoc("skills/no-desc.SKILL.md", """
                ---
                name: no-desc
                ---
                正文
                """);
        // SKILL.md 直接挂根上（束目录必须有名）
        writeDoc("SKILL.md", """
                ---
                name: root-level
                description: 直接挂根
                ---
                正文
                """);

        ExtensionScanner.ScanResult result = scanner.scan(root);

        assertTrue(result.skills().isEmpty());
        assertEquals(5, result.problems().size(),
                () -> result.problems().toString());
    }

    @Test
    void knowledgeSegmentKeepsPrecedenceOverSkillName() throws IOException {
        // knowledge 段下的 SKILL.md 按知识投影，不作技能（§5.1）
        writeDoc("team/knowledge/SKILL.md", """
                ---
                name: not-a-skill
                description: 语料目录里的普通文档
                ---
                正文
                """);

        ExtensionScanner.ScanResult result = scanner.scan(root);

        assertTrue(result.skills().isEmpty());
        assertEquals(1, result.knowledge().size(),
                () -> result.problems().toString());
    }

    private void writeDoc(String relative, String content) throws IOException {        Path file = root.resolve(relative);
        Files.createDirectories(file.getParent());
        Files.writeString(file, content);
    }

    private void writeTool(String relative, String content) throws IOException {
        Path file = root.resolve(relative);
        Files.createDirectories(file.getParent());
        Files.writeString(file, content);
    }
}
