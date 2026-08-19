package com.iris.schedule;

import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.boot.ApplicationArguments;
import org.springframework.boot.ApplicationRunner;
import org.springframework.context.event.EventListener;
import org.springframework.core.annotation.Order;
import org.springframework.stereotype.Service;

import jakarta.annotation.PreDestroy;

import java.time.Clock;
import java.time.Duration;
import java.time.Instant;
import java.util.concurrent.Executors;
import java.util.concurrent.ScheduledExecutorService;
import java.util.concurrent.ScheduledFuture;
import java.util.concurrent.TimeUnit;

/**
 * 进程内唤醒器（docs/33 §2），与 {@code AgentRunLauncher} 同一哲学：
 * SQLite 的 next_fire_at 是真相，这里只维护一个指向最近一棒的定时器。
 * 启动即补扫——进程停了一段时间的到期任务在第一次 tick 全部认领；
 * 另有每日兜底重扫，防御时钟调整与漏事件。
 */
@Service
@Order(50)
public class CronScheduleLauncher implements ApplicationRunner {

    private static final Logger log = LoggerFactory.getLogger(
            CronScheduleLauncher.class
    );
    private static final long BACKSTOP_SCAN_MS = Duration.ofHours(24)
            .toMillis();

    private final CronScheduleService schedules;
    private final CronFireService fires;
    private final Clock clock = Clock.systemUTC();
    private final ScheduledExecutorService scheduler = Executors
            .newSingleThreadScheduledExecutor(runnable -> {
                Thread thread = new Thread(runnable, "cron-schedule-launcher");
                thread.setDaemon(true);
                return thread;
            });
    private ScheduledFuture<?> pending;

    public CronScheduleLauncher(
            CronScheduleService schedules,
            CronFireService fires
    ) {
        this.schedules = schedules;
        this.fires = fires;
    }

    @Override
    public void run(ApplicationArguments args) {
        Instant now = clock.instant();
        schedules.disableExpiredOnceTasks(now);
        reschedule();
    }

    @EventListener
    public void onChanged(CronScheduleChangedEvent event) {
        reschedule();
    }

    public synchronized void reschedule() {
        if (pending != null) {
            pending.cancel(false);
            pending = null;
        }
        long delay = schedules.earliestNextFire()
                .map(next -> Math.max(
                        0,
                        next.toEpochMilli() - clock.millis()
                ))
                .orElse(BACKSTOP_SCAN_MS);
        pending = scheduler.schedule(
                this::tickSafely,
                Math.min(delay, BACKSTOP_SCAN_MS),
                TimeUnit.MILLISECONDS
        );
    }

    private void tickSafely() {
        try {
            tick();
        } catch (RuntimeException failure) {
            log.warn("Cron schedule tick failed; rescheduling", failure);
        } finally {
            reschedule();
        }
    }

    @PreDestroy
    public void shutdown() {
        scheduler.shutdownNow();
    }

    /** 领走全部到点任务并逐棒触发。包私有以便集成测试直接驱动。 */
    void tick() {
        Instant now = clock.instant();
        for (CronScheduleService.ScheduleView task : schedules.dueTasks(now)) {
            try {
                fires.fireScheduled(task);
            } catch (RuntimeException failure) {
                log.warn(
                        "Cron task {} ({}) could not be claimed or fired",
                        task.taskId(),
                        task.name(),
                        failure
                );
            }
        }
    }
}
