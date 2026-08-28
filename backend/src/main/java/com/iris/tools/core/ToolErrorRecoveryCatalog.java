package com.iris.tools.core;

import java.util.Map;
import java.util.Set;

/**
 * errorCode → 恢复族的单一事实源（docs/43 S2，选方案 B：tools/core 一处常量表）。
 *
 * <p>生产侧（工具、ToolRuntime、扩展进程透传、浏览器扩展）只负责产出稳定
 * snake_case 码；把码翻译成恢复动作只发生在本类。判定规则分三层，按序生效：
 * 开放词法规则（前缀/后缀族）、精确登记表、兜底 replan。
 *
 * <p>新造 errorCode 的规矩：码必须先在这里可判定——要么命名落进开放规则族
 * （invalid_*、*_too_large 等），要么在 EXACT_RECOVERIES / KNOWN_REPLAN /
 * KNOWN_DYNAMIC_PREFIXES 显式登记。守卫测试 ToolErrorRecoveryCatalogTest
 * 扫描全部产码点源码，未登记的新码直接红灯，不允许静默落兜底。
 *
 * <p>第三方扩展经插件协议可透传任意码（ResidentProcessTool），运行期无法
 * 穷举；未登记的码在运行期落 REPLAN 兜底，这是设计内的容错，不是脱钩。
 */
public final class ToolErrorRecoveryCatalog {

    /** 一次恢复建议：动作、是否需要新 ToolCall、给模型的人话指引。 */
    public record Recovery(
            String action,
            boolean newToolCallRequired,
            String instruction
    ) {
    }

    private static final Recovery OBSERVE_AND_RECONCILE_STILL_UNKNOWN =
            new Recovery(
                    "observe_and_reconcile",
                    true,
                    "原动作日志仍无法确认结果；重新观察当前页面并按页面事实核对，不要再次 inspect 或直接重放"
            );
    private static final Recovery OBSERVE_AND_RECONCILE_POSTCONDITION =
            new Recovery(
                    "observe_and_reconcile",
                    true,
                    "浏览器动作已执行但证据不足；重新观察当前页面并按页面事实核对，确认未生效前不得重放"
            );
    private static final Recovery INSPECT_BROWSER_ACTION = new Recovery(
            "inspect_browser_action",
            true,
            "用当前 observation 中的 executionId 调用 inspect_browser_action；如果原动作仍未知，再重新观察页面并按当前事实核对，禁止直接重放动作"
    );
    private static final Recovery INSPECT_BEFORE_RETRY = new Recovery(
            "inspect_before_retry",
            true,
            "先读取目标的当前状态或调用 inspect_workspace_change；确认没有生效后，才能用新的工具调用重试"
    );
    private static final Recovery OBSERVE_THEN_RETRY_NOT_APPLIED =
            new Recovery(
                    "observe_then_retry",
                    true,
                    "动作已确认没有生效；重新读取目标当前状态，根据最新事实调整参数，不要原样复用旧引用"
            );
    private static final Recovery STOP_REJECTED = new Recovery(
            "stop",
            true,
            "停止这项操作；只有用户重新明确要求时，才发起新的工具调用"
    );
    private static final Recovery PREPARE_AGAIN = new Recovery(
            "prepare_again",
            true,
            "重新读取必要状态，并用新的工具调用重新准备操作"
    );
    private static final Recovery READ_DEFINITION_THEN_RETRY = new Recovery(
            "read_definition_then_retry",
            true,
            "重新 read_capability，并把新返回的 path、manifestHash 与符合 inputSchema 的 arguments 交给新的 invoke_capability 调用"
    );
    private static final Recovery CALL_RESIDENT_TOOL_DIRECTLY = new Recovery(
            "call_resident_tool_directly",
            true,
            "该工具已在 Provider tools 中；使用它自己的名称和 schema 发起新的直接调用"
    );
    private static final Recovery STOP_CANCELLED = new Recovery(
            "stop",
            true,
            "操作已在确认无副作用的边界停止；除非任务仍然需要，否则不要重试"
    );
    private static final Recovery CORRECT_INPUT = new Recovery(
            "correct_input",
            true,
            "根据 errorCode 和 message 修正参数，再发起新的工具调用"
    );
    private static final Recovery OBSERVE_THEN_RETRY_STALE = new Recovery(
            "observe_then_retry",
            true,
            "目标状态已经变化；先重新读取相关资源，再基于新状态发起工具调用"
    );
    private static final Recovery RETRY_IF_STILL_NEEDED = new Recovery(
            "retry_if_still_needed",
            true,
            "本次执行已确认没有副作用；若任务仍需要，可缩小范围后发起新的工具调用"
    );
    private static final Recovery REPLAN = new Recovery(
            "replan",
            true,
            "结合 errorCode 和 message 调整方案；不要原样重复失败的调用"
    );

    /** 精确登记：不随开放规则、且有专属恢复动作的码。 */
    private static final Map<String, Recovery> EXACT_RECOVERIES = Map.ofEntries(
            Map.entry("capability_not_inspected", READ_DEFINITION_THEN_RETRY),
            Map.entry("capability_definition_changed", READ_DEFINITION_THEN_RETRY),
            Map.entry("pipeline_not_inspected", READ_DEFINITION_THEN_RETRY),
            Map.entry("resident_tool_requires_direct_call",
                    CALL_RESIDENT_TOOL_DIRECTLY),
            Map.entry("tool_cancelled", STOP_CANCELLED),
            Map.entry("cancelled_before_commit", STOP_CANCELLED),
            Map.entry("run_stopped", STOP_CANCELLED),
            Map.entry("cancelled", STOP_CANCELLED),
            Map.entry("process_cancelled", STOP_CANCELLED)
    );

    /**
     * 只在 outcome_unknown 分支里有专属语义的码（按 phase 判定，不进
     * EXACT_RECOVERIES）；snapshot_expired 与 expired phase 同族处理。
     */
    private static final Set<String> KNOWN_PHASE_SCOPED = Set.of(
            "browser_action_still_unknown",
            "postcondition_unknown",
            "snapshot_expired"
    );

    /**
     * 已盘点、当前语义就是兜底 replan 的码。显式登记等于宣告「这个码落
     * replan 是审过的决定」，把新码静默落兜底变成测试红灯。
     */
    private static final Set<String> KNOWN_REPLAN = Set.of(
            // 工作区与文件原语
            "workspace_write_target_is_link",
            "workspace_target_not_file",
            "workspace_target_not_directory",
            "workspace_unavailable",
            "workspace_path_outside_fence",
            "workspace_file_too_large_to_edit",
            "workspace_file_not_text",
            "workspace_path_not_regular_file",
            "workspace_atomic_move_unavailable",
            "workspace_atomic_copy_unavailable",
            "workspace_path_not_directory",
            "workspace_atomic_replace_unavailable",
            "workspace_checkpoint_not_found",
            "workspace_edit_requires_read",
            "workspace_vision_stale",
            // Artifact
            "artifact_scope_unavailable",
            "artifact_not_found",
            "artifact_preview_not_available",
            "artifact_source_not_found",
            "artifact_publication_not_applicable",
            "artifact_text_unavailable",
            "artifact_text_invalid",
            "artifact_origin_unavailable",
            // 任务账本
            "task_state_not_found",
            "task_scope_unavailable",
            "task_artifact_ref_invalid",
            "task_state_version_conflict",
            "task_evidence_ref_invalid",
            "task_active_progress_incomplete",
            "task_blocker_not_explained",
            "task_not_ready_for_completion",
            "task_completion_has_no_evidence",
            // 笔记
            "note_line_has_line_break",
            // 能力解析与调用
            "capability_unavailable",
            "capability_not_found",
            "capability_binding_not_found",
            "capability_proxy_not_resolved",
            "pipeline_binding_not_found",
            "pipeline_launch_failed",
            // 子 Agent 工具
            "agent_result_outside_branch",
            "agent_result_not_ready",
            "child_agent_not_found",
            "child_agent_already_terminal",
            // 用户输入与审批
            "duplicate_user_input_option",
            "user_input_not_found",
            "user_input_not_in_conversation",
            "user_input_already_resolved",
            "user_input_binding_changed",
            "user_input_precondition_failed",
            "user_input_resolution_failed",
            "approval_not_found",
            "approval_not_in_conversation",
            "approval_already_resolved",
            "approval_precondition_failed",
            // Tool Runtime 内部
            "tool_not_found",
            "tool_resolution_failed",
            "host_tool_binding_changed",
            "host_proxy_tool_not_allowed",
            "resolved_tool_not_found",
            "resolved_tool_binding_changed",
            "tool_execution_not_found",
            "tool_binding_unavailable",
            "tool_binding_changed",
            "tool_output_persistence_failed",
            "tool_call_id_reused",
            "tool_exposure_name_mismatch",
            "tool_input_not_serializable",
            "execution_interrupted",
            "verification_failed",
            "prepare_failed",
            "commit_gate_failed",
            "postcondition_failed",
            "agent_work_mode_read_only",
            // 扩展进程与文档工具
            "template_param_missing",
            "extension_manifest_invalid",
            "extension_env_missing",
            "process_crashed",
            "extension_retired",
            "plugin_error",
            "skill_read_failed",
            "skill_resource_unavailable",
            "skill_resource_forbidden",
            "skill_resource_not_found",
            "knowledge_read_failed",
            // MCP
            "mcp_not_connected",
            "mcp_tool_error",
            "mcp_call_failed",
            // 浏览器扩展（extensions/web/browser，经插件协议透传）
            "browser_page_open_outcome_unknown",
            "browser_page_close_outcome_unknown",
            "browser_action_outcome_unknown",
            "browser_history_outcome_unknown",
            "browser_upload_outcome_unknown",
            "browser_element_disabled",
            "browser_field_not_fillable",
            "browser_select_not_supported",
            "browser_option_not_available",
            "browser_file_input_required",
            "browser_element_not_resolvable",
            "browser_runtimes_config_invalid",
            "browser_runtime_not_found",
            "browser_runtime_not_configured",
            "browser_runtime_choice_required",
            "browser_runtime_unavailable",
            "browser_observation_required",
            "browser_plugin_internal_error",
            "unknown_browser_primitive",
            "webbridge_invalid_screenshot",
            "webbridge_invalid_response",
            "webbridge_timeout",
            "webbridge_unreachable",
            "workspace_root_missing",
            "workspace_fence_violation",
            "workspace_file_not_found",
            "workspace_file_unreadable",
            // 内置扩展（extensions/：python、sql、mes 等，经插件协议回传）
            "python_execution_failed",
            "python_output_set_mismatch",
            "python_input_count_exceeded",
            "python_input_not_found",
            "python_input_budget_exceeded",
            "python_output_count_invalid",
            "python_output_name_conflict",
            "python_workspace_path_conflict",
            "python_output_budget_exceeded",
            "python_output_invalid",
            "python_runtime_unavailable",
            "python_mount_name_conflict",
            "sql_connections_config_invalid",
            "sql_credential_env_missing",
            "sql_driver_unavailable",
            "sql_connection_not_found",
            "sql_connection_not_read_only",
            "sql_engine_error",
            "sql_multiple_statements",
            "sql_plugin_internal_error",
            "sql_read_not_proven",
            "sql_too_many_columns",
            "sql_write_not_allowed",
            "unknown_sql_primitive",
            "mes_write_conflict",
            "mes_plugin_internal_error",
            "mes_seed_unavailable",
            "mes_workspace_unavailable",
            "unknown_mes_primitive",
            "industrial_demo_sql_unavailable",
            "industrial_demo_record_invalid",
            "python_plugin_internal_error"
    );

    /**
     * 码由「前缀 + 变量」拼接产生、且前缀本身不命中开放规则的动态族。
     * process_exit_ 接退出码；cancelled_before_ 接阶段名（prepare /
     * execution）。带 invalid_、tool_timeout_ 等前缀的动态码已被开放
     * 规则覆盖，无需在此登记。
     */
    private static final Set<String> KNOWN_DYNAMIC_PREFIXES = Set.of(
            "process_exit_",
            "cancelled_before_"
    );

    private ToolErrorRecoveryCatalog() {
    }

    /**
     * 把一次终态执行翻译成恢复建议。判定顺序即契约顺序，调整前先改
     * docs/21 与守卫测试。
     */
    public static Recovery recoveryFor(
            String phase,
            String errorCode,
            String toolName
    ) {
        if ("outcome_unknown".equals(phase)) {
            if ("browser_action_still_unknown".equals(errorCode)) {
                return OBSERVE_AND_RECONCILE_STILL_UNKNOWN;
            }
            if ("postcondition_unknown".equals(errorCode)
                    && toolName != null
                    && toolName.contains("browser")) {
                return OBSERVE_AND_RECONCILE_POSTCONDITION;
            }
            if (errorCode.startsWith("browser_")) {
                return INSPECT_BROWSER_ACTION;
            }
            return INSPECT_BEFORE_RETRY;
        }
        if (errorCode.endsWith("_not_applied")) {
            return OBSERVE_THEN_RETRY_NOT_APPLIED;
        }
        if ("rejected".equals(phase)) {
            return STOP_REJECTED;
        }
        if ("expired".equals(phase) || "snapshot_expired".equals(errorCode)) {
            return PREPARE_AGAIN;
        }
        Recovery exact = EXACT_RECOVERIES.get(errorCode);
        if (exact != null) {
            return exact;
        }
        if (isInvalidInput(errorCode)) {
            return CORRECT_INPUT;
        }
        if (isStaleObservation(errorCode)) {
            return OBSERVE_THEN_RETRY_STALE;
        }
        if (errorCode.startsWith("tool_timeout")
                || errorCode.startsWith("process_timeout")) {
            return RETRY_IF_STILL_NEEDED;
        }
        return REPLAN;
    }

    /**
     * 守卫测试用：这个码是否在词表内。命中开放规则族、精确登记或动态
     * 前缀都算已知；否则视为新码，必须先登记再合入。
     */
    public static boolean isKnown(String errorCode) {
        return EXACT_RECOVERIES.containsKey(errorCode)
                || KNOWN_PHASE_SCOPED.contains(errorCode)
                || KNOWN_REPLAN.contains(errorCode)
                || matchesKnownDynamicPrefix(errorCode)
                || errorCode.endsWith("_not_applied")
                || isInvalidInput(errorCode)
                || isStaleObservation(errorCode)
                || errorCode.startsWith("tool_timeout")
                || errorCode.startsWith("process_timeout");
    }

    /** 守卫测试用：已显式登记为 replan 的码全集。 */
    static Set<String> registeredReplanCodes() {
        return KNOWN_REPLAN;
    }

    private static boolean matchesKnownDynamicPrefix(String errorCode) {
        for (String prefix : KNOWN_DYNAMIC_PREFIXES) {
            if (errorCode.startsWith(prefix)) {
                return true;
            }
        }
        return false;
    }

    private static boolean isInvalidInput(String errorCode) {
        return errorCode.startsWith("invalid_")
                || errorCode.startsWith("unsafe_")
                || errorCode.startsWith("calculation_")
                || errorCode.startsWith("tool_result_")
                || errorCode.endsWith("_empty")
                || errorCode.endsWith("_too_long")
                || errorCode.endsWith("_too_large")
                || errorCode.contains("_same_path")
                || errorCode.contains("_line_out_of_range")
                || errorCode.contains("_text_not_found")
                || errorCode.contains("_not_unique")
                || errorCode.contains("_empty_match");
    }

    private static boolean isStaleObservation(String errorCode) {
        return errorCode.startsWith("operation_snapshot_")
                || errorCode.endsWith("_version_changed")
                || errorCode.endsWith("_definition_changed")
                || errorCode.endsWith("_target_changed")
                || errorCode.endsWith("_destination_exists")
                || errorCode.endsWith("_parent_not_found")
                || errorCode.endsWith("_path_not_found")
                || errorCode.endsWith("_directory_exists");
    }
}
