package com.iris.tools.core;

import org.junit.jupiter.api.Test;

import java.io.IOException;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.TreeMap;
import java.util.TreeSet;
import java.util.regex.Matcher;
import java.util.regex.Pattern;
import java.util.stream.Stream;

import static org.assertj.core.api.Assertions.assertThat;

/**
 * docs/43 S2 的守卫：源码里产出的每个 errorCode 都必须落在
 * ToolErrorRecoveryCatalog 的已知族里。新造一个未登记的码（比如
 * {@code new ToolRuntimeException("workspace_checksum_mismatch", ...)}）
 * 本测试直接红灯——先登记或改用开放规则族命名，再合入。
 */
class ToolErrorRecoveryCatalogTest {

    private static String actionOf(String phase, String errorCode, String tool) {
        return ToolErrorRecoveryCatalog
                .recoveryFor(phase, errorCode, tool)
                .action();
    }

    @Test
    void keepsPostM4RecoveryDecisions() {
        // 取消族（M4 补入 cancelled / process_cancelled）
        assertThat(actionOf("failed", "cancelled", null)).isEqualTo("stop");
        assertThat(actionOf("failed", "process_cancelled", null))
                .isEqualTo("stop");
        assertThat(actionOf("failed", "tool_cancelled", null))
                .isEqualTo("stop");
        assertThat(actionOf("failed", "cancelled_before_commit", null))
                .isEqualTo("stop");
        assertThat(actionOf("failed", "run_stopped", null)).isEqualTo("stop");
        // not_inspected 族（M4 补入 pipeline_not_inspected）
        assertThat(actionOf("failed", "pipeline_not_inspected", null))
                .isEqualTo("read_definition_then_retry");
        assertThat(actionOf("failed", "capability_not_inspected", null))
                .isEqualTo("read_definition_then_retry");
        assertThat(actionOf("failed", "capability_definition_changed", null))
                .isEqualTo("read_definition_then_retry");
        // not_applied 无前缀限制（M4 去掉 browser_ 前缀限制）
        assertThat(actionOf("failed", "workspace_checkpoint_not_applied", null))
                .isEqualTo("observe_then_retry");
        assertThat(actionOf("failed", "browser_action_not_applied", null))
                .isEqualTo("observe_then_retry");
        // timeout 族（M4 补入 process_timeout）
        assertThat(actionOf("failed", "process_timeout", null))
                .isEqualTo("retry_if_still_needed");
        assertThat(actionOf("failed", "tool_timeout", null))
                .isEqualTo("retry_if_still_needed");
        assertThat(actionOf("failed", "tool_timeout_before_execution", null))
                .isEqualTo("retry_if_still_needed");
        // outcome_unknown 分层
        assertThat(actionOf(
                "outcome_unknown",
                "browser_action_still_unknown",
                "browser_click"
        )).isEqualTo("observe_and_reconcile");
        assertThat(actionOf(
                "outcome_unknown",
                "postcondition_unknown",
                "browser_click"
        )).isEqualTo("observe_and_reconcile");
        assertThat(actionOf(
                "outcome_unknown",
                "postcondition_unknown",
                "write_file"
        )).isEqualTo("inspect_before_retry");
        assertThat(actionOf(
                "outcome_unknown",
                "browser_action_outcome_unknown",
                "browser_click"
        )).isEqualTo("inspect_browser_action");
        assertThat(actionOf("outcome_unknown", "process_crashed", "write_file"))
                .isEqualTo("inspect_before_retry");
        // phase 驱动
        assertThat(actionOf("rejected", "user_changed_mind", null))
                .isEqualTo("stop");
        assertThat(actionOf("expired", "expired", null))
                .isEqualTo("prepare_again");
        assertThat(actionOf("failed", "snapshot_expired", null))
                .isEqualTo("prepare_again");
        // 开放规则族与兜底
        assertThat(actionOf("failed", "invalid_tool_input", null))
                .isEqualTo("correct_input");
        assertThat(actionOf("failed", "workspace_file_version_changed", null))
                .isEqualTo("observe_then_retry");
        assertThat(actionOf(
                "failed",
                "resident_tool_requires_direct_call",
                null
        )).isEqualTo("call_resident_tool_directly");
        assertThat(actionOf("failed", "artifact_not_found", null))
                .isEqualTo("replan");
        // 钉死现状：动态取消码未入取消族，落兜底（改族需改 docs/21）
        assertThat(actionOf("failed", "cancelled_before_prepare", null))
                .isEqualTo("replan");
    }

    @Test
    void registeredReplanCodesActuallyResolveToReplan() {
        for (String code : ToolErrorRecoveryCatalog.registeredReplanCodes()) {
            assertThat(actionOf("failed", code, "some_tool"))
                    .as("KNOWN_REPLAN 登记的 %s 必须仍落 replan", code)
                    .isEqualTo("replan");
        }
    }

    // ---- 守卫：扫描产码点源码 ----

    /**
     * 产码点模式。新增「会产生 observation errorCode 的构造点」时必须
     * 在此登记，否则守卫对那条路径失明。
     */
    private static final Pattern PRODUCER_CALL = Pattern.compile(
            "new\\s+(?:com\\.iris\\.tools\\.core\\.)?ToolRuntimeException\\("
                    + "|(?:com\\.iris\\.tools\\.core\\.)?ToolRuntimeException"
                    + "\\.beforeCommit\\("
                    + "|ToolOutcome\\.(?:failed|unknown)\\("
                    + "|completeFailure\\("
                    + "|insertSyntheticTerminalExecution\\("
                    + "|errorCode\\(exception,"
                    + "|errorCode\\s*=\\s*(?=\")"
                    + "|new\\s+\\w*Failure\\("
                    + "|actionOutcome\\("
    );

    /** 浏览器扩展里 error(code, message) 是 Failure 之外的产码出口。 */
    private static final Pattern EXTENSION_ERROR_CALL =
            Pattern.compile("(?<![.\\w])error\\(\\s*(?=\")");

    /** 小写 snake_case 字面量；中文人话文案与带空格的英文文案天然不匹配。 */
    private static final Pattern CODE_LITERAL =
            Pattern.compile("\"([a-z][a-z0-9_]{2,})\"");

    /**
     * 产码窗口里出现的非码字面量：合成终态记录的 phase 名
     * （failed / outcome_unknown），以及 Failure 构造窗口内顺带出现的
     * payload 字段键（message、status、stdout 等——它们是数据字段名，
     * 不是 errorCode；真给错误码起这种通用名本身就该被拒绝）。
     */
    private static final Set<String> NON_CODE_LITERALS = Set.of(
            "failed",
            "outcome_unknown",
            "message",
            "status",
            "runtime_id",
            "mount_name",
            "stdout",
            "stderr",
            "workspace_path"
    );

    private static final int CALL_WINDOW = 600;

    @Test
    void everyProducedErrorCodeIsRegistered() throws IOException {
        Map<String, Set<String>> unknown = new TreeMap<>();
        Path backendMain = backendMainSourceRoot();
        collectUnknownCodes(backendMain, false, unknown);
        Path extensions = extensionsSourceRoot();
        if (extensions != null) {
            collectUnknownCodes(extensions, true, unknown);
        }
        assertThat(unknown)
                .as("以下 errorCode 出现在产码点但未在 ToolErrorRecoveryCatalog "
                        + "登记：新码必须先入表（或改用开放规则族命名）再合入")
                .isEmpty();
    }

    private void collectUnknownCodes(
            Path root,
            boolean extensionTree,
            Map<String, Set<String>> unknown
    ) throws IOException {
        try (Stream<Path> files = Files.walk(root)) {
            for (Path file : files
                    .filter(path -> path.toString().endsWith(".java"))
                    .toList()) {
                String text = Files.readString(file);
                collectFromMatches(
                        PRODUCER_CALL.matcher(text),
                        text,
                        file,
                        unknown
                );
                if (extensionTree) {
                    collectFromMatches(
                            EXTENSION_ERROR_CALL.matcher(text),
                            text,
                            file,
                            unknown
                    );
                }
            }
        }
    }

    private void collectFromMatches(
            Matcher calls,
            String text,
            Path file,
            Map<String, Set<String>> unknown
    ) {
        while (calls.find()) {
            int start = calls.start();
            int end = Math.min(text.length(), start + CALL_WINDOW);
            int callEnd = text.indexOf(");", start);
            if (callEnd >= 0 && callEnd < end) {
                end = callEnd;
            }
            Matcher literals = CODE_LITERAL.matcher(text.substring(start, end));
            while (literals.find()) {
                String code = literals.group(1);
                if (NON_CODE_LITERALS.contains(code)) {
                    continue;
                }
                if (!ToolErrorRecoveryCatalog.isKnown(code)) {
                    unknown.computeIfAbsent(code, key -> new TreeSet<>())
                            .add(file.toString());
                }
            }
        }
    }

    private static Path backendMainSourceRoot() {
        Path fromModule = Path.of("src", "main", "java");
        if (Files.isDirectory(fromModule)) {
            return fromModule;
        }
        return Path.of("backend", "src", "main", "java");
    }

    private static Path extensionsSourceRoot() {
        Path fromModule = Path.of("..", "extensions").normalize();
        if (Files.isDirectory(fromModule)) {
            return fromModule;
        }
        Path fromRepoRoot = Path.of("extensions");
        return Files.isDirectory(fromRepoRoot) ? fromRepoRoot : null;
    }
}
