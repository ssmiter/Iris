package com.iris.tools.core;

import java.nio.file.Path;

/**
 * 工具执行上下文。它只携带已确认的运行身份和工作区围栏，
 * 不携带审批布尔值，也不能用于绕过 ToolRuntime。
 */
public interface ToolContext {

    String conversationId();

    String turnId();

    String runId();

    String roundId();

    /** 工作区根目录（文件工具的路径围栏基准，docs/04 §1） */
    Path workspaceRoot();

    /**
     * 实时取消信号，不是调用开始时的快照。
     * cooperative 工具应在遍历、分页和等待边界周期检查。
     */
    boolean cancelled();

    /** cancelled() 是否由精确 Tool Definition 的运行截止时间触发。 */
    default boolean deadlineExceeded() {
        return false;
    }

    /**
     * Whether this Run may cross an external or workspace mutation boundary.
     * Root Runs and trusted host orchestration allow it by default; isolated
     * observe Agents explicitly narrow it in their durable Run context.
     */
    default boolean externalWritesAllowed() {
        return true;
    }
}
