package com.iris.agent.run;

import com.fasterxml.jackson.databind.node.ObjectNode;
import com.iris.tools.core.ToolExecutionViews.RuntimeResult;

/**
 * Adds domain presentation metadata without moving execution into Frontend.
 */
public interface ToolProjectionEnricher {

    boolean supports(String toolName);

    void enrich(
            ObjectNode projection,
            String conversationId,
            RuntimeResult result
    );
}
