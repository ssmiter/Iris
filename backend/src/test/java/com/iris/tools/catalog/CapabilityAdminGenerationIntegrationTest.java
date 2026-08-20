package com.iris.tools.catalog;

import com.iris.schedule.CronScheduleService;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.test.context.DynamicPropertyRegistry;
import org.springframework.test.context.DynamicPropertySource;

import java.io.IOException;
import java.nio.file.Files;
import java.nio.file.Path;

import static org.assertj.core.api.Assertions.assertThat;

/**
 * 能力目录 generation 协议端到端（docs/37 §2.5）：tree/items 携带 generation，
 * 目录变更后 generation 递增，内核工具 manifestHash 非空。
 */
@SpringBootTest
class CapabilityAdminGenerationIntegrationTest {

    private static final Path DATABASE = Path.of(
            "target", "test-data", "capability-admin-generation.db"
    ).toAbsolutePath();
    private static final Path WORKSPACE = Path.of(
            "target", "test-capability-admin-generation-workspace"
    ).toAbsolutePath();

    @Autowired
    private CapabilityAdminService capabilityAdmin;

    @Autowired
    private CronScheduleService schedules;

    @DynamicPropertySource
    static void testProperties(DynamicPropertyRegistry registry)
            throws IOException {
        Files.createDirectories(DATABASE.getParent());
        Files.deleteIfExists(DATABASE);
        Files.deleteIfExists(Path.of(DATABASE + "-wal"));
        Files.deleteIfExists(Path.of(DATABASE + "-shm"));
        Files.createDirectories(WORKSPACE);
        registry.add(
                "spring.datasource.url",
                () -> "jdbc:sqlite:" + DATABASE.toString().replace('\\', '/')
        );
        registry.add("iris.workspace", WORKSPACE::toString);
    }

    @Test
    void treeAndItemsCarryGenerationAndBumpsOnCatalogChange() {
        CapabilityAdminService.AdminTreeResponse beforeTree =
                capabilityAdmin.tree();
        CapabilityAdminService.AdminListing beforeItems =
                capabilityAdmin.items("/system/files", null, null);

        assertThat(beforeTree.root()).isNotNull();
        assertThat(beforeTree.root().path()).isEqualTo("/");
        assertThat(beforeTree.generation())
                .isEqualTo(beforeItems.generation());

        schedules.create(
                "generation-bump",
                "0 0 9 * * *",
                "generation bump fixture",
                true,
                false,
                "user"
        );

        CapabilityAdminService.AdminTreeResponse afterTree =
                capabilityAdmin.tree();
        CapabilityAdminService.AdminListing afterItems =
                capabilityAdmin.items("/system/files", null, null);

        assertThat(afterTree.generation())
                .isGreaterThan(beforeTree.generation());
        assertThat(afterItems.generation())
                .isEqualTo(afterTree.generation());
    }

    @Test
    void listFilesKernelToolManifestHashIsPresent() {
        CapabilityAdminService.AdminListing listing =
                capabilityAdmin.items("/system/files", null, null);

        var listFiles = listing.items().stream()
                .filter(item -> "list_files".equals(item.name()))
                .findFirst();

        assertThat(listFiles).isPresent();
        assertThat(listFiles.get().manifestHash()).isNotBlank();
    }
}
