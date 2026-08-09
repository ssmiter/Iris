package com.iris.agent.run;

import com.iris.agent.run.RunRoundRepository.RoundRow;
import com.iris.agent.run.RunRoundRepository.RunRow;
import org.springframework.stereotype.Service;
import org.springframework.transaction.support.TransactionTemplate;

import java.time.Clock;

/** Claims queued Run messages exactly once at an Agentic Round boundary. */
@Service
public class RunMailboxInjectionService {
    private final RunMailboxRepository mailbox;
    private final TransactionTemplate transactions;
    private final RunMailboxEventEmitter events;
    private final Clock clock = Clock.systemUTC();

    public RunMailboxInjectionService(
            RunMailboxRepository mailbox,
            TransactionTemplate transactions,
            RunMailboxEventEmitter events
    ) {
        this.mailbox = mailbox;
        this.transactions = transactions;
        this.events = events;
    }

    public int injectPending(RunRow run, RoundRow round) {
        java.util.List<RunMailboxRepository.MailboxMessage> injected =
                transactions.execute(status -> {
            java.util.ArrayList<RunMailboxRepository.MailboxMessage> claimed =
                    new java.util.ArrayList<>();
            for (RunMailboxRepository.MailboxMessage message
                    : mailbox.pendingFor(
                            run.runId(),
                            run.branchId(),
                            run.root()
                    )) {
                if (mailbox.markInjected(
                        message.messageId(),
                        run.runId(),
                        round.roundId(),
                        clock.instant()
                )) {
                    claimed.add(message);
                }
            }
            return java.util.List.copyOf(claimed);
        });
        if (injected == null) {
            return 0;
        }
        for (RunMailboxRepository.MailboxMessage message : injected) {
            events.injected(new RunMailboxRepository.MailboxMessage(
                    message.messageId(),
                    run.runId(),
                    message.sourceRunId(),
                    message.kind(),
                    message.content(),
                    message.payload(),
                    "injected",
                    round.roundId(),
                    message.createdAt()
            ));
        }
        return injected.size();
    }
}
