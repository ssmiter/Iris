package com.iris.conversation.application;

import com.iris.agent.model.ModelAttemptRepository;
import com.iris.agent.model.ModelAttemptRepository.RoundToolCall;
import com.iris.agent.run.AgentRunLauncher;
import com.iris.agent.run.ToolProjectionService;
import com.iris.agent.pipeline.PipelineRunLauncher;
import com.iris.agent.pipeline.PipelineRunRepository;
import com.iris.conversation.domain.ApiProblemException;
import com.iris.conversation.domain.ApprovalCommands.ApprovalDecisionResponse;
import com.iris.conversation.domain.ApprovalCommands.DecideApprovalRequest;
import com.iris.conversation.domain.ApprovalCommands.Decision;
import com.iris.tools.core.ToolContext;
import com.iris.tools.core.ToolExecutionViews.ApprovalDecision;
import com.iris.tools.core.ToolExecutionViews.RuntimeResult;
import com.iris.tools.core.ToolRuntime;
import com.iris.tools.core.ToolRuntimeException;
import com.iris.tools.core.ToolRuntimeRepository;
import com.iris.tools.core.ToolRuntimeRepository.ExecutionContextRow;
import com.iris.workspace.WorkspaceService;
import org.springframework.http.HttpStatus;
import org.springframework.stereotype.Service;

import java.nio.file.Path;
import java.util.Map;

/**
 * 审批决定的应用层入口：决议、投影和 Run 唤醒在这里收敛，
 * Controller 不得直接驱动 Tool 或 Round。
 */
@Service
public class ApprovalCommandService {
    private final ToolRuntime runtime;
    private final ToolRuntimeRepository toolFacts;
    private final ModelAttemptRepository modelFacts;
    private final ToolProjectionService projections;
    private final AgentRunLauncher runs;
    private final PipelineRunLauncher pipelineRuns;
    private final PipelineRunRepository pipelines;
    private final WorkspaceService workspace;

    public ApprovalCommandService(
            ToolRuntime runtime,
            ToolRuntimeRepository toolFacts,
            ModelAttemptRepository modelFacts,
            ToolProjectionService projections,
            AgentRunLauncher runs,
            PipelineRunLauncher pipelineRuns,
            PipelineRunRepository pipelines,
            WorkspaceService workspace
    ) {
        this.runtime = runtime;
        this.toolFacts = toolFacts;
        this.modelFacts = modelFacts;
        this.projections = projections;
        this.runs = runs;
        this.pipelineRuns = pipelineRuns;
        this.pipelines = pipelines;
        this.workspace = workspace;
    }

    public ApprovalDecisionResponse decide(
            String approvalId,
            String idempotencyKey,
            DecideApprovalRequest request
    ) {
        if (idempotencyKey == null || idempotencyKey.isBlank()) {
            throw problem(
                    HttpStatus.BAD_REQUEST,
                    "invalid_request",
                    "validation",
                    "缺少 Idempotency-Key。",
                    Map.of()
            );
        }
        if (request.expectedVersion() < 1) {
            throw problem(
                    HttpStatus.BAD_REQUEST,
                    "invalid_request",
                    "validation",
                    "expectedVersion 必须为正数。",
                    Map.of()
            );
        }
        ExecutionContextRow execution = toolFacts
                .executionContextForApproval(approvalId)
                .orElseThrow(() -> problem(
                        HttpStatus.NOT_FOUND,
                        "approval_not_found",
                        "not_found",
                        "找不到这条审批请求。",
                        Map.of("approvalId", approvalId)
                ));
        RoundToolCall call = execution.roundId() == null
                ? null : modelFacts
                        .roundToolCalls(execution.roundId())
                        .stream()
                        .filter(candidate -> candidate.toolCallId().equals(
                                execution.toolCallId()
                        ))
                        .findFirst()
                        .orElseThrow(() -> new IllegalStateException(
                                "Approval has no canonical Model ToolCall"
                        ));

        RuntimeResult result;
        try {
            result = runtime.decideApproval(
                    new ApprovalDecision(
                            approvalId,
                            idempotencyKey,
                            request.operationSnapshotHash(),
                            request.expectedVersion(),
                            request.decision() == Decision.approve,
                            "local-user"
                    ),
                    new ApprovalToolContext(
                            execution.conversationId(),
                            execution.turnId(),
                            execution.runId(),
                            execution.roundId(),
                            workspace.root(),
                            false
                    )
            );
        } catch (ToolRuntimeException exception) {
            throw mapRuntimeProblem(exception, approvalId);
        }

        boolean resumeRequested;
        if (execution.roundId() == null) {
            String stepRunId = pipelines
                    .waitingPipelineForExecution(result.executionId())
                    .orElseThrow(() -> new IllegalStateException(
                            "Approval has no waiting Pipeline step"
                    ));
            projections.projectPipeline(
                    execution.runId(),
                    stepRunId,
                    com.fasterxml.jackson.databind.node.NullNode.getInstance(),
                    result
            );
            resumeRequested = result.terminal()
                    && pipelineRuns.launch(execution.runId());
        } else {
            projections.project(execution.roundId(), call, result);
            resumeRequested = result.terminal()
                    && runs.resume(execution.runId());
        }
        return new ApprovalDecisionResponse(
                approvalId,
                result.executionId(),
                result.toolCallId(),
                result.phase(),
                request.decision() == Decision.approve,
                resumeRequested,
                result.version(),
                result.updatedAt()
        );
    }

    private ApiProblemException mapRuntimeProblem(
            ToolRuntimeException exception,
            String approvalId
    ) {
        return switch (exception.code()) {
            case "approval_not_found" -> problem(
                    HttpStatus.NOT_FOUND,
                    "approval_not_found",
                    "not_found",
                    exception.getMessage(),
                    Map.of("approvalId", approvalId)
            );
            case "approval_precondition_failed" -> problem(
                    HttpStatus.PRECONDITION_FAILED,
                    "approval_stale",
                    "precondition",
                    exception.getMessage(),
                    Map.of("approvalId", approvalId)
            );
            case "approval_already_resolved" -> problem(
                    HttpStatus.CONFLICT,
                    "approval_already_decided",
                    "conflict",
                    exception.getMessage(),
                    Map.of("approvalId", approvalId)
            );
            default -> problem(
                    HttpStatus.UNPROCESSABLE_ENTITY,
                    exception.code(),
                    "tool_runtime",
                    exception.getMessage(),
                    Map.of("approvalId", approvalId)
            );
        };
    }

    private ApiProblemException problem(
            HttpStatus status,
            String code,
            String category,
            String detail,
            Map<String, Object> context
    ) {
        return new ApiProblemException(
                status,
                code,
                category,
                detail,
                context
        );
    }

    private record ApprovalToolContext(
            String conversationId,
            String turnId,
            String runId,
            String roundId,
            Path workspaceRoot,
            boolean cancelled
    ) implements ToolContext {
    }
}
