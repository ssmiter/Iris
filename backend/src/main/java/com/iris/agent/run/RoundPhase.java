package com.iris.agent.run;

public enum RoundPhase {
    ACCEPTED,
    MODEL_STREAMING,
    MODEL_COMPLETED,
    AWAITING_TOOLS,
    OBSERVATIONS_READY,
    COMPLETED,
    STOPPED,
    FAILED;

    public boolean terminal() {
        return this == COMPLETED || this == STOPPED || this == FAILED;
    }
}
