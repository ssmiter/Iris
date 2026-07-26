package com.iris.agent.run;

import com.iris.agent.run.RunRoundRepository.RoundRow;
import com.iris.agent.run.RunRoundRepository.RunRow;
import com.iris.conversation.application.RunEventEmitter;
import com.iris.conversation.domain.ConversationViews.FailureView;
import org.springframework.stereotype.Service;
import org.springframework.transaction.support.TransactionTemplate;

import java.time.Clock;
import java.util.UUID;
import java.util.concurrent.locks.ReentrantLock;

@Service
public class RunRoundService {
    private static final int LOCK_COUNT = 64;

    private final RunRoundRepository repository;
    private final TransactionTemplate transactions;
    private final RunEventEmitter events;
    private final RunFailureRepository failures;
    private final Clock clock = Clock.systemUTC();
    private final ReentrantLock[] locks = new ReentrantLock[LOCK_COUNT];

    public RunRoundService(
            RunRoundRepository repository,
            TransactionTemplate transactions,
            RunEventEmitter events,
            RunFailureRepository failures
    ) {
        this.repository = repository;
        this.transactions = transactions;
        this.events = events;
        this.failures = failures;
        for (int index = 0; index < LOCK_COUNT; index++) {
            locks[index] = new ReentrantLock();
        }
    }

    public RoundRow openRound(String runId) {
        RoundRow opened = withLock(runId, () -> transactions.execute(status -> {
            RunRow run = requireRun(runId);
            if (!"agentic".equals(run.kind())) {
                throw new IllegalStateException(
                        "Pipeline Run 不创建 Agentic Round"
                );
            }
            if (run.phase() != RunPhase.RUNNING) {
                throw new IllegalStateException(
                        "只有 running Agentic Run 可以开始 Round"
                );
            }
            int index = repository.nextRoundIndex(runId);
            String roundId = id("round");
            repository.insertRound(
                    roundId,
                    run,
                    index,
                    clock.instant()
            );
            return repository.findRound(roundId).orElseThrow();
        }));
        events.roundStarted(opened.roundId());
        events.runUpdated(runId);
        return opened;
    }

    public RunRow transitionRun(
            String runId,
            long expectedVersion,
            RunPhase target
    ) {
        RunRow transitioned = withLock(runId, () -> transactions.execute(status -> {
            RunRow current = requireRun(runId);
            if (current.version() != expectedVersion) {
                throw new IllegalStateException("Run version 已变化");
            }
            RunStateMachine.requireTransition(current.phase(), target);
            if (!repository.transitionRun(
                    runId,
                    current.phase(),
                    target,
                    expectedVersion,
                    clock.instant()
            )) {
                throw new IllegalStateException("Run transition 发生并发冲突");
            }
            return requireRun(runId);
        }));
        if (target.terminal()) {
            events.runSettled(runId);
        } else {
            events.runUpdated(runId);
        }
        return transitioned;
    }

    public RunRow failRun(
            String runId,
            long expectedVersion,
            FailureView failure
    ) {
        if (failure == null) {
            throw new IllegalArgumentException("FailureView is required");
        }
        RunRow transitioned = withLock(runId, () ->
                transactions.execute(status -> {
                    RunRow current = requireRun(runId);
                    if (current.version() != expectedVersion) {
                        throw new IllegalStateException(
                                "Run version 已变化"
                        );
                    }
                    RunStateMachine.requireTransition(
                            current.phase(),
                            RunPhase.FAILED
                    );
                    var now = clock.instant();
                    if (!repository.transitionRun(
                            runId,
                            current.phase(),
                            RunPhase.FAILED,
                            expectedVersion,
                            now
                    )) {
                        throw new IllegalStateException(
                                "Run failure transition 发生并发冲突"
                        );
                    }
                    failures.insert(runId, failure, now);
                    return requireRun(runId);
                })
        );
        events.runSettled(runId);
        return transitioned;
    }

    public RoundRow transitionRound(
            String roundId,
            long expectedVersion,
            RoundPhase target
    ) {
        RoundRow initial = repository.findRound(roundId).orElseThrow(
                () -> new IllegalStateException("找不到 Round")
        );
        RoundRow transitioned = withLock(initial.runId(), () -> transactions.execute(status -> {
            RoundRow current = repository.findRound(roundId).orElseThrow();
            if (current.version() != expectedVersion) {
                throw new IllegalStateException("Round version 已变化");
            }
            RunStateMachine.requireTransition(current.phase(), target);
            if (!repository.transitionRound(
                    roundId,
                    current.phase(),
                    target,
                    expectedVersion,
                    clock.instant()
            )) {
                throw new IllegalStateException(
                        "Round transition 发生并发冲突"
                );
            }
            return repository.findRound(roundId).orElseThrow();
        }));
        events.roundUpdated(roundId);
        return transitioned;
    }

    private RunRow requireRun(String runId) {
        return repository.findRun(runId).orElseThrow(
                () -> new IllegalStateException("找不到 Run")
        );
    }

    private <T> T withLock(String key, java.util.concurrent.Callable<T> work) {
        ReentrantLock lock = locks[Math.floorMod(key.hashCode(), locks.length)];
        lock.lock();
        try {
            T result = work.call();
            if (result == null) {
                throw new IllegalStateException("状态 transaction 无返回值");
            }
            return result;
        } catch (RuntimeException exception) {
            throw exception;
        } catch (Exception exception) {
            throw new IllegalStateException("Run/Round operation failed", exception);
        } finally {
            lock.unlock();
        }
    }

    private String id(String prefix) {
        return prefix + "_" + UUID.randomUUID().toString().replace("-", "");
    }
}
