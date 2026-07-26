package com.iris.agent.run;

final class RunCancellationException extends RuntimeException {
    RunCancellationException() {
        super("Run cancellation was requested");
    }
}
