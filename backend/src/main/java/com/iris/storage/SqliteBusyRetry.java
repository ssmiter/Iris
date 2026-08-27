package com.iris.storage;

import org.springframework.dao.DataAccessException;
import org.springframework.transaction.support.TransactionTemplate;

import java.util.function.Supplier;

/**
 * SQLite 写者竞争的整事务重试（docs/40 §2.2）。
 *
 * <p>粒度是整个事务而不是单条语句：BUSY_SNAPSHOT 之后读快照已过期，
 * 只有回滚重来、重新 SELECT 才可能成功（docs/40 §1）。
 * TransactionTemplate 每次 execute 都开新事务，天然满足这个语义。
 * 重试仅命中 {@link SqliteContention#isBusy}；其他异常原样抛出。
 *
 * <p>docs/40 §2.1 的 IMMEDIATE 落地后这类错误理论上不再产生——这是第二道防线，
 * 覆盖 BEGIN 等锁超过 busy_timeout 的极端情形，不是工作机制。
 */
public final class SqliteBusyRetry {
    private static final int MAX_RETRIES = 2;
    private static final long[] BACKOFF_MILLIS = {50, 100};

    private SqliteBusyRetry() {
    }

    /** 在独立事务里执行 body，busy 时整事务回滚重试（最多 {@value #MAX_RETRIES} 次）。 */
    public static <T> T execute(TransactionTemplate transactions, Supplier<T> body) {
        for (int attempt = 0; attempt <= MAX_RETRIES; attempt++) {
            try {
                return transactions.execute(status -> body.get());
            } catch (DataAccessException error) {
                if (!SqliteContention.isBusy(error) || attempt == MAX_RETRIES) {
                    throw error;
                }
                sleep(BACKOFF_MILLIS[attempt]);
            }
        }
        throw new IllegalStateException("unreachable");
    }

    /** void 变体。 */
    public static void executeVoid(TransactionTemplate transactions, Runnable body) {
        execute(transactions, () -> {
            body.run();
            return null;
        });
    }

    private static void sleep(long millis) {
        try {
            Thread.sleep(millis);
        } catch (InterruptedException interrupted) {
            Thread.currentThread().interrupt();
        }
    }
}
