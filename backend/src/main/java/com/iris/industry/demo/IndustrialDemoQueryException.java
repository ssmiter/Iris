package com.iris.industry.demo;

/**
 * 可安全投影给 Agent 的模拟工业环境故障。
 */
public class IndustrialDemoQueryException extends RuntimeException {
    private final String code;

    public IndustrialDemoQueryException(
            String code,
            String message,
            Throwable cause
    ) {
        super(message, cause);
        this.code = code;
    }

    public String code() {
        return code;
    }
}
