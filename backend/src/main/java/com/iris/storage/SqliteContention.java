package com.iris.storage;

import java.sql.SQLException;
import java.util.Locale;

/** Identifies SQLite's one expected transient writer-contention signal. */
public final class SqliteContention {
    private static final int SQLITE_BUSY = 5;

    private SqliteContention() {
    }

    public static boolean isBusy(Throwable error) {
        Throwable current = error;
        for (int depth = 0; current != null && depth < 12; depth++) {
            if (current instanceof SQLException sql
                    && sql.getErrorCode() == SQLITE_BUSY) {
                return true;
            }
            String message = current.getMessage();
            if (message != null) {
                String normalized = message.toUpperCase(Locale.ROOT);
                if (normalized.contains("SQLITE_BUSY")
                        || normalized.contains("DATABASE IS LOCKED")) {
                    return true;
                }
            }
            current = current.getCause();
        }
        return false;
    }
}
