package com.iris.agent.run;

import java.util.Map;
import java.util.Set;

public final class RunStateMachine {
    private static final Map<RunPhase, Set<RunPhase>> RUN_TRANSITIONS = Map.of(
            RunPhase.ACCEPTED, Set.of(
                    RunPhase.RUNNING,
                    RunPhase.CANCELLED,
                    RunPhase.FAILED
            ),
            RunPhase.RUNNING, Set.of(
                    RunPhase.SUSPENDED,
                    RunPhase.VERIFYING,
                    RunPhase.CANCELLED,
                    RunPhase.FAILED,
                    RunPhase.OUTCOME_UNKNOWN
            ),
            RunPhase.SUSPENDED, Set.of(
                    RunPhase.RUNNING,
                    RunPhase.CANCELLED,
                    RunPhase.FAILED,
                    RunPhase.OUTCOME_UNKNOWN
            ),
            RunPhase.VERIFYING, Set.of(
                    RunPhase.SUCCEEDED,
                    RunPhase.FAILED,
                    RunPhase.OUTCOME_UNKNOWN
            )
    );

    private static final Map<RoundPhase, Set<RoundPhase>> ROUND_TRANSITIONS =
            Map.of(
                    RoundPhase.ACCEPTED, Set.of(
                            RoundPhase.MODEL_STREAMING,
                            RoundPhase.FAILED
                    ),
                    RoundPhase.MODEL_STREAMING, Set.of(
                            RoundPhase.MODEL_COMPLETED,
                            RoundPhase.FAILED
                    ),
                    RoundPhase.MODEL_COMPLETED, Set.of(
                            RoundPhase.AWAITING_TOOLS,
                            RoundPhase.COMPLETED,
                            RoundPhase.FAILED
                    ),
                    RoundPhase.AWAITING_TOOLS, Set.of(
                            RoundPhase.OBSERVATIONS_READY,
                            RoundPhase.FAILED
                    ),
                    RoundPhase.OBSERVATIONS_READY, Set.of(
                            RoundPhase.COMPLETED,
                            RoundPhase.FAILED
                    )
            );

    private RunStateMachine() {
    }

    public static void requireTransition(RunPhase from, RunPhase to) {
        if (from == null || to == null || from.terminal()
                || !RUN_TRANSITIONS.getOrDefault(from, Set.of()).contains(to)) {
            throw new IllegalStateException(
                    "非法 Run 状态跳转: " + from + " -> " + to
            );
        }
    }

    public static void requireTransition(RoundPhase from, RoundPhase to) {
        if (from == null || to == null || from.terminal()
                || !ROUND_TRANSITIONS.getOrDefault(from, Set.of()).contains(to)) {
            throw new IllegalStateException(
                    "非法 Round 状态跳转: " + from + " -> " + to
            );
        }
    }
}
