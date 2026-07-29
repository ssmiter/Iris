package com.iris.webbridge;

import com.fasterxml.jackson.databind.node.ObjectNode;
import com.iris.agent.run.ToolProjectionEnricher;
import com.iris.tools.core.ToolExecutionViews.RuntimeResult;
import org.springframework.stereotype.Component;

@Component
public class BrowserScreenshotProjectionEnricher
        implements ToolProjectionEnricher {

    private final BrowserScreenshotService screenshots;

    public BrowserScreenshotProjectionEnricher(
            BrowserScreenshotService screenshots
    ) {
        this.screenshots = screenshots;
    }

    @Override
    public boolean supports(String toolName) {
        return BrowserScreenshotService.TOOL_NAME.equals(toolName);
    }

    @Override
    public void enrich(
            ObjectNode projection,
            String conversationId,
            RuntimeResult result
    ) {
        screenshots.findMetadata(conversationId, result.executionId())
                .ifPresent(metadata -> {
                    projection.put("rendererKey", "browser.screenshot");
                    ObjectNode preview = projection.putObject("preview");
                    preview.put("kind", "browser_screenshot");
                    preview.put(
                            "url",
                            "/api/v1/conversations/" + conversationId
                                    + "/tool-executions/"
                                    + result.executionId()
                                    + "/browser-screenshot"
                    );
                    preview.put("mediaType", metadata.mediaType());
                    preview.put("contentHash", metadata.contentHash());
                    preview.put("byteCount", metadata.byteCount());
                    preview.put("pageId", metadata.pageId());
                    preview.put(
                            "observationRef",
                            metadata.observationRef()
                    );
                });
    }
}
