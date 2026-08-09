package com.iris.agent.pipeline;

import com.fasterxml.jackson.databind.JsonNode;

import java.util.List;

/** Immutable, code-defined pipeline contract. M0 intentionally stays serial. */
public record PipelineDefinition(
        String id,
        String version,
        String name,
        String capabilityPath,
        String description,
        JsonNode inputSchema,
        JsonNode outputSchema,
        int timeLimitMs,
        DeliveryPolicy deliveryPolicy,
        List<Step> steps
) {
    public PipelineDefinition {
        steps = List.copyOf(steps);
    }

    public enum DeliveryPolicy {
        /** Deliver one bounded terminal message to the logical parent Agent. */
        NOTIFY_PARENT,
        /** Persist result and emit lifecycle events without adding model context. */
        SILENT
    }

    public sealed interface Step permits ChildAgentStep, ModelTransformStep,
            PublishConversationTitleStep {
        String stepId();

        String kind();
    }

    /** A bounded Agentic segment that receives only an explicit task. */
    public record ChildAgentStep(
            String stepId,
            String taskInputPointer,
            String resultContract,
            List<String> allowedTools,
            int toolCallsLimit,
            int timeLimitMs
    ) implements Step {
        public ChildAgentStep {
            allowedTools = List.copyOf(allowedTools);
        }

        @Override
        public String kind() {
            return "child_agent";
        }
    }

    /** One model call with no tools and a definition-owned prompt skeleton. */
    public record ModelTransformStep(
            String stepId,
            String instruction,
            String sourceInputPointer,
            String resultContract,
            int timeLimitMs
    ) implements Step {
        @Override
        public String kind() {
            return "model_transform";
        }
    }

    /** Publishes a generated title only while the conversation has no user title. */
    public record PublishConversationTitleStep(
            String stepId,
            String titleSelector
    ) implements Step {
        @Override
        public String kind() {
            return "publish_conversation_title";
        }
    }
}
