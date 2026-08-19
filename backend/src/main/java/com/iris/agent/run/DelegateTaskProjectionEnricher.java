package com.iris.agent.run;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.node.ObjectNode;
import com.iris.tools.core.ToolExecutionViews.RuntimeResult;
import com.iris.tools.core.ToolRuntimeRepository;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.jdbc.core.simple.JdbcClient;
import org.springframework.stereotype.Component;

/**
 * Presents a {@code delegate_task} tool call as a {@code run} render node.
 *
 * <p>The pipeline Run returned by {@link com.iris.tools.system.agents.DelegateTaskTool}
 * becomes the {@code childRunId}; the node's status tracks the pipeline phase so
 * the ChildRunCard reflects accepted/queued, running, and terminal states. The
 * progress summary is derived from the delegated task text stored in the
 * pipeline input.
 */
@Component
public class DelegateTaskProjectionEnricher implements ToolProjectionEnricher {
    private static final Logger LOGGER = LoggerFactory.getLogger(
            DelegateTaskProjectionEnricher.class
    );

    private static final String TOOL_NAME = "delegate_task";
    private static final int LABEL_MAX_LENGTH = 40;

    private final JdbcClient jdbc;
    private final ToolRuntimeRepository toolFacts;
    private final ObjectMapper objectMapper;

    public DelegateTaskProjectionEnricher(
            JdbcClient jdbc,
            ToolRuntimeRepository toolFacts,
            ObjectMapper objectMapper
    ) {
        this.jdbc = jdbc;
        this.toolFacts = toolFacts;
        this.objectMapper = objectMapper;
    }

    @Override
    public boolean supports(String toolName) {
        return TOOL_NAME.equals(toolName);
    }

    @Override
    public void enrich(
            ObjectNode projection,
            String conversationId,
            RuntimeResult result
    ) {
        String outputJson = toolFacts.outputJson(result.executionId())
                .orElse(null);
        if (outputJson == null || outputJson.isBlank()) {
            LOGGER.warn(
                    "delegate_task projection has no output; keeping tool node: {}",
                    result.executionId()
            );
            return;
        }

        JsonNode output;
        try {
            output = objectMapper.readTree(outputJson);
        } catch (com.fasterxml.jackson.core.JsonProcessingException exception) {
            LOGGER.warn(
                    "delegate_task output is not valid JSON: {}",
                    result.executionId(),
                    exception
            );
            return;
        }

        String childRunId = output.path("pipelineRunId").asText("").trim();
        if (childRunId.isBlank()) {
            LOGGER.warn(
                    "delegate_task output missing pipelineRunId: {}",
                    result.executionId()
            );
            return;
        }

        ChildRunSnapshot child = childRunSnapshot(childRunId);
        if (child == null) {
            LOGGER.warn(
                    "delegate_task child run not found: {}",
                    childRunId
            );
            return;
        }

        projection.put("type", "run");
        projection.put("childRunId", childRunId);
        projection.put("status", child.phase());
        projection.put("label", label(child.taskText()));
        projection.put(
                "progressSummary",
                progressSummary(child.phase(), child.taskText())
        );

        // Keep tool traceability fields even though the renderer ignores them.
        projection.put("toolCallId", result.toolCallId());
        projection.put("toolExecutionId", result.executionId());
        projection.put("toolName", result.toolName());
        if (result.message() != null && !result.message().isBlank()) {
            projection.put("evidenceSummary", result.message());
        }
    }

    private ChildRunSnapshot childRunSnapshot(String childRunId) {
        return jdbc.sql("""
                SELECT r.phase, p.input_json
                FROM agent_run r
                JOIN pipeline_run_input p ON p.run_id = r.run_id
                WHERE r.run_id = :childRunId
                """)
                .param("childRunId", childRunId)
                .query((rs, rowNum) -> {
                    String phase = rs.getString("phase");
                    String inputJson = rs.getString("input_json");
                    String taskText = taskTextFromPipelineInput(inputJson);
                    return new ChildRunSnapshot(phase, taskText);
                })
                .optional()
                .orElse(null);
    }

    private String taskTextFromPipelineInput(String inputJson) {
        if (inputJson == null || inputJson.isBlank()) {
            return "后台子任务";
        }
        try {
            JsonNode input = objectMapper.readTree(inputJson);
            String task = input.path("task").asText("").trim();
            if (!task.isBlank()) {
                return task;
            }
        } catch (com.fasterxml.jackson.core.JsonProcessingException exception) {
            LOGGER.warn("Pipeline input is not valid JSON", exception);
        }
        return "后台子任务";
    }

    private String label(String taskText) {
        if (taskText == null || taskText.isBlank()) {
            return "子任务";
        }
        String firstLine = taskText.split("\\R", 2)[0].trim();
        if (firstLine.length() <= LABEL_MAX_LENGTH) {
            return firstLine;
        }
        return firstLine.substring(0, LABEL_MAX_LENGTH - 1) + "…";
    }

    private String progressSummary(String phase, String taskText) {
        if ("accepted".equals(phase)) {
            return "子任务已排队，等待启动：" + taskText;
        }
        return taskText;
    }

    private record ChildRunSnapshot(String phase, String taskText) {
    }
}
