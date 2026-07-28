package com.iris.tools.core;

public class ToolRuntimeException extends RuntimeException {
    private final String code;
    private final boolean noOperationEffect;

    public ToolRuntimeException(String code, String message) {
        this(code, message, false);
    }

    private ToolRuntimeException(
            String code,
            String message,
            boolean noOperationEffect
    ) {
        super(message);
        this.code = code;
        this.noOperationEffect = noOperationEffect;
    }

    public static ToolRuntimeException beforeCommit(
            String code,
            String message
    ) {
        return new ToolRuntimeException(code, message, true);
    }

    public String code() {
        return code;
    }

    public boolean noOperationEffect() {
        return noOperationEffect;
    }
}
