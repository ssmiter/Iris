package com.iris.agent.model;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.iris.extension.SkillDefinition;
import com.iris.extension.SkillTool;
import com.iris.tools.catalog.CapabilityCatalogSource;
import com.iris.tools.core.CapabilityAvailability;
import com.iris.tools.core.CapabilityAvailabilityService;
import com.iris.tools.core.RiskLevel;
import com.iris.tools.core.ToolManifest;
import com.iris.tools.core.ToolRegistry;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.extension.ExtendWith;
import org.mockito.Mock;
import org.mockito.junit.jupiter.MockitoExtension;

import java.nio.file.Path;
import java.time.Instant;
import java.util.List;

import static org.assertj.core.api.Assertions.assertThat;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.Mockito.when;

@ExtendWith(MockitoExtension.class)
class SkillRosterServiceTest {

    private static final ObjectMapper OBJECT_MAPPER = new ObjectMapper();

    @Mock
    private ToolRegistry registry;
    @Mock
    private CapabilityAvailabilityService availability;
    @Mock
    private CapabilityCatalogSource catalogSource;

    private SkillRosterService service() {
        return new SkillRosterService(registry, availability, List.of(catalogSource));
    }

    @Test
    void returnsNullWhenNoSkillAvailable() {
        when(catalogSource.definitions()).thenReturn(List.of());
        when(registry.all()).thenReturn(List.of());

        assertThat(service().build()).isNull();
    }

    @Test
    void includesKernelSkillAndFileProjectionAndSortsByPath() {
        when(catalogSource.definitions()).thenReturn(List.of(
                skillDefinition(
                        "/skills/personal/zz_skill",
                        "zz_skill",
                        "Zeta skill"
                ),
                skillDefinition(
                        "/skills/personal/aa_skill",
                        "aa_skill",
                        "Alpha skill"
                )
        ));
        ToolRegistry.ToolBinding fileSkill = skillToolBinding(
                "/industry/mes/test_skill",
                "test_skill",
                "Test skill from SKILL.md"
        );
        when(registry.all()).thenReturn(List.of(fileSkill));
        when(availability.current(fileSkill))
                .thenReturn(available());

        ModelInputItem.SkillDirectoryRoster roster = service().build();

        assertThat(roster).isNotNull();
        assertThat(roster.content()).containsSubsequence(
                "/industry/mes/test_skill",
                "/skills/personal/aa_skill",
                "/skills/personal/zz_skill"
        );
    }

    @Test
    void truncatesSingleEntryToTwoHundredAndFiftyCharacters() {
        String longDescription = "x".repeat(400);
        when(catalogSource.definitions()).thenReturn(List.of(
                skillDefinition(
                        "/skills/personal/long_skill",
                        "long_skill",
                        longDescription
                )
        ));
        when(registry.all()).thenReturn(List.of());

        ModelInputItem.SkillDirectoryRoster roster = service().build();

        assertThat(roster).isNotNull();
        String[] lines = roster.content().split("\n");
        String entryLine = lines[1];
        assertThat(entryLine).hasSizeLessThanOrEqualTo(250);
        assertThat(entryLine).endsWith("…");
    }

    @Test
    void omitsUnavailableSkills() {
        when(catalogSource.definitions()).thenReturn(List.of(
                new CapabilityCatalogSource.Definition(
                        "s1", "1", "skill", "unavailable_skill",
                        "/skills/personal/unavailable_skill",
                        "Not available", "read_only",
                        "unavailable", "Disabled by user",
                        hash64(), OBJECT_MAPPER.createObjectNode()
                )
        ));
        ToolRegistry.ToolBinding degradedSkill = skillToolBinding(
                "/skills/personal/degraded_skill",
                "degraded_skill",
                "Degraded"
        );
        when(registry.all()).thenReturn(List.of(degradedSkill));
        when(availability.current(degradedSkill))
                .thenReturn(new CapabilityAvailability(
                        CapabilityAvailability.Status.DEGRADED,
                        "limited",
                        Instant.now()
                ));

        assertThat(service().build()).isNull();
    }

    @Test
    void marksOverflowWhenTotalBudgetExhausted() {
        List<CapabilityCatalogSource.Definition> definitions =
                new java.util.ArrayList<>();
        for (int index = 0; index < 200; index++) {
            String name = String.format("skill_%03d", index);
            definitions.add(skillDefinition(
                    "/skills/personal/" + name,
                    name,
                    "A moderately long description that consumes budget."
            ));
        }
        when(catalogSource.definitions()).thenReturn(definitions);
        when(registry.all()).thenReturn(List.of());

        ModelInputItem.SkillDirectoryRoster roster = service().build();

        assertThat(roster).isNotNull();
        assertThat(roster.content()).contains("还有更多技能");
        long entryLines = roster.content().lines()
                .filter(line -> line.startsWith("- "))
                .count();
        assertThat(entryLines).isGreaterThan(0).isLessThan(200);
    }

    private CapabilityCatalogSource.Definition skillDefinition(
            String path,
            String name,
            String description
    ) {
        return new CapabilityCatalogSource.Definition(
                "id_" + name, "1", "skill", name, path,
                description, "read_only", "available", "Skill available",
                hash64(), OBJECT_MAPPER.createObjectNode()
        );
    }

    private ToolRegistry.ToolBinding skillToolBinding(
            String capabilityPath,
            String name,
            String description
    ) {
        SkillDefinition definition = new SkillDefinition(
                name.replace('_', '-'),
                description,
                null,
                null,
                false,
                false
        );
        SkillTool tool = new SkillTool(
                Path.of("target", "test-skill", name + ".SKILL.md"),
                null,
                name,
                definition,
                capabilityPath,
                "v1",
                OBJECT_MAPPER
        );
        return new ToolRegistry.ToolBinding(
                manifest(name, description),
                capabilityPath.substring(0, capabilityPath.lastIndexOf('/')),
                capabilityPath,
                hash64(),
                tool
        );
    }

    private ToolManifest manifest(String name, String description) {
        return new ToolManifest(
                "extension.skill." + name,
                "1",
                name,
                description,
                OBJECT_MAPPER.createObjectNode().put("type", "object"),
                OBJECT_MAPPER.createObjectNode().put("type", "object"),
                RiskLevel.READ_ONLY,
                ToolManifest.SideEffect.NONE,
                5,
                10_000,
                ToolManifest.IdempotencySemantics.IDEMPOTENT,
                ToolManifest.EvidencePolicy.SUMMARY
        );
    }

    private CapabilityAvailability available() {
        return new CapabilityAvailability(
                CapabilityAvailability.Status.AVAILABLE,
                "ok",
                Instant.now()
        );
    }

    private String hash64() {
        return "0".repeat(64);
    }
}
