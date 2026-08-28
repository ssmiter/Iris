package com.iris.workspace;

import com.iris.tools.core.ToolRuntimeException;
import org.junit.jupiter.api.Test;

import static org.junit.jupiter.api.Assertions.assertDoesNotThrow;
import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.junit.jupiter.api.Assertions.assertTrue;

/**
 * 读改写状态机（docs/42 §4-8/9）的纯状态逻辑。
 */
class WorkspaceFileVisionServiceTest {

    private static final String CONVERSATION = "conv-1";
    private static final String PATH = "notes/a.md";

    private final WorkspaceFileVisionService vision =
            new WorkspaceFileVisionService();

    @Test
    void rejectsWriteToExistingFileNeverRead() {
        ToolRuntimeException exception = assertThrows(
                ToolRuntimeException.class,
                () -> vision.requireFreshVision(
                        CONVERSATION, PATH, true, "hash-a")
        );
        assertEquals("workspace_edit_requires_read", exception.code());
        assertTrue(exception.noOperationEffect());
        assertTrue(exception.getMessage().contains("read_file"));
    }

    @Test
    void allowsWriteAfterReadWhenContentUnchanged() {
        vision.recordRead(CONVERSATION, PATH, "hash-a", 1, 400);

        assertDoesNotThrow(() -> vision.requireFreshVision(
                CONVERSATION, PATH, true, "hash-a"));
    }

    @Test
    void rejectsWriteWhenFileChangedExternallyAfterRead() {
        vision.recordRead(CONVERSATION, PATH, "hash-a", 1, 400);

        ToolRuntimeException exception = assertThrows(
                ToolRuntimeException.class,
                () -> vision.requireFreshVision(
                        CONVERSATION, PATH, true, "hash-b")
        );
        assertEquals("workspace_vision_stale", exception.code());
        assertTrue(exception.getMessage().contains("read_file"));
    }

    @Test
    void allowsConsecutiveWritesAfterOwnWrite() {
        vision.recordRead(CONVERSATION, PATH, "hash-a", 1, 400);
        vision.recordWritten(CONVERSATION, PATH, "hash-b");

        assertDoesNotThrow(() -> vision.requireFreshVision(
                CONVERSATION, PATH, true, "hash-b"));
    }

    @Test
    void creationOfAbsentFileNeedsNoPriorRead() {
        assertDoesNotThrow(() -> vision.requireFreshVision(
                CONVERSATION, PATH, false, "absent"));
    }

    @Test
    void repeatReadMatchesOnlySameRangeAndSameHash() {
        vision.recordRead(CONVERSATION, PATH, "hash-a", 1, 400);

        assertTrue(vision.matchesLastRead(
                CONVERSATION, PATH, "hash-a", 1, 400));
        assertFalse(vision.matchesLastRead(
                CONVERSATION, PATH, "hash-a", 2, 400), "区间不同不命中");
        assertFalse(vision.matchesLastRead(
                CONVERSATION, PATH, "hash-b", 1, 400), "摘要不同不命中");
    }

    @Test
    void ownWriteClearsRangeSoNextReadIsNotStubbed() {
        vision.recordRead(CONVERSATION, PATH, "hash-a", 1, 400);
        vision.recordWritten(CONVERSATION, PATH, "hash-b");

        assertFalse(vision.matchesLastRead(
                CONVERSATION, PATH, "hash-b", 1, 400));
    }

    @Test
    void deleteAndMoveAdvanceVision() {
        vision.recordRead(CONVERSATION, PATH, "hash-a", 1, 400);
        vision.recordMoved(CONVERSATION, PATH, "notes/b.md", "hash-a");
        assertTrue(vision.markOf(CONVERSATION, PATH).isEmpty());
        assertDoesNotThrow(() -> vision.requireFreshVision(
                CONVERSATION, "notes/b.md", true, "hash-a"));

        vision.recordDeleted(CONVERSATION, "notes/b.md");
        assertTrue(vision.markOf(CONVERSATION, "notes/b.md").isEmpty());
    }

    @Test
    void visionsAreIsolatedPerConversation() {
        vision.recordRead(CONVERSATION, PATH, "hash-a", 1, 400);

        assertThrows(ToolRuntimeException.class,
                () -> vision.requireFreshVision(
                        "conv-2", PATH, true, "hash-a"));
    }
}
