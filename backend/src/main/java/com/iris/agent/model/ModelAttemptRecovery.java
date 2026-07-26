package com.iris.agent.model;

import org.springframework.boot.ApplicationArguments;
import org.springframework.boot.ApplicationRunner;
import org.springframework.core.annotation.Order;
import org.springframework.stereotype.Component;
import org.springframework.transaction.support.TransactionTemplate;

import java.time.Clock;

/**
 * A provider stream cannot be reconstructed after process loss. Preserve the
 * old attempt as interrupted, invalidate its partial answer projection, and
 * let normal Run recovery close the failed Round without reusing that stream.
 */
@Component
@Order(20)
public class ModelAttemptRecovery implements ApplicationRunner {
    private final ModelAttemptRepository repository;
    private final TransactionTemplate transactions;
    private final AnswerStreamProjector answerStreams;
    private final Clock clock = Clock.systemUTC();

    public ModelAttemptRecovery(
            ModelAttemptRepository repository,
            TransactionTemplate transactions,
            AnswerStreamProjector answerStreams
    ) {
        this.repository = repository;
        this.transactions = transactions;
        this.answerStreams = answerStreams;
    }

    @Override
    public void run(ApplicationArguments args) {
        transactions.executeWithoutResult(status ->
                repository.reconcileInterrupted(clock.instant())
        );
        answerStreams.recoverInterrupted();
    }
}
