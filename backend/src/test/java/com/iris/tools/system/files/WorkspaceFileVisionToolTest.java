package com.iris.tools.system.files;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.node.ObjectNode;
import com.iris.tools.core.CommittedOperation;
import com.iris.tools.core.PreparedOperation;
import com.iris.tools.core.ToolContext;
import com.iris.tools.core.ToolOutcome;
import com.iris.tools.core.ToolRuntimeException;
import com.iris.workspace.WorkspaceCheckpointService;
import com.iris.workspace.WorkspaceCheckpointService.Checkpoint;
import com.iris.workspace.WorkspaceFileMutationService;
import com.iris.workspace.WorkspaceFileMutationService.TargetState;
import com.iris.workspace.WorkspaceFileService;
import com.iris.workspace.WorkspaceFileVisionService;
import com.iris.workspace.WorkspacePathGuard;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;

import java.nio.file.Files;
import java.nio.file.Path;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.junit.jupiter.api.Assertions.assertTrue;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.ArgumentMatchers.anyString;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.when;

/**
 * 读改写状态机与重复读取 stub 在真实工具链路上的钉死测试
 * （docs/42 §4-8/9）：真实文件服务 + 真实 vision 状态机，
 * 仅 Checkpoint 落库用 mock 顶替。
 */
class WorkspaceFileVisionToolTest {

    private final ObjectMapper objectMapper = new ObjectMapper();
    private final WorkspacePathGuard pathGuard = new WorkspacePathGuard();
    private final WorkspaceFileService fileService =
            new WorkspaceFileService(pathGuard);
    private final WorkspaceFileMutationService mutationService =
            new WorkspaceFileMutationService(pathGuard, fileService);
    private final WorkspaceFileVisionService vision =
            new WorkspaceFileVisionService();
    private final WorkspaceCheckpointService checkpoints =
            mock(WorkspaceCheckpointService.class);
    private final ReadFileTool readTool = new ReadFileTool(
            objectMapper, pathGuard, fileService, mutationService, vision);
    private final WriteFileTool writeTool = new WriteFileTool(
            objectMapper, mutationService, checkpoints, vision);

    @TempDir
    Path workspace;

    @BeforeEach
    void stubCheckpoints() throws Exception {
        when(checkpoints.capture(anyString(), anyString(), any()))
                .thenAnswer(invocation -> {
                    TargetState target = invocation.getArgument(2);
                    return new Checkpoint(
                            "cp-test",
                            target.logicalPath(),
                            target.version(),
                            target.sizeBytes()
                    );
                });
    }

    @Test
    void writeRejectsExistingFileThatWasNeverRead() throws Exception {
        Files.writeString(workspace.resolve("a.md"), "旧内容\n");

        ToolRuntimeException exception = assertThrows(
                ToolRuntimeException.class,
                () -> write("a.md", "新内容\n")
        );
        assertEquals("workspace_edit_requires_read", exception.code());
        assertTrue(exception.noOperationEffect());
        assertEquals("旧内容\n",
                Files.readString(workspace.resolve("a.md")));
    }

    @Test
    void writeAllowedAfterReadAndStateAdvancesForConsecutiveWrites()
            throws Exception {
        Files.writeString(workspace.resolve("a.md"), "旧内容\n");
        read("a.md", 1, 400);

        ToolOutcome first = write("a.md", "新内容\n");
        assertEquals(ToolOutcome.Kind.SUCCEEDED, first.kind());

        ToolOutcome second = write("a.md", "再改一次\n");
        assertEquals(ToolOutcome.Kind.SUCCEEDED, second.kind());
        assertEquals("再改一次\n",
                Files.readString(workspace.resolve("a.md")));
    }

    @Test
    void writeRejectedWhenFileChangedExternallyAfterRead() throws Exception {
        Files.writeString(workspace.resolve("a.md"), "旧内容\n");
        read("a.md", 1, 400);
        Files.writeString(workspace.resolve("a.md"), "别人改的\n");

        ToolRuntimeException exception = assertThrows(
                ToolRuntimeException.class,
                () -> write("a.md", "基于过期视野的内容\n")
        );
        assertEquals("workspace_vision_stale", exception.code());
        assertEquals("别人改的\n",
                Files.readString(workspace.resolve("a.md")));
    }

    @Test
    void writeCreatesAbsentFileWithoutPriorRead() throws Exception {
        ToolOutcome outcome = write("new.md", "直接创建\n");

        assertEquals(ToolOutcome.Kind.SUCCEEDED, outcome.kind());
        assertEquals("直接创建\n",
                Files.readString(workspace.resolve("new.md")));
    }

    @Test
    void repeatReadOfSameRangeReturnsStub() throws Exception {
        Files.writeString(workspace.resolve("a.md"), "第一行\n第二行\n");

        ToolOutcome first = read("a.md", 1, 400);
        assertTrue(first.output().path("returnedLines").asInt() > 0);

        ToolOutcome second = read("a.md", 1, 400);
        assertEquals(ToolOutcome.Kind.SUCCEEDED, second.kind());
        assertEquals(0, second.output().path("returnedLines").asInt());
        assertTrue(second.output().path("content").asText()
                .contains("内容未变"));
        assertTrue(second.output().path("content").asText()
                .contains("a.md"));
    }

    @Test
    void readAfterExternalChangeReturnsFullContentAgain() throws Exception {
        Files.writeString(workspace.resolve("a.md"), "第一行\n");
        read("a.md", 1, 400);
        Files.writeString(workspace.resolve("a.md"), "外部新增\n");

        ToolOutcome outcome = read("a.md", 1, 400);
        assertTrue(outcome.output().path("returnedLines").asInt() > 0);
        assertTrue(outcome.output().path("content").asText()
                .contains("外部新增"));
    }

    @Test
    void readAfterOwnWriteReturnsFullContentAgain() throws Exception {
        Files.writeString(workspace.resolve("a.md"), "第一行\n");
        read("a.md", 1, 400);
        write("a.md", "自己改写的\n");

        ToolOutcome outcome = read("a.md", 1, 400);
        assertTrue(outcome.output().path("returnedLines").asInt() > 0);
        assertTrue(outcome.output().path("content").asText()
                .contains("自己改写的"));
    }

    @Test
    void differentRangeIsNotStubbed() throws Exception {
        Files.writeString(workspace.resolve("a.md"), "一\n二\n三\n");
        read("a.md", 1, 2);

        ToolOutcome outcome = read("a.md", 2, 2);
        assertTrue(outcome.output().path("returnedLines").asInt() > 0);
    }

    private ToolOutcome read(String path, int startLine, int lineCount)
            throws Exception {
        ObjectNode input = objectMapper.createObjectNode();
        input.put("path", path);
        input.put("start_line", startLine);
        input.put("line_count", lineCount);
        PreparedOperation prepared = readTool.prepare(input, context());
        return readTool.execute(
                new CommittedOperation(
                        "exec-read",
                        "snap",
                        "hash",
                        prepared.normalizedInput(),
                        prepared.resources()
                ),
                context()
        );
    }

    private ToolOutcome write(String path, String content) throws Exception {
        ObjectNode input = objectMapper.createObjectNode();
        input.put("path", path);
        input.put("content", content);
        PreparedOperation prepared = writeTool.prepare(input, context());
        return writeTool.execute(
                new CommittedOperation(
                        "exec-write",
                        "snap",
                        "hash",
                        prepared.normalizedInput(),
                        prepared.resources()
                ),
                context()
        );
    }

    private ToolContext context() {
        return new ToolContext() {
            @Override
            public String conversationId() {
                return "conv-test";
            }

            @Override
            public String turnId() {
                return "turn-test";
            }

            @Override
            public String runId() {
                return "run-test";
            }

            @Override
            public String roundId() {
                return "round-test";
            }

            @Override
            public Path workspaceRoot() {
                return workspace;
            }

            @Override
            public boolean cancelled() {
                return false;
            }
        };
    }
}
