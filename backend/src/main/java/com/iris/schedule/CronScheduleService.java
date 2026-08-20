package com.iris.schedule;

import com.iris.tools.catalog.CatalogGenerationService;
import org.springframework.context.ApplicationEventPublisher;
import org.springframework.jdbc.core.simple.JdbcClient;
import org.springframework.scheduling.support.CronExpression;
import org.springframework.stereotype.Service;
import org.springframework.transaction.support.TransactionTemplate;

import java.time.Clock;
import java.time.Instant;
import java.time.ZoneId;
import java.time.ZonedDateTime;
import java.util.List;
import java.util.Optional;
import java.util.UUID;

/**
 * Cron 任务的持久真相与变更入口（docs/33 §2）。所有写操作经版本乐观
 * 校验；任何变更后发布 {@link CronScheduleChangedEvent}，由
 * {@link CronScheduleLauncher} 重排进程内唤醒器。
 */
@Service
public class CronScheduleService {

    public static final int MAX_NAME_CHARS = 100;
    public static final int MAX_PROMPT_CHARS = 8_000;

    private final JdbcClient jdbc;
    private final TransactionTemplate transactions;
    private final ApplicationEventPublisher events;
    private final CatalogGenerationService generationService;
    private final Clock clock = Clock.systemUTC();

    public CronScheduleService(
            JdbcClient jdbc,
            TransactionTemplate transactions,
            ApplicationEventPublisher events,
            CatalogGenerationService generationService
    ) {
        this.jdbc = jdbc;
        this.transactions = transactions;
        this.events = events;
        this.generationService = generationService;
    }

    public ScheduleView create(
            String name,
            String expression,
            String prompt,
            boolean enabled,
            boolean once,
            String createdBy
    ) {
        String normalizedName = normalizeName(name);
        String normalizedExpression = normalizeExpression(expression);
        String normalizedPrompt = normalizePrompt(prompt);
        String taskId = "cron_" + UUID.randomUUID().toString().replace("-", "");
        Instant now = clock.instant();
        Instant nextFire = enabled
                ? nextFire(normalizedExpression, now)
                : null;
        transactions.executeWithoutResult(status -> jdbc.sql("""
                INSERT INTO cron_task(
                    task_id, name, expression, prompt, enabled, once,
                    next_fire_at, last_fire_at, fire_count,
                    created_by, version, created_at, updated_at
                ) VALUES (
                    :taskId, :name, :expression, :prompt, :enabled, :once,
                    :nextFireAt, NULL, 0,
                    :createdBy, 1, :now, :now
                )
                """)
                .param("taskId", taskId)
                .param("name", normalizedName)
                .param("expression", normalizedExpression)
                .param("prompt", normalizedPrompt)
                .param("enabled", enabled ? 1 : 0)
                .param("once", once ? 1 : 0)
                .param("nextFireAt", nextFire == null ? null : nextFire.toString())
                .param("createdBy", createdBy)
                .param("now", now.toString())
                .update());
        events.publishEvent(new CronScheduleChangedEvent(taskId));
        generationService.bump();
        return require(taskId);
    }

    public ScheduleView update(
            String taskId,
            long expectedVersion,
            String name,
            String expression,
            String prompt,
            Boolean once
    ) {
        ScheduleView current = require(taskId);
        String normalizedName = name == null
                ? current.name()
                : normalizeName(name);
        String normalizedExpression = expression == null
                ? current.expression()
                : normalizeExpression(expression);
        String normalizedPrompt = prompt == null
                ? current.prompt()
                : normalizePrompt(prompt);
        boolean nextOnce = once == null ? current.once() : once;
        Instant now = clock.instant();
        Instant nextFire = current.enabled()
                ? nextFire(normalizedExpression, now)
                : null;
        int updated = jdbc.sql("""
                UPDATE cron_task
                SET name = :name, expression = :expression, prompt = :prompt,
                    once = :once, next_fire_at = :nextFireAt,
                    version = version + 1, updated_at = :now
                WHERE task_id = :taskId AND version = :expectedVersion
                """)
                .param("name", normalizedName)
                .param("expression", normalizedExpression)
                .param("prompt", normalizedPrompt)
                .param("once", nextOnce ? 1 : 0)
                .param("nextFireAt", nextFire == null ? null : nextFire.toString())
                .param("now", now.toString())
                .param("taskId", taskId)
                .param("expectedVersion", expectedVersion)
                .update();
        requireUpdated(updated, taskId, expectedVersion);
        events.publishEvent(new CronScheduleChangedEvent(taskId));
        generationService.bump();
        return require(taskId);
    }

    public ScheduleView setEnabled(
            String taskId,
            long expectedVersion,
            boolean enabled
    ) {
        ScheduleView current = require(taskId);
        Instant now = clock.instant();
        Instant nextFire = enabled ? nextFire(current.expression(), now) : null;
        int updated = jdbc.sql("""
                UPDATE cron_task
                SET enabled = :enabled, next_fire_at = :nextFireAt,
                    version = version + 1, updated_at = :now
                WHERE task_id = :taskId AND version = :expectedVersion
                """)
                .param("enabled", enabled ? 1 : 0)
                .param("nextFireAt", nextFire == null ? null : nextFire.toString())
                .param("now", now.toString())
                .param("taskId", taskId)
                .param("expectedVersion", expectedVersion)
                .update();
        requireUpdated(updated, taskId, expectedVersion);
        events.publishEvent(new CronScheduleChangedEvent(taskId));
        generationService.bump();
        return require(taskId);
    }

    public void delete(String taskId, long expectedVersion) {
        require(taskId);
        transactions.executeWithoutResult(status -> {
            jdbc.sql("DELETE FROM cron_execution WHERE task_id = :taskId")
                    .param("taskId", taskId)
                    .update();
            int updated = jdbc.sql("""
                    DELETE FROM cron_task
                    WHERE task_id = :taskId AND version = :expectedVersion
                    """)
                    .param("taskId", taskId)
                    .param("expectedVersion", expectedVersion)
                    .update();
            requireUpdated(updated, taskId, expectedVersion);
        });
        events.publishEvent(new CronScheduleChangedEvent(taskId));
        generationService.bump();
    }

    /**
     * 触发一棒之前的护栏：把 next_fire_at 原子推进到下一棒。只有成功
     * 推进（这一棒仍归本次触发所有）的调用方才允许真正执行——崩溃最多
     * 漏一棒，两个并发唤醒器不会重复触发同一棒。
     *
     * <p>单次任务（once=1）触发后直接停用，不再排下一棒。</p>
     */
    boolean claimFire(String taskId, Instant expectedFireAt, Instant now) {
        ScheduleView current = require(taskId);
        if (current.once()) {
            int updated = jdbc.sql("""
                    UPDATE cron_task
                    SET enabled = 0, next_fire_at = NULL, last_fire_at = :now,
                        fire_count = fire_count + 1,
                        version = version + 1, updated_at = :now
                    WHERE task_id = :taskId AND next_fire_at = :expectedFireAt
                    """)
                    .param("now", now.toString())
                    .param("taskId", taskId)
                    .param("expectedFireAt", expectedFireAt.toString())
                    .update();
            return updated == 1;
        }
        Instant next = nextFire(current.expression(), now);
        int updated = jdbc.sql("""
                UPDATE cron_task
                SET next_fire_at = :nextFireAt, last_fire_at = :now,
                    fire_count = fire_count + 1,
                    version = version + 1, updated_at = :now
                WHERE task_id = :taskId AND next_fire_at = :expectedFireAt
                """)
                .param("nextFireAt", next == null ? null : next.toString())
                .param("now", now.toString())
                .param("taskId", taskId)
                .param("expectedFireAt", expectedFireAt.toString())
                .update();
        return updated == 1;
    }

    void recordManualFire(String taskId, Instant now) {
        jdbc.sql("""
                UPDATE cron_task
                SET last_fire_at = :now, fire_count = fire_count + 1,
                    version = version + 1, updated_at = :now
                WHERE task_id = :taskId
                """)
                .param("now", now.toString())
                .param("taskId", taskId)
                .update();
    }

    /**
     * 启动补扫：已过期的单次任务直接停用，不补跑。
     * 返回被停用的任务 ID 列表，便于调用方发布变更事件。
     */
    public List<String> disableExpiredOnceTasks(Instant now) {
        List<String> expired = jdbc.sql("""
                SELECT task_id FROM cron_task
                WHERE enabled = 1 AND once = 1
                  AND next_fire_at IS NOT NULL AND next_fire_at < :now
                """)
                .param("now", now.toString())
                .query((rs, rowNum) -> rs.getString("task_id"))
                .list();
        if (expired.isEmpty()) {
            return List.of();
        }
        jdbc.sql("""
                UPDATE cron_task
                SET enabled = 0, next_fire_at = NULL,
                    version = version + 1, updated_at = :now
                WHERE enabled = 1 AND once = 1
                  AND next_fire_at IS NOT NULL AND next_fire_at < :now
                """)
                .param("now", now.toString())
                .update();
        for (String taskId : expired) {
            events.publishEvent(new CronScheduleChangedEvent(taskId));
        }
        return expired;
    }

    public ScheduleView require(String taskId) {
        return find(taskId).orElseThrow(() -> new IllegalArgumentException(
                "Schedule not found: " + taskId
        ));
    }

    public Optional<ScheduleView> find(String taskId) {
        return jdbc.sql("""
                SELECT * FROM cron_task WHERE task_id = :taskId
                """)
                .param("taskId", taskId)
                .query((rs, rowNum) -> mapSchedule(rs))
                .optional();
    }

    public List<ScheduleView> list() {
        return jdbc.sql("""
                SELECT * FROM cron_task ORDER BY created_at, task_id
                """)
                .query((rs, rowNum) -> mapSchedule(rs))
                .list();
    }

    /** 到点（含过期）的启用任务；唤醒器每次 tick 全量领走。 */
    public List<ScheduleView> dueTasks(Instant now) {
        return jdbc.sql("""
                SELECT * FROM cron_task
                WHERE enabled = 1 AND next_fire_at IS NOT NULL
                  AND next_fire_at <= :now
                ORDER BY next_fire_at, task_id
                """)
                .param("now", now.toString())
                .query((rs, rowNum) -> mapSchedule(rs))
                .list();
    }

    /** 最近一棒的触发时刻；唤醒器据此决定下一次苏醒。 */
    public Optional<Instant> earliestNextFire() {
        return jdbc.sql("""
                SELECT MIN(next_fire_at) FROM cron_task
                WHERE enabled = 1 AND next_fire_at IS NOT NULL
                """)
                .query(String.class)
                .optional()
                .map(Instant::parse);
    }

    public List<ExecutionView> executions(String taskId, int limit) {
        int bounded = Math.min(Math.max(limit, 1), 100);
        return jdbc.sql("""
                SELECT * FROM cron_execution
                WHERE task_id = :taskId
                ORDER BY fired_at DESC, execution_id DESC
                LIMIT :limit
                """)
                .param("taskId", taskId)
                .param("limit", bounded)
                .query((rs, rowNum) -> new ExecutionView(
                        rs.getString("execution_id"),
                        rs.getString("task_id"),
                        rs.getString("trigger_kind"),
                        Instant.parse(rs.getString("fired_at")),
                        rs.getString("conversation_id"),
                        rs.getString("run_id"),
                        rs.getString("status"),
                        rs.getString("error")
                ))
                .list();
    }

    ExecutionView recordExecution(
            String taskId,
            String triggerKind,
            Instant firedAt,
            String conversationId,
            String runId,
            String status,
            String error
    ) {
        String executionId =
                "cronex_" + UUID.randomUUID().toString().replace("-", "");
        jdbc.sql("""
                INSERT INTO cron_execution(
                    execution_id, task_id, trigger_kind, fired_at,
                    conversation_id, run_id, status, error
                ) VALUES (
                    :executionId, :taskId, :triggerKind, :firedAt,
                    :conversationId, :runId, :status, :error
                )
                """)
                .param("executionId", executionId)
                .param("taskId", taskId)
                .param("triggerKind", triggerKind)
                .param("firedAt", firedAt.toString())
                .param("conversationId", conversationId)
                .param("runId", runId)
                .param("status", status)
                .param("error", error)
                .update();
        return new ExecutionView(
                executionId,
                taskId,
                triggerKind,
                firedAt,
                conversationId,
                runId,
                status,
                error
        );
    }

    private ScheduleView mapSchedule(java.sql.ResultSet rs)
            throws java.sql.SQLException {
        String nextFireAt = rs.getString("next_fire_at");
        String lastFireAt = rs.getString("last_fire_at");
        return new ScheduleView(
                rs.getString("task_id"),
                rs.getString("name"),
                rs.getString("expression"),
                rs.getString("prompt"),
                rs.getInt("enabled") == 1,
                rs.getInt("once") == 1,
                nextFireAt == null ? null : Instant.parse(nextFireAt),
                lastFireAt == null ? null : Instant.parse(lastFireAt),
                rs.getLong("fire_count"),
                rs.getString("created_by"),
                rs.getLong("version"),
                Instant.parse(rs.getString("created_at")),
                Instant.parse(rs.getString("updated_at"))
        );
    }

    private Instant nextFire(String expression, Instant after) {
        ZonedDateTime next = CronExpression.parse(expression)
                .next(ZonedDateTime.ofInstant(after, ZoneId.systemDefault()));
        if (next == null) {
            throw new IllegalArgumentException(
                    "Cron expression has no future fire time: " + expression
            );
        }
        return next.toInstant();
    }

    private String normalizeName(String name) {
        String normalized = name == null ? "" : name.trim();
        if (normalized.isBlank() || normalized.length() > MAX_NAME_CHARS) {
            throw new IllegalArgumentException(
                    "Schedule name must contain 1 to " + MAX_NAME_CHARS
                            + " characters"
            );
        }
        return normalized;
    }

    private String normalizeExpression(String expression) {
        String normalized = expression == null ? "" : expression.trim();
        if (!CronExpression.isValidExpression(normalized)) {
            throw new IllegalArgumentException(
                    "Invalid cron expression (六位：秒 分 时 日 月 周): "
                            + normalized
            );
        }
        return normalized;
    }

    private String normalizePrompt(String prompt) {
        String normalized = prompt == null ? "" : prompt.trim();
        if (normalized.isBlank() || normalized.length() > MAX_PROMPT_CHARS) {
            throw new IllegalArgumentException(
                    "Schedule prompt must contain 1 to " + MAX_PROMPT_CHARS
                            + " characters"
            );
        }
        return normalized;
    }

    private void requireUpdated(int updated, String taskId, long version) {
        if (updated != 1) {
            throw new IllegalStateException(
                    "Schedule " + taskId + " changed concurrently"
                            + " (expected version " + version + ")"
            );
        }
    }

    public record ScheduleView(
            String taskId,
            String name,
            String expression,
            String prompt,
            boolean enabled,
            boolean once,
            Instant nextFireAt,
            Instant lastFireAt,
            long fireCount,
            String createdBy,
            long version,
            Instant createdAt,
            Instant updatedAt
    ) { }

    public record ExecutionView(
            String executionId,
            String taskId,
            String triggerKind,
            Instant firedAt,
            String conversationId,
            String runId,
            String status,
            String error
    ) { }
}
