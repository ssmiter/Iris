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

    /** 用户停止对话时置 true；长任务工具应周期检查并尽快返回 */
    boolean cancelled();
}
