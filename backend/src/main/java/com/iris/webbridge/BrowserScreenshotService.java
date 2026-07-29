package com.iris.webbridge;

import com.fasterxml.jackson.core.JsonProcessingException;
import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.iris.conversation.domain.ApiProblemException;
import com.iris.storage.ManagedObjectStore;
import com.iris.tools.core.ToolExecutionViews.RuntimeResult;
import com.iris.tools.core.ToolOutputPayloadService;
import com.iris.tools.core.ToolRuntimeRepository;
import org.springframework.http.HttpStatus;
import org.springframework.stereotype.Service;

import java.io.IOException;
import java.util.Optional;

@Service
public class BrowserScreenshotService {

    public static final String TOOL_NAME = "capture_browser_screenshot";
    private static final long MAX_OUTPUT_JSON_BYTES = 64 * 1024;
    private static final long MAX_IMAGE_BYTES = 12 * 1024 * 1024;

    private final ToolRuntimeRepository executions;
    private final ToolOutputPayloadService outputs;
    private final ManagedObjectStore objects;
    private final ObjectMapper objectMapper;

    public BrowserScreenshotService(
            ToolRuntimeRepository executions,
            ToolOutputPayloadService outputs,
            ManagedObjectStore objects,
            ObjectMapper objectMapper
    ) {
        this.executions = executions;
        this.outputs = outputs;
        this.objects = objects;
        this.objectMapper = objectMapper;
    }

    public Optional<ScreenshotMetadata> findMetadata(
            String conversationId,
            String executionId
    ) {
        RuntimeResult execution = executions.findByExecutionId(
                        conversationId,
                        executionId
                )
                .filter(result -> TOOL_NAME.equals(result.toolName()))
                .filter(result -> "succeeded".equals(result.phase()))
                .orElse(null);
        if (execution == null) {
            return Optional.empty();
        }
        return outputs.findJson(
                        conversationId,
                        executionId,
                        MAX_OUTPUT_JSON_BYTES
                )
                .map(payload -> metadata(
                        executionId,
                        payload.content()
                ));
    }

    public ScreenshotContent read(
            String conversationId,
            String executionId
    ) {
        ScreenshotMetadata metadata = findMetadata(
                conversationId,
                executionId
        ).orElseThrow(() -> new ApiProblemException(
                HttpStatus.NOT_FOUND,
                "browser_screenshot_not_found",
                "not_found",
                "当前对话中找不到这张浏览器截图。"
        ));
        try {
            byte[] bytes = objects.readBytes(
                    metadata.objectRef(),
                    MAX_IMAGE_BYTES
            );
            if (bytes.length != metadata.byteCount()) {
                throw new IllegalStateException(
                        "Browser screenshot byte count is inconsistent"
                );
            }
            return new ScreenshotContent(metadata, bytes);
        } catch (IOException exception) {
            throw new IllegalStateException(
                    "Browser screenshot object is unavailable or corrupted",
                    exception
            );
        }
    }

    private ScreenshotMetadata metadata(
            String executionId,
            String content
    ) {
        try {
            JsonNode output = objectMapper.readTree(content);
            String mediaType = requiredText(output, "mediaType");
            if (!"image/jpeg".equals(mediaType)
                    && !"image/png".equals(mediaType)) {
                throw new IllegalStateException(
                        "Unsupported browser screenshot media type"
                );
            }
            String objectRef = requiredText(output, "objectRef");
            String contentHash = requiredText(output, "contentHash");
            if (!objectRef.equals("object://sha256/" + contentHash)) {
                throw new IllegalStateException(
                        "Browser screenshot reference does not match its hash"
                );
            }
            long byteCount = output.path("byteCount").asLong(-1);
            if (byteCount < 1 || byteCount > MAX_IMAGE_BYTES) {
                throw new IllegalStateException(
                        "Browser screenshot size is invalid"
                );
            }
            return new ScreenshotMetadata(
                    executionId,
                    objectRef,
                    contentHash,
                    byteCount,
                    mediaType,
                    requiredText(output, "pageId"),
                    output.path("observationRef").asText("")
            );
        } catch (JsonProcessingException exception) {
            throw new IllegalStateException(
                    "Browser screenshot metadata is invalid JSON",
                    exception
            );
        }
    }

    private String requiredText(JsonNode node, String field) {
        String value = node.path(field).asText("");
        if (value.isBlank()) {
            throw new IllegalStateException(
                    "Browser screenshot metadata is missing " + field
            );
        }
        return value;
    }

    public record ScreenshotMetadata(
            String executionId,
            String objectRef,
            String contentHash,
            long byteCount,
            String mediaType,
            String pageId,
            String observationRef
    ) {
    }

    public record ScreenshotContent(
            ScreenshotMetadata metadata,
            byte[] bytes
    ) {
        public ScreenshotContent {
            bytes = bytes.clone();
        }

        @Override
        public byte[] bytes() {
            return bytes.clone();
        }
    }
}
