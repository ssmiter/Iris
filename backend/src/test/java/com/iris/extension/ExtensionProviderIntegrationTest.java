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
     * tool_execution 的外键要求真实的会话/轮次/Run 行存在
     * （schema.sql tool_execution 的三条 REFERENCES）——直接落最小父行链，
     * 不绕过 Runtime 本身。
     */
    private void seedExecutionParents() {
        String now = Instant.now().toString();
        jdbc.update(
                "INSERT INTO iris_conversation("
                        + "conversation_id, root_branch_id, title, version,"
                        + " created_at, updated_at) VALUES (?,?,?,?,?,?)",
                "conv-ext-test", "branch-ext-test", "拓展集成测试", 1, now, now
        );
        jdbc.update(
                "INSERT INTO conversation_branch("
                        + "branch_id, conversation_id, status, version,"
                        + " created_at) VALUES (?,?,?,?,?)",
                "branch-ext-test", "conv-ext-test", "active", 1, now
        );
        jdbc.update(
                "INSERT INTO message("
                        + "message_id, conversation_id, branch_id, turn_id,"
                        + " role, content, created_at) VALUES (?,?,?,?,?,?,?)",
                "msg-ext-test", "conv-ext-test", "branch-ext-test",
                "turn-ext-test", "user", "执行拓展工具", now
        );
        jdbc.update(
                "INSERT INTO conversation_turn("
                        + "turn_id, conversation_id, branch_id,"
                        + " request_message_id, root_run_id, phase, version,"
                        + " started_at) VALUES (?,?,?,?,?,?,?,?)",
                "turn-ext-test", "conv-ext-test", "branch-ext-test",
                "msg-ext-test", "run-ext-test", "running", 1, now
        );
        jdbc.update(
                "INSERT INTO agent_run("
                        + "run_id, conversation_id, branch_id, turn_id,"
                        + " root_run_id, kind, purpose, phase, version,"
                        + " started_at) VALUES (?,?,?,?,?,?,?,?,?,?)",
                "run-ext-test", "conv-ext-test", "branch-ext-test",
                "turn-ext-test", "run-ext-test", "root", "执行拓展工具",
                "running", 1, now
        );
    }

    private record TestToolContext(Path workspaceRoot)
            implements ToolContext {
        @Override
        public String conversationId() {
            return "conv-ext-test";
        }

        @Override
        public String turnId() {
            return "turn-ext-test";
        }

        @Override
        public String runId() {
            return "run-ext-test";
        }

        @Override
        public String roundId() {
            return "round-ext-test";
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
