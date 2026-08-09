package com.iris.tools.core;

import java.util.List;

/**
 * A Tool whose completion requires one durable user response.
 *
 * <p>The runtime persists the prompt and suspends the Run instead of blocking
 * a worker thread. Once answered, the same ToolCall is completed and observed
 * by the model.</p>
 */
public interface UserInputTool extends Tool {
    UserInputPrompt prompt(
            PreparedOperation operation,
            ToolContext context
    );

    ToolOutcome resolve(
            CommittedOperation operation,
            UserInputAnswer answer,
            ToolContext context
    ) throws Exception;

    @Override
    default ToolOutcome execute(
            CommittedOperation operation,
            ToolContext context
    ) {
        throw new IllegalStateException(
                "UserInputTool must be resolved by a durable user response"
        );
    }

    record UserInputPrompt(
            String question,
            List<Option> options,
            String recommendedOptionId
    ) {
        public UserInputPrompt {
            options = options == null ? List.of() : List.copyOf(options);
        }
    }

    record Option(String id, String label, String description) {
    }

    record UserInputAnswer(
            String inputRequestId,
            String optionId,
            String value
    ) {
    }
}
