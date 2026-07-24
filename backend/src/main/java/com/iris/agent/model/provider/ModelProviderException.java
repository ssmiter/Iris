package com.iris.agent.model.provider;

public class ModelProviderException extends RuntimeException {
    private final String category;
    private final boolean retryable;

    public ModelProviderException(
            String category,
            boolean retryable,
            String message
    ) {
        super(message);
        this.category = category;
        this.retryable = retryable;
    }

    public String category() {
        return category;
    }

    public boolean retryable() {
        return retryable;
    }
}
