package com.iris.conversation.application;

import com.iris.conversation.domain.ApiProblemException;
import com.iris.conversation.domain.ConversationViews.ContextUsageView;
import com.iris.conversation.domain.ConversationViews.ConversationPage;
import com.iris.conversation.domain.ConversationViews.ConversationView;
import com.iris.conversation.infrastructure.ConversationQueryRepository;
import org.springframework.http.HttpStatus;
import org.springframework.stereotype.Service;
import org.springframework.transaction.PlatformTransactionManager;
import org.springframework.transaction.support.TransactionTemplate;
import reactor.core.publisher.Mono;
import reactor.core.scheduler.Schedulers;

@Service
public final class ConversationQueryService {
    private final ConversationQueryRepository repository;
    private final TransactionTemplate readTransactions;

    public ConversationQueryService(
            ConversationQueryRepository repository,
            PlatformTransactionManager transactionManager
    ) {
        this.repository = repository;
        this.readTransactions = new TransactionTemplate(transactionManager);
        this.readTransactions.setReadOnly(true);
    }

    public Mono<ConversationPage> list(String cursor, int limit) {
        int safeLimit = validateLimit(limit, 30);
        return Mono.fromCallable(() -> requireResult(
                        readTransactions.execute(status ->
                                repository.list(cursor, safeLimit)
                        )
                ))
                .subscribeOn(Schedulers.boundedElastic());
    }

    public Mono<ConversationView> view(
            String conversationId,
            String branchId,
            String beforeTurnId,
            int limit
    ) {
        int safeLimit = validateLimit(limit, 50);
        return Mono.fromCallable(() -> requireResult(
                        readTransactions.execute(status -> repository.view(
                                conversationId,
                                branchId,
                                beforeTurnId,
                                safeLimit
                        ))
                ))
                .subscribeOn(Schedulers.boundedElastic());
    }

    public Mono<ContextUsageView> contextUsage(
            String conversationId,
            String branchId
    ) {
        return Mono.fromCallable(() -> readTransactions.execute(status ->
                        repository.contextUsage(conversationId, branchId)
                                .orElse(new ContextUsageView(0, 0, 0))
                ))
                .subscribeOn(Schedulers.boundedElastic());
    }

    private int validateLimit(int limit, int defaultLimit) {
        int value = limit <= 0 ? defaultLimit : limit;
        if (value > 100) {
            throw new ApiProblemException(
                    HttpStatus.BAD_REQUEST,
                    "invalid_request",
                    "validation",
                    "limit 不能超过 100。"
            );
        }
        return value;
    }

    private <T> T requireResult(T result) {
        if (result == null) {
            throw new IllegalStateException("Read transaction returned no result");
        }
        return result;
    }
}
