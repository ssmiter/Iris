package com.iris.conversation.domain;

import jakarta.validation.constraints.NotBlank;
import jakarta.validation.constraints.Size;

/**
 * 子 Run 级别的直接命令（docs/34 M7d）。
 * 这些命令绕过 Turn 级语义，直接操作后台 Run 的 mailbox 与取消信号。
 */
public final class RunCommands {
    private RunCommands() {
    }

    public record SendRunMessageRequest(
            @NotBlank @Size(min = 1, max = 8000) String text
    ) {
    }

    public record RunMessageView(
            String messageId,
            String runId,
            String phase,
            String text
    ) {
    }

    public record StopRunRequest(@NotBlank String reason) {
    }

    public record StopRunView(
            String runId,
            String phase,
            boolean accepted,
            String message
    ) {
    }
}
