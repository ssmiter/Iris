package com.iris.agent.model;

import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.node.ObjectNode;
import com.iris.agent.model.ModelContextWindowPlanner.ContextBudget;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.extension.ExtendWith;
import org.mockito.Mock;
import org.mockito.junit.jupiter.MockitoExtension;

import java.util.List;
import java.util.Set;

import static org.assertj.core.api.Assertions.assertThat;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.Mockito.when;

@ExtendWith(MockitoExtension.class)
class ModelContextWindowPlannerDropPriorityTest {

    private static final String SYSTEM = "test instruction";
    private static final List<ModelRequest.ToolDefinition> TOOLS = List.of();

    @Mock
    private ModelTokenEstimator tokens;

    private ModelContextWindowPlanner planner() {
        when(tokens.estimateText(SYSTEM)).thenReturn(10);
        // estimate(TOOLS) 由各测试在兜底 stub 之后重打，这里不打
        return new ModelContextWindowPlanner(tokens);
    }

    private void fallbackListEstimate(int value) {
        when(tokens.estimate(any(List.class))).thenReturn(value);
    }

    @Test
    void dropsToolObservationTrajectoryBeforeArtifactIndex() {
        String messageId = "msg_1";
        ModelInputItem.UserText userMessage = new ModelInputItem.UserText(
                messageId,
                "hello"
        );
        ModelInputItem.AssistantToolCall toolCall =
                new ModelInputItem.AssistantToolCall(
                        "attempt_old",
                        "tc_old",
                        "pc_old",
                        "test_tool",
                        argumentsOf("old-arg")
                );
        ModelInputItem.ToolResult toolObservation =
                new ModelInputItem.ToolResult(
                        "attempt_old",
                        "obs_old",
                        "tc_old",
                        "pc_old",
                        "exec_old",
                        "success",
                        "hash_old",
                        "payload_old",
                        new ObjectMapper().createObjectNode()
                                .put("result", "old-result")
                );
        ModelInputItem.ArtifactContextIndex artifactIndex =
                new ModelInputItem.ArtifactContextIndex("[artifact]");

        List<ModelInputItem> facts = List.of(
                userMessage,
                toolCall,
                toolObservation,
                artifactIndex
        );

        // fixed = 10 (system) + 0 (tools) + 1 (reserved) + 512 (headroom) = 523
        ModelContextWindowPlanner planner = planner();
        // 兜底 stub 必须先打：Mockito 后打覆盖先打，any(List) 会吞掉精确 stub
        fallbackListEstimate(30);
        // any(List) 连空工具表也吞了，重新钉回 0（fixed 成本的一部分）
        when(tokens.estimate(TOOLS)).thenReturn(0);
        when(tokens.estimate(List.of(userMessage))).thenReturn(300);
        when(tokens.estimate(List.of(toolCall, toolObservation))).thenReturn(400);
        when(tokens.estimate(List.of(artifactIndex))).thenReturn(200);

        // fixed = 523; available = 501
        // required user = 300; trajectory = 400 does not fit; artifact = 200 fits
        ContextBudget budget = new ContextBudget(1024, 1);
        ModelContextWindowPlanner.WindowPlan plan = planner.plan(
                SYSTEM,
                facts,
                TOOLS,
                budget,
                Set.of(messageId),
                Set.of()
        );

        assertThat(plan.items())
                .anyMatch(ModelInputItem.ArtifactContextIndex.class::isInstance)
                .anyMatch(ModelInputItem.UserText.class::isInstance)
                .noneMatch(item -> item instanceof ModelInputItem.ToolResult)
                .noneMatch(item -> item instanceof ModelInputItem.AssistantToolCall);
        assertThat(plan.droppedFactCount()).isEqualTo(2);
    }

    @Test
    void keepsStaticAndRequiredItemsWhenDroppingDynamic() {
        String messageId = "msg_2";
        ModelInputItem.SkillDirectoryRoster roster =
                new ModelInputItem.SkillDirectoryRoster("- /skills/personal/x");
        ModelInputItem.UserText userMessage = new ModelInputItem.UserText(
                messageId,
                "hello"
        );
        ModelInputItem.ArtifactContextIndex artifactIndex =
                new ModelInputItem.ArtifactContextIndex("[artifact]");

        List<ModelInputItem> facts = List.of(
                roster,
                userMessage,
                artifactIndex
        );

        ModelContextWindowPlanner planner = planner();
        fallbackListEstimate(30);
        when(tokens.estimate(TOOLS)).thenReturn(0);
        when(tokens.estimate(List.of(roster))).thenReturn(250);
        when(tokens.estimate(List.of(userMessage))).thenReturn(250);
        when(tokens.estimate(List.of(artifactIndex))).thenReturn(200);

        // fixed = 523; available = 501
        // required static roster + user = 500; artifact = 200 does not fit
        ContextBudget budget = new ContextBudget(1024, 1);

        ModelContextWindowPlanner.WindowPlan plan = planner.plan(
                SYSTEM,
                facts,
                TOOLS,
                budget,
                Set.of(messageId),
                Set.of()
        );

        assertThat(plan.items())
                .anyMatch(ModelInputItem.SkillDirectoryRoster.class::isInstance)
                .anyMatch(ModelInputItem.UserText.class::isInstance)
                .noneMatch(ModelInputItem.ArtifactContextIndex.class::isInstance);
        assertThat(plan.droppedFactCount()).isEqualTo(1);
    }

    private ObjectNode argumentsOf(String value) {
        return new ObjectMapper().createObjectNode().put("arg", value);
    }
}
