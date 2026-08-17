package com.iris.extension;

import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.node.ObjectNode;
import com.iris.tools.core.CommittedOperation;
import com.iris.tools.core.ToolContext;
import com.iris.tools.core.ToolOutcome;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;

import java.io.IOException;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.List;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertTrue;

/**
 * 技能加载原语（docs/31 §5.1）：正文/资源清单/束内读取/路径围栏。
 */
class SkillToolTest {

    private final ObjectMapper mapper = new ObjectMapper();
    private final ToolContext context = new StubContext();

    @TempDir
    Path bundle;

    @Test
    void returnsBodyAndResourceListingOnBareInvoke() throws IOException {
        Files.writeString(bundle.resolve("SKILL.md"), """
                ---
                name: web-research
                description: 联网检索并归纳资料
                whenToUse: 需要查最新资料时
                ---
                # 联网研究

                先列问题再检索。
                """);
        Files.createDirectories(bundle.resolve("references"));
        Files.writeString(bundle.resolve("references/sources.md"),
                "# 来源清单\n");

        SkillTool tool = skillTool(bundle.resolve("SKILL.md"), bundle);
        ToolOutcome outcome = tool.execute(operation(null), context);

        assertEquals(ToolOutcome.Kind.SUCCEEDED, outcome.kind());
        assertEquals("/skills/web-research",
                outcome.output().path("path").asText());
        assertEquals("联网检索并归纳资料",
                outcome.output().path("description").asText());
        assertEquals("需要查最新资料时",
                outcome.output().path("when_to_use").asText());
        assertTrue(outcome.output().path("content").asText()
                .contains("先列问题再检索"));
        // 正文不含 frontmatter
        assertTrue(!outcome.output().path("content").asText()
                .contains("web-research"));
        // 资源清单含束内文件、不含 SKILL.md 自身
        String resources = outcome.output().path("resources").toString();
        assertTrue(resources.contains("sources.md"), () -> resources);
        assertTrue(!resources.contains("SKILL.md"), () -> resources);
    }

    @Test
    void readsBundleResourceByRelativePath() throws IOException {
        Files.writeString(bundle.resolve("SKILL.md"), """
                ---
                name: web-research
                description: 联网检索并归纳资料
                ---
                正文
                """);
        Files.createDirectories(bundle.resolve("scripts"));
        Files.writeString(bundle.resolve("scripts/fetch.sh"), "#!/bin/sh\n");

        SkillTool tool = skillTool(bundle.resolve("SKILL.md"), bundle);
        ToolOutcome outcome = tool.execute(operation("scripts/fetch.sh"), context);

        assertEquals(ToolOutcome.Kind.SUCCEEDED, outcome.kind());
        assertTrue(outcome.output().path("content").asText()
                .contains("#!/bin/sh"));
    }

    @Test
    void fencesResourcePathToBundleAndRejectsEscape() throws IOException {
        Files.writeString(bundle.resolve("SKILL.md"), """
                ---
                name: web-research
                description: 联网检索并归纳资料
                ---
                正文
                """);
        Files.writeString(bundle.getParent().resolve("secret.txt"),
                "束外内容");

        SkillTool tool = skillTool(bundle.resolve("SKILL.md"), bundle);
        ToolOutcome escape = tool.execute(operation("../secret.txt"), context);
        ToolOutcome missing = tool.execute(
                operation("references/absent.md"), context);

        assertEquals(ToolOutcome.Kind.FAILED, escape.kind());
        assertEquals("skill_resource_forbidden", escape.errorCode());
        assertEquals(ToolOutcome.Kind.FAILED, missing.kind());
        assertEquals("skill_resource_not_found", missing.errorCode());
    }

    @Test
    void flatSkillHasNoBundleResources() throws IOException {
        Path flat = bundle.resolve("summarize.SKILL.md");
        Files.writeString(flat, """
                ---
                name: summarize
                description: 归纳长文为要点
                ---
                正文
                """);

        SkillTool tool = skillTool(flat, null);
        ToolOutcome body = tool.execute(operation(null), context);
        ToolOutcome resource = tool.execute(operation("anything.md"), context);

        assertEquals(ToolOutcome.Kind.SUCCEEDED, body.kind());
        assertEquals(0, body.output().path("resources").size());
        assertEquals(ToolOutcome.Kind.FAILED, resource.kind());
        assertEquals("skill_resource_unavailable", resource.errorCode());
    }

    private SkillTool skillTool(Path file, Path bundleDir) {
        SkillDefinition definition = new SkillDefinition(
                "web-research", "联网检索并归纳资料", "需要查最新资料时",
                null, null, null);
        return new SkillTool(
                file, bundleDir, "web_research", definition,
                "/skills/web-research", "0123456789abcdef", mapper
        );
    }

    private CommittedOperation operation(String resource) {
        ObjectNode input = mapper.createObjectNode();
        if (resource != null) {
            input.put("resource", resource);
        }
        return new CommittedOperation(
                "exec-1", "snap-1", "hash-1", input, List.of());
    }

    private static final class StubContext implements ToolContext {
        @Override
        public String conversationId() {
            return "conv-skill";
        }

        @Override
        public String turnId() {
            return "turn-skill";
        }

        @Override
        public String runId() {
            return "run-skill";
        }

        @Override
        public String roundId() {
            return "round-skill";
        }

        @Override
        public Path workspaceRoot() {
            return Path.of(".");
        }

        @Override
        public boolean cancelled() {
            return false;
        }
    }
}
