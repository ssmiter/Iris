package com.iris.tools.core;

import com.iris.storage.ManagedObjectStore;
import com.iris.storage.ManagedObjectStore.StoredObject;
import org.springframework.stereotype.Service;

import java.io.IOException;
import java.time.Instant;
import java.util.Optional;

/**
 * Tool output 的语义身份与物理对象之间的唯一桥梁。
 */
@Service
public class ToolOutputPayloadService {

    private static final String JSON_MEDIA_TYPE = "application/json";

    private final ManagedObjectStore objects;
    private final ToolRuntimeRepository repository;

    public ToolOutputPayloadService(
            ManagedObjectStore objects,
            ToolRuntimeRepository repository
    ) {
        this.objects = objects;
        this.repository = repository;
    }

    /**
     * 先持久化不可变内容；调用方随后在自己的 SQL 事务里 attach。
     */
    public PendingPayload writeJson(String content) throws IOException {
        StoredObject stored = objects.putUtf8(content);
        return new PendingPayload(
                stored.objectRef(),
                JSON_MEDIA_TYPE,
                stored.contentHash(),
                stored.byteCount(),
                content.length()
        );
    }

    public void attach(
            String executionId,
            PendingPayload payload,
            Instant now
    ) {
        repository.storeOutputPayload(
                executionId,
                payload.objectRef(),
                payload.mediaType(),
                payload.contentHash(),
                payload.byteCount(),
                payload.characterCount(),
                now
        );
    }

    public Optional<OutputWindow> findWindow(
            String conversationId,
            String executionId,
            int startCharacter,
            int characterCount
    ) {
        return repository.findOutputPayload(conversationId, executionId)
                .map(payload -> {
                    requireConsistentReference(
                            payload.objectRef(),
                            payload.contentHash()
                    );
                    return new OutputWindow(
                            payload.executionId(),
                            payload.mediaType(),
                            payload.contentHash(),
                            payload.byteCount(),
                            payload.characterCount(),
                            readWindow(
                                    payload.objectRef(),
                                    startCharacter,
                                    characterCount
                            )
                    );
                });
    }

    public Optional<JsonPayload> findJson(
            String conversationId,
            String executionId,
            long maximumBytes
    ) {
        return repository.findOutputPayload(conversationId, executionId)
                .map(payload -> {
                    requireConsistentReference(
                            payload.objectRef(),
                            payload.contentHash()
                    );
                    if (!JSON_MEDIA_TYPE.equals(payload.mediaType())) {
                        throw new ToolRuntimeException(
                                "tool_result_not_json",
                                "这条工具结果不是 JSON，不能使用结构化查询"
                        );
                    }
                    if (payload.byteCount() > maximumBytes) {
                        throw new ToolRuntimeException(
                                "tool_result_json_too_large",
                                "完整 JSON 超过结构化查询上限；请先用 read_tool_result 按字符窗口定位"
                        );
                    }
                    try {
                        byte[] bytes = objects.readBytes(
                                payload.objectRef(),
                                maximumBytes
                        );
                        return new JsonPayload(
                                payload.executionId(),
                                payload.contentHash(),
                                payload.byteCount(),
                                new String(
                                        bytes,
                                        java.nio.charset.StandardCharsets.UTF_8
                                )
                        );
                    } catch (IOException exception) {
                        throw new IllegalStateException(
                                "Tool output object is unavailable or corrupted",
                                exception
                        );
                    }
                });
    }

    private void requireConsistentReference(
            String objectRef,
            String contentHash
    ) {
        if (!("object://sha256/" + contentHash).equals(objectRef)) {
            throw new IllegalStateException(
                    "Tool output object reference does not match its hash"
            );
        }
    }

    private String readWindow(
            String objectRef,
            int startCharacter,
            int characterCount
    ) {
        try {
            return objects.readUtf8Window(
                    objectRef,
                    startCharacter,
                    characterCount
            );
        } catch (IOException exception) {
            throw new IllegalStateException(
                    "Tool output object is unavailable or corrupted",
                    exception
            );
        }
    }

    public record PendingPayload(
            String objectRef,
            String mediaType,
            String contentHash,
            long byteCount,
            int characterCount
    ) {
    }

    public record OutputWindow(
            String executionId,
            String mediaType,
            String contentHash,
            long totalBytes,
            int totalCharacters,
            String content
    ) {
    }

    public record JsonPayload(
            String executionId,
            String contentHash,
            long totalBytes,
            String content
    ) {
    }
}
