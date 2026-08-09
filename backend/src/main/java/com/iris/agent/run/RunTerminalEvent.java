package com.iris.agent.run;

/** Process-local wakeup emitted only after the durable Run terminal fact exists. */
public record RunTerminalEvent(String runId, RunPhase phase) { }
