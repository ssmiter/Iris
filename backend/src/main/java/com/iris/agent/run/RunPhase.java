package com.iris.agent.run;

public enum RunPhase {
    ACCEPTED,
    RUNNING,
    SUSPENDED,
    VERIFYING,
    OUTCOME_UNKNOWN,
    SUCCEEDED,
    FAILED,
    CANCELLED;

    public boolean terminal() {
        return this == OUTCOME_UNKNOWN
                || this == SUCCEEDED
                || this == FAILED
                || this == CANCELLED;
    }
}
