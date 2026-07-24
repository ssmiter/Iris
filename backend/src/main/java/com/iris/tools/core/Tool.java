package com.iris.tools.core;

import com.fasterxml.jackson.databind.JsonNode;

/**
 * 版本化工具绑定。Tool 实例只能由 ToolRuntime 调用。
 */
public interface Tool {
    ToolManifest manifest();

    PreparedOperation prepare(JsonNode input, ToolContext context) throws Exception;

    ToolOutcome execute(
            CommittedOperation operation,
            ToolContext context
    ) throws Exception;

    VerificationResult verify(
            ToolOutcome outcome,
            CommittedOperation operation,
            ToolContext context
    ) throws Exception;
}
