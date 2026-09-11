package com.iris.schedule;

import com.iris.conversation.application.ConversationCommandService;
import com.iris.conversation.domain.ConversationCommands.CreateConversationRequest;
import com.iris.conversation.domain.ConversationCommands.CreateTurnRequest;
import com.iris.conversation.domain.ConversationCommands.TurnInput;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.stereotype.Service;

import java.time.Clock;
import java.time.Instant;
import java.util.List;
import java.util.UUID;

/**
 * 到点执行（docs/33 §2）：为任务创建新会话 + Turn 事实并落库。
 * 客观能力层不启动模型 Run——前端 Runtime 通过 /api/history 发现
 * 新 fired 会话后自行驱动模型 Loop。执行记录先写失败态再改成功态。
 */
@Service
public class CronFireService {

    private static final Logger log = LoggerFactory.getLogger(
            CronFireService.class
    );

    private final CronScheduleService schedules;
    private final ConversationCommandService conversations;
    private final Clock clock = Clock.systemUTC();

    public CronFireService(
            CronScheduleService schedules,
            ConversationCommandService conversations
    ) {
        this.schedules = schedules;
        this.conversations = conversations;
    }

    /**
     * 计划触发：先原子认领这一棒（推进 next_fire_at），认领失败说明
     * 另一唤醒器已领走，直接返回。
     */
    public void fireScheduled(CronScheduleService.ScheduleView task) {
        Instant now = clock.instant();
        if (task.nextFireAt() == null
                || !schedules.claimFire(task.taskId(), task.nextFireAt(), now)) {
            return;
        }
        fire(task, "schedule", now);
    }

    /** 手动触发：不动排程，只记一棒执行。 */
    public CronScheduleService.ExecutionView fireNow(String taskId) {
        CronScheduleService.ScheduleView task = schedules.require(taskId);
        Instant now = clock.instant();
        schedules.recordManualFire(taskId, now);
        return fire(task, "manual", now);
    }

    private CronScheduleService.ExecutionView fire(
            CronScheduleService.ScheduleView task,
            String triggerKind,
            Instant firedAt
    ) {
        try {
            var conversation = conversations.createConversation(
                    "cron:" + task.taskId() + ":" + firedAt + ":" + UUID.randomUUID(),
                    new CreateConversationRequest(null)
            );
            var acceptance = conversations.acceptTurn(
                    conversation.conversationId(),
                    "cron-turn:" + task.taskId() + ":" + firedAt
                            + ":" + UUID.randomUUID(),
                    new CreateTurnRequest(
                            conversation.rootBranchId(),
                            "cron:" + task.taskId() + ":" + firedAt,
                            new TurnInput(task.prompt(), List.of()),
                            null
                    )
            );
            // 无后端 Run 可唤醒；rootRunId 仅为兼容字段，直接记 fired。
            return schedules.recordExecution(
                    task.taskId(),
                    triggerKind,
                    firedAt,
                    conversation.conversationId(),
                    acceptance.rootRunId(),
                    "fired",
                    null
            );
        } catch (RuntimeException failure) {
            log.warn(
                    "Cron task {} ({}) failed to fire",
                    task.taskId(),
                    task.name(),
                    failure
            );
            return schedules.recordExecution(
                    task.taskId(),
                    triggerKind,
                    firedAt,
                    null,
                    null,
                    "failed",
                    failure.getMessage() == null
                            ? failure.getClass().getSimpleName()
                            : failure.getMessage()
            );
        }
    }
}
