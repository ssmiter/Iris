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
                "user"
        );
        assertThat(enabled.nextFireAt()).isNotNull()
                .isAfter(Instant.now());
        assertThat(enabled.enabled()).isTrue();

        CronScheduleService.ScheduleView disabled = schedules.create(
                "暂停的任务",
                "0 0 9 * * *",
                "暂时不跑。",
                false,
                "user"
        );
        assertThat(disabled.nextFireAt()).isNull();

        assertThatThrownBy(() -> schedules.create(
                "坏表达式", "not a cron", "x", true, "user"
        )).isInstanceOf(IllegalArgumentException.class);
        assertThatThrownBy(() -> schedules.create(
                "空 prompt", "0 0 9 * * *", "  ", true, "user"
        )).isInstanceOf(IllegalArgumentException.class);
    }

    @Test
    void manualFireCreatesConversationRunAndExecution() {
        CronScheduleService.ScheduleView task = schedules.create(
                "手动验证",
                "0 0 6 * * *",
                "汇报当前工作区根目录下的文件数量。",
                true,
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
    void enableDisableAndDeleteKeepTheDurableTruthCoherent() {
        CronScheduleService.ScheduleView task = schedules.create(
                "生命周期",
                "0 30 8 * * *",
                "例行检查。",
                true,
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
        List<String> names = listing.items().stream()
                .map(CapabilityAdminService.AdminItem::name)
                .toList();
        assertThat(names).containsExactlyInAnyOrder(
                "create_schedule",
                "set_schedule_enabled",
                "delete_schedule",
                "run_schedule_now"
        );
    }
}
