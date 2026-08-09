package com.iris.tools.core;

import org.springframework.boot.ApplicationArguments;
import org.springframework.boot.ApplicationRunner;
import org.springframework.core.annotation.Order;
import org.springframework.stereotype.Component;
import org.springframework.transaction.support.TransactionTemplate;

import java.time.Clock;

/**
 * 启动时只处理无法证明安全重试的中间态；等待审批或用户输入保持可恢复。
 */
@Component
@Order(10)
public class ToolRuntimeRecovery implements ApplicationRunner {
    private final ToolRuntimeRepository repository;
    private final TransactionTemplate transactions;
    private final Clock clock = Clock.systemUTC();

    public ToolRuntimeRecovery(
            ToolRuntimeRepository repository,
            TransactionTemplate transactions
    ) {
        this.repository = repository;
        this.transactions = transactions;
    }

    @Override
    public void run(ApplicationArguments args) {
        transactions.executeWithoutResult(status ->
                repository.reconcileInterrupted(clock.instant())
        );
    }
}
