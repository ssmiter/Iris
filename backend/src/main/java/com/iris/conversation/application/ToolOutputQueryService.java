package com.iris.conversation.application;

import com.iris.conversation.domain.ApiProblemException;
import com.iris.tools.core.ToolOutputPayloadService;
import com.iris.tools.core.ToolOutputPayloadService.OutputWindow;
import org.springframework.http.HttpStatus;
import org.springframework.stereotype.Service;

@Service
public class ToolOutputQueryService {

    private static final int DEFAULT_CHARACTER_COUNT = 20_000;
    private static final int MAX_CHARACTER_COUNT = 50_000;

    private final ToolOutputPayloadService outputs;

    public ToolOutputQueryService(ToolOutputPayloadService outputs) {
        this.outputs = outputs;
    }

    public ToolOutputWindow read(
            String conversationId,
            String executionId,
            int startCharacter,
            Integer characterCount
    ) {
        if (startCharacter < 0) {
            throw invalid("startCharacter 不能小于 0");
        }
        int count = characterCount == null
                ? DEFAULT_CHARACTER_COUNT
                : characterCount;
        if (count < 1 || count > MAX_CHARACTER_COUNT) {
            throw invalid(
                    "characterCount 必须在 1 到 "
                            + MAX_CHARACTER_COUNT + " 之间"
            );
        }
        OutputWindow window = outputs.findWindow(
                conversationId,
                executionId,
                startCharacter,
                count
        ).orElseThrow(() -> new ApiProblemException(
                HttpStatus.NOT_FOUND,
                "tool_output_not_found",
                "not_found",
                "当前对话中找不到这条工具结果。"
        ));
        if (startCharacter >= window.totalCharacters()
                && window.totalCharacters() > 0) {
            throw new ApiProblemException(
                    HttpStatus.REQUESTED_RANGE_NOT_SATISFIABLE,
                    "tool_output_window_out_of_range",
                    "validation",
                    "读取起点超过工具结果长度。"
            );
        }
        String content = window.content() == null ? "" : window.content();
        int end = startCharacter + content.length();
        boolean truncated = end < window.totalCharacters();
        return new ToolOutputWindow(
                executionId,
                "json",
                window.contentHash(),
                window.totalCharacters(),
                startCharacter,
                end,
                content,
                truncated,
                truncated ? end : null
        );
    }

    private ApiProblemException invalid(String message) {
        return new ApiProblemException(
                HttpStatus.BAD_REQUEST,
                "invalid_tool_output_window",
                "validation",
                message
        );
    }

    public record ToolOutputWindow(
            String toolExecutionId,
            String format,
            String contentHash,
            int totalCharacters,
            int startCharacter,
            int endCharacterExclusive,
            String content,
            boolean truncated,
            Integer nextStartCharacter
    ) {
    }
}
