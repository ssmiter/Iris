package com.iris.tools.core;

import java.util.List;
import java.util.Set;

/**
 * The bounded provider-visible tool surface shared by every primary attempt.
 */
public final class ResidentToolSurface {
    private static final List<String> ORDERED_NAMES = List.of(
            "list_capabilities",
            "read_capability",
            "invoke_capability",
            "ask_user",
            "list_files",
            "search_files",
            "read_file",
            "make_directory",
            "write_file",
            "apply_patch",
            "inspect_workspace_change",
            "create_task_ledger",
            "read_task_ledger",
            "update_task_ledger",
            "present_artifact",
            "read_artifact",
            "read_artifact_text",
            "read_tool_result",
            "query_tool_result"
    );
    private static final Set<String> NAMES = Set.copyOf(ORDERED_NAMES);

    private ResidentToolSurface() {
    }

    public static List<String> orderedNames() {
        return ORDERED_NAMES;
    }

    public static boolean contains(String toolName) {
        return NAMES.contains(toolName);
    }
}
