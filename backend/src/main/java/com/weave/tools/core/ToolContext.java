package com.weave.tools.core;

import java.nio.file.Path;

/**
 * 工具执行上下文：会话信息 + 取消信号 + 工作区根。
 */
public interface ToolContext {

    /** 当前会话 id（审计/产物归属用） */
    String sessionId();

    /** 工作区根目录（文件工具的路径围栏基准，docs/04 §1） */
    Path workspaceRoot();

    /** 用户停止对话时置 true；长任务工具应周期检查并尽快返回 */
    boolean cancelled();
}
