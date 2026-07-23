package com.weave.tools.core;

/**
 * 工具执行结果。result 为任意 JSON；超大结果由执行器统一截断（docs/03 §8）。
 */
public record ToolResult(
        boolean ok,
        Object result,
        String error
) {
    public static ToolResult ok(Object result) {
        return new ToolResult(true, result, null);
    }

    public static ToolResult error(String message) {
        return new ToolResult(false, null, message);
    }
}
