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
        // 会话列表是全量侧栏展示（WonWork/Iris 侧栏不分页），上限独立于消息分页的 100——
        // 100 是单会话历史消息翻页的合理页大小，套到"全部会话数"上会让启动期
        // 会话列表加载确定性 400（前端按全量 pageSize 拉取）。
        int safeLimit = validateLimit(limit, 30, 100000);
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
        return validateLimit(limit, defaultLimit, 100);
    }

    private int validateLimit(int limit, int defaultLimit, int maxLimit) {
        int value = limit <= 0 ? defaultLimit : limit;
        if (value > maxLimit) {
            throw new ApiProblemException(
                    HttpStatus.BAD_REQUEST,
                    "invalid_request",
                    "validation",
                    "limit 不能超过 " + maxLimit + "。"
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
