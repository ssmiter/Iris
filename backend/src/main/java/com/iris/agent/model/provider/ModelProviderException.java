package com.iris.agent.model.provider;

public class ModelProviderException extends RuntimeException {
    private final String category;
    private final boolean retryable;
    private final Integer httpStatus;
    private final String providerCode;
    private final String providerType;
    private final String diagnosticMessage;

    public ModelProviderException(
            String category,
            boolean retryable,
            String message
    ) {
        this(
                category,
                retryable,
                message,
                null,
                null,
                null,
                null
        );
    }

    public ModelProviderException(
            String category,
            boolean retryable,
            String message,
            Integer httpStatus,
            String providerCode,
            String providerType,
            String diagnosticMessage
    ) {
        super(message);
        this.category = category;
        this.retryable = retryable;
        this.httpStatus = httpStatus;
        this.providerCode = providerCode;
        this.providerType = providerType;
        this.diagnosticMessage = diagnosticMessage;
    }

    public String category() {
        return category;
    }

    public boolean retryable() {
        return retryable;
    }

    public Integer httpStatus() {
        return httpStatus;
    }

    public String providerCode() {
        return providerCode;
    }

    public String providerType() {
        return providerType;
    }

    public String diagnosticMessage() {
        return diagnosticMessage;
    }
}
