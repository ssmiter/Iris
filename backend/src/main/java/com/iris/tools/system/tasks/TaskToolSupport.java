package com.iris.tools.system.tasks;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.node.ArrayNode;
import com.fasterxml.jackson.databind.node.ObjectNode;
import com.iris.tools.core.ToolRuntimeException;

import java.util.HashSet;
import java.util.Set;
import java.util.regex.Pattern;

final class TaskToolSupport {
    static final int MAX_OBJECTIVE = 4_000;
    static final int MAX_SUMMARY = 2_000;
    static final int MAX_LIST_ITEMS = 30;
    static final int MAX_ITEM_TEXT = 500;

    private static final Pattern STEP_ID =
            Pattern.compile("[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}");
    private static final Set<String> TASK_PHASES = Set.of(
            "active", "blocked", "paused", "completed", "cancelled"
    );
    private static final Set<String> STEP_STATUSES = Set.of(
            "pending", "in_progress", "blocked", "completed", "skipped"
    );
    private static final Set<String> CHECKPOINT_KINDS = Set.of(
            "none", "milestone", "handoff"
    );

    private TaskToolSupport() {
    }

    static String text(
            JsonNode input,
            String field,
            int maximum,
            boolean required
    ) {
        String value = input.path(field).asText("").trim();
        if ((required && value.isBlank()) || value.length() > maximum) {
            throw ToolRuntimeException.beforeCommit(
                    "invalid_task_" + field,
                    field + (required ? " 不能为空且" : " ")
                            + "不能超过 " + maximum + " 个字符"
            );
        }
        return value;
    }

    static ArrayNode stringArray(
            ObjectMapper mapper,
            JsonNode input,
            String field,
            int minimum
    ) {
        JsonNode value = input.path(field);
        if (!value.isArray()
                || value.size() < minimum
                || value.size() > MAX_LIST_ITEMS) {
            throw ToolRuntimeException.beforeCommit(
                    "invalid_task_" + field,
                    field + " 必须包含 " + minimum + " 到 "
                            + MAX_LIST_ITEMS + " 项"
            );
        }
        ArrayNode normalized = mapper.createArrayNode();
        Set<String> unique = new HashSet<>();
        for (JsonNode item : value) {
            String text = item.asText("").trim();
            if (text.isBlank() || text.length() > MAX_ITEM_TEXT) {
                throw ToolRuntimeException.beforeCommit(
                        "invalid_task_" + field,
                        field + " 中每项必须是 1 到 "
                                + MAX_ITEM_TEXT + " 个字符"
                );
            }
            if (unique.add(text)) {
                normalized.add(text);
            }
        }
        return normalized;
    }

    static ArrayNode steps(
            ObjectMapper mapper,
            JsonNode input
    ) {
        JsonNode value = input.path("steps");
        if (!value.isArray() || value.size() > MAX_LIST_ITEMS) {
            throw ToolRuntimeException.beforeCommit(
                    "invalid_task_steps",
                    "steps 必须是至多 " + MAX_LIST_ITEMS + " 项的数组"
            );
        }
        ArrayNode normalized = mapper.createArrayNode();
        Set<String> ids = new HashSet<>();
        for (JsonNode item : value) {
            String id = item.path("id").asText("").trim();
            String description = item.path("description")
                    .asText("").trim();
            String status = item.path("status")
                    .asText("pending").trim();
            if (!STEP_ID.matcher(id).matches() || !ids.add(id)) {
                throw ToolRuntimeException.beforeCommit(
                        "invalid_task_step_id",
                        "每个 step.id 必须唯一，且只能包含字母、数字、_ 或 -"
                );
            }
            if (description.isBlank()
                    || description.length() > MAX_ITEM_TEXT) {
                throw ToolRuntimeException.beforeCommit(
                        "invalid_task_step_description",
                        "每个步骤必须有不超过 " + MAX_ITEM_TEXT
                                + " 字符的具体结果描述"
                );
            }
            if (!STEP_STATUSES.contains(status)) {
                throw ToolRuntimeException.beforeCommit(
                        "invalid_task_step_status",
                        "步骤状态必须是 pending、in_progress、blocked、"
                                + "completed 或 skipped"
                );
            }
            ObjectNode step = normalized.addObject();
            step.put("id", id);
            step.put("description", description);
            step.put("status", status);
        }
        return normalized;
    }

    static String phase(JsonNode input) {
        String phase = input.path("phase").asText("").trim();
        if (!TASK_PHASES.contains(phase)) {
            throw ToolRuntimeException.beforeCommit(
                    "invalid_task_phase",
                    "phase 必须是 active、blocked、paused、completed 或 cancelled"
            );
        }
        return phase;
    }

    static String checkpointKind(JsonNode input) {
        String kind = input.path("checkpoint_kind")
                .asText("none").trim();
        if (!CHECKPOINT_KINDS.contains(kind)) {
            throw ToolRuntimeException.beforeCommit(
                    "invalid_task_checkpoint_kind",
                    "checkpoint_kind 必须是 none、milestone 或 handoff"
            );
        }
        return kind;
    }

    static void requireVisibleProgress(
            String phase,
            String currentFocus,
            ArrayNode blockers,
            ArrayNode pendingDecisions,
            ArrayNode nextActions
    ) {
        if ("active".equals(phase)
                && (currentFocus.isBlank() || nextActions.isEmpty())) {
            throw ToolRuntimeException.beforeCommit(
                    "task_active_progress_incomplete",
                    "active 任务必须说明当前焦点，并至少给出一个下一动作"
            );
        }
        if ("blocked".equals(phase)
                && blockers.isEmpty()
                && pendingDecisions.isEmpty()) {
            throw ToolRuntimeException.beforeCommit(
                    "task_blocker_not_explained",
                    "blocked 任务必须给出具体阻塞项或待决事项"
            );
        }
    }

    static void requireClosable(
            String phase,
            ArrayNode steps,
            ArrayNode blockers,
            ArrayNode evidenceRefs,
            ArrayNode artifactRefs
    ) {
        if (!"completed".equals(phase)) {
            return;
        }
        boolean unfinished = false;
        for (JsonNode step : steps) {
            String status = step.path("status").asText();
            if (!"completed".equals(status) && !"skipped".equals(status)) {
                unfinished = true;
                break;
            }
        }
        if (unfinished || !blockers.isEmpty()) {
            throw ToolRuntimeException.beforeCommit(
                    "task_not_ready_for_completion",
                    "完成任务前必须关闭或跳过全部步骤，并清空 blockers"
            );
        }
        if (evidenceRefs.isEmpty() && artifactRefs.isEmpty()) {
            throw ToolRuntimeException.beforeCommit(
                    "task_completion_has_no_evidence",
                    "完成任务至少需要一个 Evidence 或 Artifact 稳定引用"
            );
        }
    }

    static ObjectNode objectSchema(ObjectMapper mapper) {
        ObjectNode schema = mapper.createObjectNode();
        schema.put("type", "object");
        schema.put("additionalProperties", false);
        schema.putObject("properties");
        return schema;
    }

    static ObjectNode stringArraySchema(
            ObjectMapper mapper,
            String description,
            int minimum
    ) {
        ObjectNode schema = mapper.createObjectNode();
        schema.put("type", "array");
        schema.put("description", description);
        schema.put("minItems", minimum);
        schema.put("maxItems", MAX_LIST_ITEMS);
        schema.putObject("items")
                .put("type", "string")
                .put("maxLength", MAX_ITEM_TEXT);
        return schema;
    }

    static ObjectNode stepsSchema(ObjectMapper mapper) {
        ObjectNode schema = mapper.createObjectNode();
        schema.put("type", "array");
        schema.put("description", "有界工作步骤；只记录状态，不放长脚本或网页原文");
        schema.put("maxItems", MAX_LIST_ITEMS);
        ObjectNode item = schema.putObject("items");
        item.put("type", "object");
        item.put("additionalProperties", false);
        ObjectNode properties = item.putObject("properties");
        properties.putObject("id")
                .put("type", "string")
                .put("description", "任务内稳定且唯一的短 ID")
                .put("maxLength", 64);
        properties.putObject("description")
                .put("type", "string")
                .put("description", "该步骤要达到的具体结果")
                .put("maxLength", MAX_ITEM_TEXT);
        properties.putObject("status")
                .put("type", "string")
                .put("description", "当前步骤状态")
                .putArray("enum")
                .add("pending").add("in_progress").add("blocked")
                .add("completed").add("skipped");
        item.putArray("required")
                .add("id").add("description").add("status");
        return schema;
    }
}
