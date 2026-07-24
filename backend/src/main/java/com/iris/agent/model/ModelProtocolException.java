package com.iris.agent.model;

public class ModelProtocolException extends RuntimeException {
    private final String code;

    public ModelProtocolException(String code, String message) {
        super(message);
        this.code = code;
    }

    public String code() {
        return code;
    }
}
