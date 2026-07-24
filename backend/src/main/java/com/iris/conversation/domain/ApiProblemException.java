package com.iris.conversation.domain;

import org.springframework.http.HttpStatus;

import java.util.Map;

public final class ApiProblemException extends RuntimeException {
    private final HttpStatus status;
    private final String code;
    private final String category;
    private final Map<String, Object> context;

    public ApiProblemException(
            HttpStatus status,
            String code,
            String category,
            String message
    ) {
        this(status, code, category, message, Map.of());
    }

    public ApiProblemException(
            HttpStatus status,
            String code,
            String category,
            String message,
            Map<String, Object> context
    ) {
        super(message);
        this.status = status;
        this.code = code;
        this.category = category;
        this.context = Map.copyOf(context);
    }

    public HttpStatus status() {
        return status;
    }

    public String code() {
        return code;
    }

    public String category() {
        return category;
    }

    public Map<String, Object> context() {
        return context;
    }
}
