package com.iris.conversation.application;

import com.iris.agent.model.ModelAttemptRepository;
import com.iris.agent.model.ModelAttemptRepository.RoundToolCall;
import com.iris.agent.run.AgentRunLauncher;
import com.iris.agent.run.ToolProjectionService;
import com.iris.conversation.domain.ApiProblemException;
import com.iris.conversation.domain.AttentionCommands.AttentionResponse;
import com.iris.conversation.domain.AttentionCommands.RespondAttentionRequest;
import com.iris.tools.core.ToolContext;
import com.iris.tools.core.ToolExecutionViews.RuntimeResult;
import com.iris.tools.core.ToolExecutionViews.UserInputDecision;
import com.iris.tools.core.ToolRuntime;
import com.iris.tools.core.ToolRuntimeException;
import com.iris.tools.core.ToolRuntimeRepository;
import com.iris.tools.core.ToolRuntimeRepository.UserInputExecutionContextRow;
import com.iris.workspace.WorkspaceService;
import org.springframework.http.HttpStatus;
import org.springframework.stereotype.Service;

import java.nio.file.Path;
import java.util.Map;

/** Resolves non-approval Attention through the original durable ToolCall. */
@Service
public class AttentionCommandService {
    private final ToolRuntime runtime;
    private final ToolRuntimeRepository toolFacts;
    private final ModelAttemptRepository modelFacts;
    private final ToolProjectionService projections;
    private final AgentRunLauncher runs;
    private final WorkspaceService workspace;

    public AttentionCommandService(
            ToolRuntime runtime,
            ToolRuntimeRepository toolFacts,
            ModelAttemptRepository modelFacts,
            ToolProjectionService projections,
            AgentRunLauncher runs,
            WorkspaceService workspace
    ) {
        this.runtime = runtime;
        this.toolFacts = toolFacts;
        this.modelFacts = modelFacts;
        this.projections = projections;
        this.runs = runs;
        this.workspace = workspace;
    }

    public AttentionResponse respond(
            String attentionId,
            String idempotencyKey,
            RespondAttentionRequest request
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
        if (request.expectedVersion() < 1
                || !"clarification_answer".equals(request.kind())) {
            throw problem(
                    HttpStatus.BAD_REQUEST,
                    "invalid_attention_response",
                    "validation",
                    "当前 Attention 只接受 clarification_answer 和正版本号。",
                    Map.of("attentionId", attentionId)
            );
        }
        UserInputExecutionContextRow execution = toolFacts
                .executionContextForAttention(attentionId)
                .orElseThrow(() -> problem(
                        HttpStatus.NOT_FOUND,
                        "attention_not_found",
                        "not_found",
                        "找不到这条待响应请求。",
                        Map.of("attentionId", attentionId)
                ));
        RoundToolCall call = modelFacts
                .roundToolCalls(execution.roundId())
                .stream()
                .filter(candidate -> candidate.toolCallId().equals(
                        execution.toolCallId()
                ))
                .findFirst()
                .orElseThrow(() -> new IllegalStateException(
                        "Attention has no canonical Model ToolCall"
                ));

        RuntimeResult result;
        try {
            result = runtime.decideUserInput(
                    new UserInputDecision(
                            execution.inputRequestId(),
                            idempotencyKey,
                            request.expectedVersion(),
                            request.answer()
                    ),
                    new AttentionToolContext(
                            execution.conversationId(),
                            execution.turnId(),
                            execution.runId(),
                            execution.roundId(),
                            workspace.root(),
                            false
                    )
            );
        } catch (ToolRuntimeException exception) {
            throw mapRuntimeProblem(exception, attentionId);
        }

        projections.project(execution.roundId(), call, result);
        boolean resumeRequested = result.terminal()
                && runs.resume(execution.runId());
        return new AttentionResponse(
                attentionId,
                execution.inputRequestId(),
                result.executionId(),
                result.toolCallId(),
                result.phase(),
                resumeRequested,
                result.version(),
                result.updatedAt()
        );
    }

    private ApiProblemException mapRuntimeProblem(
            ToolRuntimeException exception,
            String attentionId
    ) {
        return switch (exception.code()) {
            case "user_input_not_found" -> problem(
                    HttpStatus.NOT_FOUND,
                    exception.code(),
                    "not_found",
                    exception.getMessage(),
                    Map.of("attentionId", attentionId)
            );
            case "user_input_precondition_failed" -> problem(
                    HttpStatus.PRECONDITION_FAILED,
                    "attention_stale",
                    "precondition",
                    exception.getMessage(),
                    Map.of("attentionId", attentionId)
            );
            case "user_input_already_resolved" -> problem(
                    HttpStatus.CONFLICT,
                    "attention_already_resolved",
                    "conflict",
                    exception.getMessage(),
                    Map.of("attentionId", attentionId)
            );
            default -> problem(
                    HttpStatus.UNPROCESSABLE_ENTITY,
                    exception.code(),
                    "tool_runtime",
                    exception.getMessage(),
                    Map.of("attentionId", attentionId)
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
        return new ApiProblemException(status, code, category, detail, context);
    }

    private record AttentionToolContext(
            String conversationId,
            String turnId,
            String runId,
            String roundId,
            Path workspaceRoot,
            boolean cancelled
    ) implements ToolContext {
    }
}
