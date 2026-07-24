package com.iris.tools.core;

public class ToolRuntimeException extends RuntimeException {
    private final String code;

    public ToolRuntimeException(String code, String message) {
        super(message);
        this.code = code;
    }

    public String code() {
        return code;
    }
}
