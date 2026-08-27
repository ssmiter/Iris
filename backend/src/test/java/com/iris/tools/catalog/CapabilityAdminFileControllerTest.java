package com.iris.tools.catalog;

import com.iris.extension.ExtensionProviderService;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.autoconfigure.web.reactive.AutoConfigureWebTestClient;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.http.MediaType;
import org.springframework.test.context.DynamicPropertyRegistry;
import org.springframework.test.context.DynamicPropertySource;
import org.springframework.test.web.reactive.server.WebTestClient;

import java.io.IOException;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.List;

/**
 * 能力管理面文件操作与收藏 API 测试（docs/37 §2.3 / §2.4）。
 * 夹具使用临时拓展根与临时 SQLite；不写运行断言，仅提供覆盖。
 */
@SpringBootTest
@AutoConfigureWebTestClient
class CapabilityAdminFileControllerTest {

    private static final Path DATABASE = Path.of(
            "target", "test-data", "capability-admin-file.db"
    ).toAbsolutePath();
    private static final Path EXTENSION_ROOT = Path.of(
            "target", "test-capability-file-extensions"
    ).toAbsolutePath();

    @Autowired
    private WebTestClient client;

    @Autowired
    private ExtensionProviderService extensionProvider;

    @DynamicPropertySource
    static void testProperties(DynamicPropertyRegistry registry)
            throws IOException {
        Files.createDirectories(DATABASE.getParent());
        Files.deleteIfExists(DATABASE);
        Files.deleteIfExists(Path.of(DATABASE + "-wal"));
        Files.deleteIfExists(Path.of(DATABASE + "-shm"));

        registry.add("spring.datasource.url",
                () -> "jdbc:sqlite:" + DATABASE.toString().replace('\\', '/'));
        registry.add("iris.extension.roots[0]",
                EXTENSION_ROOT::toString);
    }

    @BeforeEach
    void resetFixtures() throws IOException {
        // 清空并重建拓展根夹具，保证各测试独立
        if (Files.exists(EXTENSION_ROOT)) {
            try (var walk = Files.walk(EXTENSION_ROOT)) {
                walk.sorted((a, b) -> -a.compareTo(b))
                        .forEach(path -> {
                            try {
                                Files.deleteIfExists(path);
                            } catch (IOException ignored) {
                            }
                        });
            }
        }
        Files.createDirectories(EXTENSION_ROOT);

        Path toolDir = EXTENSION_ROOT.resolve("code/python");
        Files.createDirectories(toolDir);
        Files.writeString(toolDir.resolve("wave3_sample_tool.tool.yml"), """
                name: wave3_sample_tool
                kind: template
                description: 执行 Python 分析
                input_schema:
                  type: object
                  properties:
                    script: { type: string, description: 要执行的 Python 脚本 }
                risk: { level: read_only, side_effect: none }
                runtime:
                  entry: [python, "{pluginDir}/analysis.py"]
                """);

        Path knowledgeDir = EXTENSION_ROOT.resolve("product/knowledge");
        Files.createDirectories(knowledgeDir);
        Files.writeString(knowledgeDir.resolve("getting-started.md"), """
                # 入门指南

                知识库正文。
                """);

        Path skillDir = EXTENSION_ROOT.resolve("skills/web-research");
        Files.createDirectories(skillDir.resolve("references"));
        Files.writeString(skillDir.resolve("SKILL.md"), """
                ---
                name: web-research
                description: 联网检索并归纳资料
                whenToUse: 需要查最新资料时
                ---
                # 联网研究

                先列问题再检索。
                """);

        extensionProvider.rescanRoot(EXTENSION_ROOT);
    }

    @Test
    void moveToolWithinExtensionRootUpdatesCapabilityPath() {
        client.post().uri("/api/v1/capability-admin/files/move")
                .contentType(MediaType.APPLICATION_JSON)
                .bodyValue(new CapabilityAdminFileController.MoveRequest(
                        "/code/python/wave3_sample_tool",
                        EXTENSION_ROOT.resolve("code").toString()
                ))
                .exchange()
                .expectStatus().isOk()
                .expectBody()
                .jsonPath("$.operation").isEqualTo("move")
                .jsonPath("$.affectedPaths[0]")
                .isEqualTo("/code/python/wave3_sample_tool")
                .jsonPath("$.affectedPaths[1]")
                .isEqualTo("/code/wave3_sample_tool");
    }

    @Test
    void renameToolSynchronizesManifestName() {
        client.post().uri("/api/v1/capability-admin/files/rename")
                .contentType(MediaType.APPLICATION_JSON)
                .bodyValue(new CapabilityAdminFileController.RenameRequest(
                        "/code/python/wave3_sample_tool",
                        "wave3_renamed_tool"
                ))
                .exchange()
                .expectStatus().isOk()
                .expectBody()
                .jsonPath("$.operation").isEqualTo("rename")
                .jsonPath("$.affectedPaths[1]")
                .isEqualTo("/code/python/wave3_renamed_tool");
    }

    @Test
    void copyToolCreatesCopyWithSuffix() {
        client.post().uri("/api/v1/capability-admin/files/copy")
                .contentType(MediaType.APPLICATION_JSON)
                .bodyValue(new CapabilityAdminFileController.CopyRequest(
                        "/code/python/wave3_sample_tool",
                        EXTENSION_ROOT.resolve("code/python").toString()
                ))
                .exchange()
                .expectStatus().isOk()
                .expectBody()
                .jsonPath("$.operation").isEqualTo("copy")
                .jsonPath("$.affectedPaths[0]")
                .isEqualTo("/code/python/wave3_sample_tool_copy");
    }

    @Test
    void conflictReturnsStructured409() {
        client.post().uri("/api/v1/capability-admin/files/copy")
                .contentType(MediaType.APPLICATION_JSON)
                .bodyValue(new CapabilityAdminFileController.CopyRequest(
                        "/code/python/wave3_sample_tool",
                        EXTENSION_ROOT.resolve("code/python").toString()
                ))
                .exchange();

        client.post().uri("/api/v1/capability-admin/files/copy")
                .contentType(MediaType.APPLICATION_JSON)
                .bodyValue(new CapabilityAdminFileController.CopyRequest(
                        "/code/python/wave3_sample_tool",
                        EXTENSION_ROOT.resolve("code/python").toString()
                ))
                .exchange()
                .expectStatus().isEqualTo(409)
                .expectBody()
                .jsonPath("$.code").isEqualTo("already_exists");
    }

    @Test
    void outOfBoundsPathReturnsForbidden() {
        client.post().uri("/api/v1/capability-admin/files/delete")
                .contentType(MediaType.APPLICATION_JSON)
                .bodyValue(new CapabilityAdminFileController.DeleteRequest(
                        "C:/Windows/notepad.exe"
                ))
                .exchange()
                .expectStatus().isForbidden()
                .expectBody()
                .jsonPath("$.code").isEqualTo("out_of_extension_root");
    }

    @Test
    void kernelPathReturnsUnprocessable() {
        client.post().uri("/api/v1/capability-admin/files/delete")
                .contentType(MediaType.APPLICATION_JSON)
                .bodyValue(new CapabilityAdminFileController.DeleteRequest(
                        "/system/time/current_time"
                ))
                .exchange()
                .expectStatus().isEqualTo(422)
                .expectBody()
                .jsonPath("$.code").isEqualTo("not_file_truth");
    }

    @Test
    void deleteToolRemovesManifest() {
        client.post().uri("/api/v1/capability-admin/files/delete")
                .contentType(MediaType.APPLICATION_JSON)
                .bodyValue(new CapabilityAdminFileController.DeleteRequest(
                        "/code/python/wave3_sample_tool"
                ))
                .exchange()
                .expectStatus().isOk()
                .expectBody()
                .jsonPath("$.operation").isEqualTo("delete")
                .jsonPath("$.affectedPaths[0]")
                .isEqualTo("/code/python/wave3_sample_tool");
    }

    @Test
    void pinsPutGetRoundTrip() {
        client.put().uri("/api/v1/capability-admin/pins")
                .contentType(MediaType.APPLICATION_JSON)
                .bodyValue(new CapabilityAdminFileController.ReplacePinsRequest(
                        List.of(
                                "/code/python/wave3_sample_tool",
                                "/product/knowledge/getting_started",
                                "/skills/web_research"
                        )
                ))
                .exchange()
                .expectStatus().isOk()
                .expectBody()
                .jsonPath("$.pins.length()").isEqualTo(3)
                .jsonPath("$.pins[0].path")
                .isEqualTo("/code/python/wave3_sample_tool")
                .jsonPath("$.pins[0].ordinal").isEqualTo(0);

        client.get().uri("/api/v1/capability-admin/pins")
                .exchange()
                .expectStatus().isOk()
                .expectBody()
                .jsonPath("$.pins.length()").isEqualTo(3)
                .jsonPath("$.pins[2].path")
                .isEqualTo("/skills/web_research")
                .jsonPath("$.pins[2].ordinal").isEqualTo(2);
    }
}
