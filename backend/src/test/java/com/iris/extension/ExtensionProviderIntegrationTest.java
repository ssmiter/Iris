package com.iris.extension;

import com.fasterxml.jackson.databind.ObjectMapper;
import com.iris.tools.catalog.CapabilityDirectoryCatalog;
import com.iris.tools.core.ToolContext;
import com.iris.tools.core.ToolExecutionViews.Invocation;
import com.iris.tools.core.ToolRegistry;
import com.iris.tools.core.ToolRuntime;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.test.context.DynamicPropertyRegistry;
import org.springframework.test.context.DynamicPropertySource;

import java.io.IOException;
import java.nio.file.Files;
import java.nio.file.Path;
import java.time.Instant;
import java.util.Locale;

import static org.assertj.core.api.Assertions.assertThat;

/**
 * 拓展根全链路：扫描 → 校验 → 注册 → 目录投影 → 经 ToolRuntime 真实执行
 * （docs/31 §6 生命周期与 §9 安全边界的集成验证）。
 */
@SpringBootTest
class ExtensionProviderIntegrationTest {

    private static final Path DATABASE = Path.of(
            "target", "test-data", "extension-provider.db"
    ).toAbsolutePath();
    private static final Path WORKSPACE = Path.of(
            "target", "test-extension-workspace"
    ).toAbsolutePath();
    private static final Path EXTENSION_ROOT = Path.of(
            "target", "test-extensions"
    ).toAbsolutePath();

    @Autowired
    private ToolRegistry toolRegistry;

    @Autowired
    private ToolRuntime toolRuntime;

    @Autowired
    private CapabilityDirectoryCatalog directoryCatalog;

    @Autowired
    private ObjectMapper objectMapper;

    @Autowired
    private JdbcTemplate jdbc;

    @DynamicPropertySource
    static void testProperties(DynamicPropertyRegistry registry)
            throws IOException {
        Files.createDirectories(DATABASE.getParent());
        Files.deleteIfExists(DATABASE);
        Files.deleteIfExists(Path.of(DATABASE + "-wal"));
        Files.deleteIfExists(Path.of(DATABASE + "-shm"));
        Files.createDirectories(WORKSPACE);

        String javaBin = Path.of(System.getProperty("java.home"), "bin",
                isWindows() ? "java.exe" : "java").toString();
        Path toolDir = EXTENSION_ROOT.resolve("code/process");
        Files.createDirectories(toolDir);
        Files.writeString(
                toolDir.resolve("jvm-version.tool.yml"),
                """
                name: jvm_version
                kind: template
                description: 打印当前 JVM 的版本信息
                input_schema:
                  type: object
                  properties: {}
                risk: { level: read_only, side_effect: none }
                runtime:
                  entry: ["%s", "-version"]
                limits: { timeout_ms: 30000 }
                """.formatted(javaBin.replace('\\', '/'))
        );
        Files.writeString(
                EXTENSION_ROOT.resolve("code/_directory.yml"),
                """
                label: 通用过程工具
                summary: 按运行时组织的通用过程工具（python/sql/bash）
                """
        );

        // §3.2 共享常驻进程夹具：同目录两个清单共用 ToolEcho.java，
        // 插件按 invoke 帧的 tool 字段回显分发结果
        Path sharedDir = EXTENSION_ROOT.resolve("code/shared");
        Files.createDirectories(sharedDir);
        Files.writeString(sharedDir.resolve("ToolEcho.java"), """
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
        String sharedManifest = """
                name: %s
                kind: process
                description: 共享进程夹具
                input_schema: { type: object, properties: {} }
                runtime:
                  entry: ["{javaBin}", "{pluginDir}/ToolEcho.java"]
                limits: { timeout_ms: 60000 }
                """;
        Files.writeString(sharedDir.resolve("alpha.tool.yml"),
                sharedManifest.formatted("shared_alpha"));
        Files.writeString(sharedDir.resolve("beta.tool.yml"),
                sharedManifest.formatted("shared_beta"));

        // entry 不一致的同目录清单：fail-closed 整目录拒绝
        Path brokenDir = EXTENSION_ROOT.resolve("code/broken");
        Files.createDirectories(brokenDir);
        Files.writeString(brokenDir.resolve("broken-a.tool.yml"),
                sharedManifest.formatted("broken_a"));
        Files.writeString(brokenDir.resolve("broken-b.tool.yml"), """
                name: broken_b
                kind: process
                description: entry 与邻桌不一致
                input_schema: { type: object, properties: {} }
                runtime:
                  entry: ["{javaBin}", "{pluginDir}/Elsewhere.java"]
                limits: { timeout_ms: 60000 }
                """);

        // 知识库投影夹具（docs/31 §3）
        Path knowledgeDir = EXTENSION_ROOT.resolve("product/knowledge");
        Files.createDirectories(knowledgeDir);
        Files.writeString(knowledgeDir.resolve("getting-started.md"), """
                # 入门指南

                知识库正文内容
                """);

        Files.createDirectories(WORKSPACE.resolve("marker-dir"));

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

    private static boolean isWindows() {
        return System.getProperty("os.name")
                .toLowerCase(Locale.ROOT).contains("win");
    }

    @Test
    void scansRegistersAndExecutesExtensionTool() {
        var binding = toolRegistry.find("jvm_version");
        assertThat(binding).isPresent();
        assertThat(binding.get().capabilityPath())
                .isEqualTo("/code/process/jvm_version");

        // 目录投影：_directory.yml 进入目录树（拓展只能新增，不覆盖代码目录）
        assertThat(directoryCatalog.all())
                .anySatisfy(directory -> {
                    assertThat(directory.path()).isEqualTo("/code");
                    assertThat(directory.title()).isEqualTo("通用过程工具");
                });

        // 经真实 ToolRuntime 执行（只读 → 直接执行，无审批挂起）
        seedExecutionParents();
        var result = toolRuntime.invoke(
                new Invocation("call-ext-1", "jvm_version"),
                objectMapper.createObjectNode(),
                new TestToolContext(WORKSPACE)
        );
        assertThat(result.phase()).isEqualTo("succeeded");
        assertThat(result.approvalId()).isNull();
    }

    /**
     * §3.2：同目录两个 process 清单共享一个常驻进程，经真实
     * ToolRuntime 各自分发成功；entry 不一致的目录整目录被拒绝。
     */
    @Test
    void sharedProcessManifestsDispatchByToolAndMismatchIsRejected() {
        assertThat(toolRegistry.find("shared_alpha")).isPresent();
        assertThat(toolRegistry.find("shared_beta")).isPresent();
        assertThat(toolRegistry.find("shared_alpha").get().capabilityPath())
                .isEqualTo("/code/shared/shared_alpha");
        // fail-closed：entry 不一致 → 整目录不注册
        assertThat(toolRegistry.find("broken_a")).isEmpty();
        assertThat(toolRegistry.find("broken_b")).isEmpty();

        seedExecutionParents("shared");
        var alpha = toolRuntime.invoke(
                new Invocation("call-shared-a", "shared_alpha"),
                objectMapper.createObjectNode(),
                new TestToolContext(WORKSPACE, "shared")
        );
        var beta = toolRuntime.invoke(
                new Invocation("call-shared-b", "shared_beta"),
                objectMapper.createObjectNode(),
                new TestToolContext(WORKSPACE, "shared")
        );
        assertThat(alpha.phase()).isEqualTo("succeeded");
        assertThat(beta.phase()).isEqualTo("succeeded");
    }

    /** 知识库投影（docs/31 §3）：knowledge 段下的 .md 即只读能力。 */
    @Test
    void knowledgeDocIsRegisteredAsReadOnlyCapability() {
        var binding = toolRegistry.find("getting_started");
        assertThat(binding).isPresent();
        assertThat(binding.get().capabilityPath())
                .isEqualTo("/product/knowledge/getting_started");

        seedExecutionParents("knowledge");
        var result = toolRuntime.invoke(
                new Invocation("call-knowledge-1", "getting_started"),
                objectMapper.createObjectNode(),
                new TestToolContext(WORKSPACE, "knowledge")
        );
        assertThat(result.phase()).isEqualTo("succeeded");
        assertThat(result.approvalId()).isNull();
    }

    /**
     * tool_execution 的外键要求真实的会话/轮次/Run 行存在
     * （schema.sql tool_execution 的三条 REFERENCES）——直接落最小父行链，
     * 不绕过 Runtime 本身。
     */
    private void seedExecutionParents() {
        seedExecutionParents("ext-test");
    }

    private void seedExecutionParents(String suffix) {
        String now = Instant.now().toString();
        jdbc.update(
                "INSERT INTO iris_conversation("
                        + "conversation_id, root_branch_id, title, version,"
                        + " created_at, updated_at) VALUES (?,?,?,?,?,?)",
                "conv-" + suffix, "branch-" + suffix, "拓展集成测试", 1,
                now, now
        );
        jdbc.update(
                "INSERT INTO conversation_branch("
                        + "branch_id, conversation_id, status, version,"
                        + " created_at) VALUES (?,?,?,?,?)",
                "branch-" + suffix, "conv-" + suffix, "active", 1, now
        );
        jdbc.update(
                "INSERT INTO message("
                        + "message_id, conversation_id, branch_id, turn_id,"
                        + " role, content, created_at) VALUES (?,?,?,?,?,?,?)",
                "msg-" + suffix, "conv-" + suffix, "branch-" + suffix,
                "turn-" + suffix, "user", "执行拓展工具", now
        );
        jdbc.update(
                "INSERT INTO conversation_turn("
                        + "turn_id, conversation_id, branch_id,"
                        + " request_message_id, root_run_id, phase, version,"
                        + " started_at) VALUES (?,?,?,?,?,?,?,?)",
                "turn-" + suffix, "conv-" + suffix, "branch-" + suffix,
                "msg-" + suffix, "run-" + suffix, "running", 1, now
        );
        jdbc.update(
                "INSERT INTO agent_run("
                        + "run_id, conversation_id, branch_id, turn_id,"
                        + " root_run_id, kind, purpose, phase, version,"
                        + " started_at) VALUES (?,?,?,?,?,?,?,?,?,?)",
                "run-" + suffix, "conv-" + suffix, "branch-" + suffix,
                "turn-" + suffix, "run-" + suffix, "root", "执行拓展工具",
                "running", 1, now
        );
    }

    private record TestToolContext(Path workspaceRoot, String suffix)
            implements ToolContext {
        private TestToolContext(Path workspaceRoot) {
            this(workspaceRoot, "ext-test");
        }

        @Override
        public String conversationId() {
            return "conv-" + suffix;
        }

        @Override
        public String turnId() {
            return "turn-" + suffix;
        }

        @Override
        public String runId() {
            return "run-" + suffix;
        }

        @Override
        public String roundId() {
            return "round-" + suffix;
        }

        @Override
        public Path workspaceRoot() {
            return workspaceRoot;
        }

        @Override
        public boolean cancelled() {
            return false;
        }
    }
}
