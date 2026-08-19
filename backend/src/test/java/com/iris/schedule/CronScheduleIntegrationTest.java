package com.iris.schedule;

import com.iris.tools.catalog.CapabilityAdminService;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.test.context.DynamicPropertyRegistry;
import org.springframework.test.context.DynamicPropertySource;

import java.io.IOException;
import java.nio.file.Files;
import java.nio.file.Path;
import java.time.Instant;
import java.time.temporal.ChronoUnit;
import java.util.List;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

/**
 * Cron 调度全链路（docs/33 §2）：持久真相 CRUD → 唤醒器认领 →
 * 到点创建会话 + root Run → 执行记录；以及 /system/schedule 模型工具
 * 进入能力目录投影。
 */
@SpringBootTest
class CronScheduleIntegrationTest {

    private static final Path DATABASE = Path.of(
            "target", "test-data", "cron-schedule.db"
    ).toAbsolutePath();
    private static final Path WORKSPACE = Path.of(
            "target", "test-cron-workspace"
    ).toAbsolutePath();

    @Autowired
    private CronScheduleService schedules;

    @Autowired
    private CronFireService fires;

    @Autowired
    private CronScheduleLauncher launcher;

    @Autowired
    private CapabilityAdminService capabilityAdmin;

    @Autowired
    private JdbcTemplate jdbc;

    @DynamicPropertySource
    static void testProperties(DynamicPropertyRegistry registry)
            throws IOException {
        Files.createDirectories(DATABASE.getParent());
        Files.deleteIfExists(DATABASE);
        Files.deleteIfExists(Path.of(DATABASE + "-wal"));
        Files.deleteIfExists(Path.of(DATABASE + "-shm"));
        Files.createDirectories(WORKSPACE);
        registry.add(
                "spring.datasource.url",
                () -> "jdbc:sqlite:" + DATABASE.toString().replace('\\', '/')
        );
        registry.add("iris.workspace", WORKSPACE::toString);
    }

    @Test
    void createComputesNextFireAndValidationIsFailClosed() {
        CronScheduleService.ScheduleView enabled = schedules.create(
                "每日晨间整理",
                "0 0 9 * * *",
                "整理昨天的零散记录，给出三件最值得跟进的事。",
                true,
                false,
                "user"
        );
        assertThat(enabled.nextFireAt()).isNotNull()
                .isAfter(Instant.now());
        assertThat(enabled.enabled()).isTrue();
        assertThat(enabled.once()).isFalse();

        CronScheduleService.ScheduleView once = schedules.create(
                "明天提醒",
                "0 0 8 * * *",
                "明早 8 点提醒一次。",
                true,
                true,
                "user"
        );
        assertThat(once.once()).isTrue();
        assertThat(once.nextFireAt()).isNotNull();

        CronScheduleService.ScheduleView disabled = schedules.create(
                "暂停的任务",
                "0 0 9 * * *",
                "暂时不跑。",
                false,
                false,
                "user"
        );
        assertThat(disabled.nextFireAt()).isNull();

        assertThatThrownBy(() -> schedules.create(
                "坏表达式", "not a cron", "x", true, false, "user"
        )).isInstanceOf(IllegalArgumentException.class);
        assertThatThrownBy(() -> schedules.create(
                "空 prompt", "0 0 9 * * *", "  ", true, false, "user"
        )).isInstanceOf(IllegalArgumentException.class);
    }

    @Test
    void manualFireCreatesConversationRunAndExecution() {
        CronScheduleService.ScheduleView task = schedules.create(
                "手动验证",
                "0 0 6 * * *",
                "汇报当前工作区根目录下的文件数量。",
                true,
                false,
                "user"
        );
        CronScheduleService.ExecutionView execution = fires.fireNow(
                task.taskId()
        );
        assertThat(execution.status()).isEqualTo("fired");
        assertThat(execution.triggerKind()).isEqualTo("manual");
        assertThat(execution.conversationId()).isNotBlank();
        assertThat(execution.runId()).isNotBlank();

        Integer runs = jdbc.queryForObject(
                "SELECT COUNT(*) FROM agent_run WHERE run_id = ?",
                Integer.class,
                execution.runId()
        );
        assertThat(runs).isEqualTo(1);
        Integer turns = jdbc.queryForObject(
                "SELECT COUNT(*) FROM conversation_turn"
                        + " WHERE conversation_id = ?",
                Integer.class,
                execution.conversationId()
        );
        assertThat(turns).isEqualTo(1);

        // 手动触发不动排程
        CronScheduleService.ScheduleView after = schedules.require(
                task.taskId()
        );
        assertThat(after.nextFireAt()).isEqualTo(task.nextFireAt());
        assertThat(after.fireCount()).isEqualTo(task.fireCount() + 1);
    }

    @Test
    void tickClaimsDueTasksAndAdvancesTheNextFire() {
        CronScheduleService.ScheduleView task = schedules.create(
                "到期任务",
                "0 0 9 * * *",
                "到点要做的事。",
                true,
                false,
                "user"
        );
        Instant past = Instant.now().minus(1, ChronoUnit.HOURS);
        jdbc.update(
                "UPDATE cron_task SET next_fire_at = ? WHERE task_id = ?",
                past.toString(),
                task.taskId()
        );

        launcher.tick();

        CronScheduleService.ScheduleView after = schedules.require(
                task.taskId()
        );
        assertThat(after.fireCount()).isEqualTo(1);
        assertThat(after.lastFireAt()).isNotNull();
        assertThat(after.nextFireAt()).isNotNull()
                .isAfter(Instant.now());

        List<CronScheduleService.ExecutionView> executions =
                schedules.executions(task.taskId(), 10);
        assertThat(executions).hasSize(1);
        assertThat(executions.getFirst().triggerKind()).isEqualTo("schedule");
        assertThat(executions.getFirst().status()).isEqualTo("fired");

        // 同一棒不会重复触发：再 tick 一次不产生新执行
        launcher.tick();
        assertThat(schedules.executions(task.taskId(), 10)).hasSize(1);
    }

    @Test
    void onceTaskFiresAndDisablesItself() {
        CronScheduleService.ScheduleView task = schedules.create(
                "单次提醒",
                "0 0 9 * * *",
                "喝水提醒。",
                true,
                true,
                "user"
        );
        assertThat(task.once()).isTrue();
        Instant past = Instant.now().minus(1, ChronoUnit.MINUTES);
        jdbc.update(
                "UPDATE cron_task SET next_fire_at = ? WHERE task_id = ?",
                past.toString(),
                task.taskId()
        );

        launcher.tick();

        CronScheduleService.ScheduleView after = schedules.require(
                task.taskId()
        );
        assertThat(after.fireCount()).isEqualTo(1);
        assertThat(after.enabled()).isFalse();
        assertThat(after.nextFireAt()).isNull();
        assertThat(after.lastFireAt()).isNotNull();

        List<CronScheduleService.ExecutionView> executions =
                schedules.executions(task.taskId(), 10);
        assertThat(executions).hasSize(1);
        assertThat(executions.getFirst().triggerKind()).isEqualTo("schedule");
        assertThat(executions.getFirst().status()).isEqualTo("fired");

        // 已停用的单次任务不会再触发
        launcher.tick();
        assertThat(schedules.executions(task.taskId(), 10)).hasSize(1);
        assertThat(schedules.require(task.taskId()).enabled()).isFalse();
    }

    @Test
    void expiredOnceTaskIsDisabledOnStartupWithoutFiring() {
        CronScheduleService.ScheduleView task = schedules.create(
                "过期单次提醒",
                "0 0 9 * * *",
                "五分钟后的提醒。",
                true,
                true,
                "user"
        );
        Instant longPast = Instant.now().minus(3, ChronoUnit.DAYS);
        jdbc.update(
                "UPDATE cron_task SET next_fire_at = ? WHERE task_id = ?",
                longPast.toString(),
                task.taskId()
        );

        schedules.disableExpiredOnceTasks(Instant.now());

        CronScheduleService.ScheduleView after = schedules.require(
                task.taskId()
        );
        assertThat(after.enabled()).isFalse();
        assertThat(after.nextFireAt()).isNull();
        assertThat(after.fireCount()).isZero();
        assertThat(schedules.executions(task.taskId(), 10)).isEmpty();
    }

    @Test
    void manualFireDoesNotDisableOnceTask() {
        CronScheduleService.ScheduleView task = schedules.create(
                "单次但手动",
                "0 0 9 * * *",
                "手动验证。",
                true,
                true,
                "user"
        );
        CronScheduleService.ExecutionView execution = fires.fireNow(
                task.taskId()
        );
        assertThat(execution.status()).isEqualTo("fired");

        CronScheduleService.ScheduleView after = schedules.require(
                task.taskId()
        );
        assertThat(after.enabled()).isTrue();
        assertThat(after.nextFireAt()).isNotNull();
        assertThat(after.fireCount()).isEqualTo(1);
    }

    @Test
    void enableDisableAndDeleteKeepTheDurableTruthCoherent() {
        CronScheduleService.ScheduleView task = schedules.create(
                "生命周期",
                "0 30 8 * * *",
                "例行检查。",
                true,
                false,
                "user"
        );
        CronScheduleService.ScheduleView disabled = schedules.setEnabled(
                task.taskId(), task.version(), false
        );
        assertThat(disabled.enabled()).isFalse();
        assertThat(disabled.nextFireAt()).isNull();

        CronScheduleService.ScheduleView reenabled = schedules.setEnabled(
                task.taskId(), disabled.version(), true
        );
        assertThat(reenabled.nextFireAt()).isNotNull()
                .isAfter(Instant.now());

        assertThatThrownBy(() -> schedules.setEnabled(
                task.taskId(), disabled.version(), false
        )).isInstanceOf(IllegalStateException.class);

        schedules.delete(task.taskId(), reenabled.version());
        assertThat(schedules.find(task.taskId())).isEmpty();
    }

    @Test
    void scheduleToolsAreDiscoverableUnderSystemSchedule() {
        var listing = capabilityAdmin.items("/system/schedule", null, null);
        List<String> toolNames = listing.items().stream()
                .filter(item -> item.path().contains("schedule")
                        && !"schedule".equals(item.kind()))
                .map(CapabilityAdminService.AdminItem::name)
                .toList();
        assertThat(toolNames).containsExactlyInAnyOrder(
                "create_schedule",
                "set_schedule_enabled",
                "delete_schedule",
                "run_schedule_now"
        );
    }

    @Test
    void enabledSchedulesProjectAsScheduleLeaves() {
        CronScheduleService.ScheduleView enabled = schedules.create(
                "目录投影可见",
                "0 0 7 * * *",
                "看看今天的待办。",
                true,
                false,
                "user"
        );
        CronScheduleService.ScheduleView disabled = schedules.create(
                "目录投影不可见",
                "0 0 7 * * *",
                "停用期间不进模型视野。",
                false,
                false,
                "user"
        );

        var listing = capabilityAdmin.items("/system/schedule", null, null);
        var byPath = listing.items().stream()
                .collect(java.util.stream.Collectors.toMap(
                        CapabilityAdminService.AdminItem::path,
                        item -> item
                ));

        String enabledPath = "/system/schedule/" + enabled.taskId();
        assertThat(byPath).containsKey(enabledPath);
        var leaf = byPath.get(enabledPath);
        assertThat(leaf.kind()).isEqualTo("schedule");
        assertThat(leaf.origin()).isEqualTo("schedule");
        assertThat(leaf.name()).isEqualTo("目录投影可见");
        assertThat(leaf.availabilityReason()).contains("下次触发");

        assertThat(byPath)
                .doesNotContainKey("/system/schedule/" + disabled.taskId());

        // 详情走投影源的 manifest 快照
        var detail = capabilityAdmin.detail(enabledPath);
        assertThat(detail).isPresent();
        assertThat(detail.get().definition().path("expression").asText())
                .isEqualTo("0 0 7 * * *");
    }

    @Test
    void scheduleLeafManifestCarriesOnceFlag() {
        CronScheduleService.ScheduleView once = schedules.create(
                "单次叶子",
                "0 0 10 * * *",
                "单次任务测试。",
                true,
                true,
                "user"
        );
        CronScheduleService.ScheduleView recurring = schedules.create(
                "周期叶子",
                "0 0 10 * * *",
                "周期任务测试。",
                true,
                false,
                "user"
        );

        var onceDetail = capabilityAdmin.detail(
                "/system/schedule/" + once.taskId()
        );
        assertThat(onceDetail).isPresent();
        assertThat(onceDetail.get().definition().path("once").asBoolean())
                .isTrue();

        var recurringDetail = capabilityAdmin.detail(
                "/system/schedule/" + recurring.taskId()
        );
        assertThat(recurringDetail).isPresent();
        assertThat(recurringDetail.get().definition().path("once").asBoolean())
                .isFalse();
    }

    @Test
    void pipelineDetailCarriesRecentRuns() {
        // docs/33 §5：pipeline 详情附最近运行（数据来自既有表，零新表）。
        // 借 cron 手动触发造一个真实会话 + root Run，再补一行 pipeline Run 事实。
        CronScheduleService.ScheduleView host = schedules.create(
                "pipeline 运行记录宿主",
                "0 0 5 * * *",
                "占位 prompt。",
                true,
                false,
                "user"
        );
        CronScheduleService.ExecutionView fired = fires.fireNow(host.taskId());
        var hostRun = jdbc.queryForMap(
                "SELECT branch_id, turn_id FROM agent_run WHERE run_id = ?",
                fired.runId()
        );

        String pipelineRunId = "test-pipeline-run-" + host.taskId();
        Instant startedAt = Instant.now().minus(2, ChronoUnit.MINUTES);
        Instant endedAt = Instant.now().minus(1, ChronoUnit.MINUTES);
        jdbc.update("""
                INSERT INTO agent_run(
                    run_id, conversation_id, branch_id, turn_id,
                    parent_run_id, root_run_id, kind, purpose,
                    phase, version, started_at, ended_at
                ) VALUES (?, ?, ?, ?, ?, ?, 'pipeline', '标题生成',
                          'succeeded', 1, ?, ?)
                """,
                pipelineRunId,
                fired.conversationId(),
                hostRun.get("branch_id"),
                hostRun.get("turn_id"),
                fired.runId(),
                fired.runId(),
                startedAt.toString(),
                endedAt.toString()
        );
        jdbc.update("""
                INSERT INTO run_definition_snapshot(
                    run_id, definition_id, definition_version,
                    snapshot_hash, normalized_input_hash,
                    dependency_snapshot_ref, tool_calls_limit, time_limit_ms
                ) VALUES (?, 'iris.pipeline.conversation_title', '1',
                          'test-hash', 'test-input-hash', NULL, 0, 90000)
                """,
                pipelineRunId
        );
        jdbc.update("""
                INSERT INTO run_invocation(
                    run_id, parent_run_id, invoking_step_run_id,
                    trigger_kind, trigger_ref, requested_by, created_at
                ) VALUES (?, ?, NULL, 'system_event', NULL, 'test', ?)
                """,
                pipelineRunId,
                fired.runId(),
                endedAt.toString()
        );

        var detail = capabilityAdmin.detail(
                "/system/pipelines/conversation_title"
        );
        assertThat(detail).isPresent();
        assertThat(detail.get().item().kind()).isEqualTo("pipeline");
        assertThat(detail.get().item().origin()).isEqualTo("kernel");
        assertThat(detail.get().definition().path("id").asText())
                .isEqualTo("iris.pipeline.conversation_title");
        assertThat(detail.get().recentRuns()).isNotNull();
        var mine = detail.get().recentRuns().stream()
                .filter(run -> run.runId().equals(pipelineRunId))
                .findFirst();
        assertThat(mine).isPresent();
        assertThat(mine.get().triggerKind()).isEqualTo("system_event");
        assertThat(mine.get().phase()).isEqualTo("succeeded");
        assertThat(mine.get().conversationId())
                .isEqualTo(fired.conversationId());
    }
}
