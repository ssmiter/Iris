package com.iris.agent.model.provider;

import com.fasterxml.jackson.databind.JsonNode;
import com.iris.agent.model.ModelInputItem;
import com.iris.agent.model.ModelRequest;
import com.iris.agent.model.ModelProtocolException;
import org.springframework.stereotype.Component;

import java.util.ArrayList;
import java.util.List;

/**
 * Groups flat canonical facts into provider-neutral message turns.
 */
@Component
public class ProviderMessageCompiler {
    public CompiledConversation compile(ModelRequest request) {
        List<ProviderMessage> messages = new ArrayList<>();
        messages.add(new ProviderMessage(
                Role.SYSTEM,
                List.of(new TextPart(request.systemInstruction()))
        ));
        for (ModelInputItem item : request.items()) {
            switch (item) {
                case ModelInputItem.HistorySummary summary ->
                        append(messages, Role.SYSTEM, new TextPart(
                                "Earlier conversation summary:\n"
                                        + summary.text()
                        ));
                case ModelInputItem.UserText user ->
                        append(messages, Role.USER, new TextPart(user.text()));
                case ModelInputItem.AssistantProviderState state -> {
                    if (replayable(request, state)) {
                        append(
                                messages,
                                Role.ASSISTANT,
                                new ProviderStatePart(
                                        state.stateKey(),
                                        state.content()
                                )
                        );
                    }
                }
                case ModelInputItem.AssistantText assistant ->
                        append(
                                messages,
                                Role.ASSISTANT,
                                new TextPart(assistant.text())
                        );
                case ModelInputItem.ContinuationDirective directive ->
                        append(
                                messages,
                                Role.USER,
                                new TextPart(directive.text())
                        );
                case ModelInputItem.AssistantToolCall call ->
                        append(messages, Role.ASSISTANT, new ToolCallPart(
                                call.toolCallId(),
                                providerId(call.providerCallId(), call.toolCallId()),
                                call.name(),
                                call.arguments()
                        ));
                case ModelInputItem.ToolResult result ->
                        append(messages, Role.TOOL, new ToolResultPart(
                                result.toolCallId(),
                                providerId(
                                        result.providerCallId(),
                                        result.toolCallId()
                                ),
                                result.outcomeKind(),
                                result.content()
                        ));
            }
        }
        validatePairing(messages);
        return new CompiledConversation(messages, request.tools());
    }

    private boolean replayable(
            ModelRequest request,
            ModelInputItem.AssistantProviderState state
    ) {
        return state.providerProfile().equals(
                        request.metadata().get("providerProfile")
                )
                && state.modelId().equals(request.modelId());
    }

    private void append(
            List<ProviderMessage> messages,
            Role role,
            MessagePart part
    ) {
        ProviderMessage latest = messages.isEmpty()
                ? null
                : messages.get(messages.size() - 1);
        if (latest != null && latest.role() == role
                && (role == Role.ASSISTANT || role == Role.SYSTEM)) {
            List<MessagePart> parts = new ArrayList<>(latest.parts());
            parts.add(part);
            messages.set(
                    messages.size() - 1,
                    new ProviderMessage(role, parts)
            );
            return;
        }
        messages.add(new ProviderMessage(role, List.of(part)));
    }

    private void validatePairing(List<ProviderMessage> messages) {
        java.util.Set<String> calls = new java.util.HashSet<>();
        java.util.Set<String> results = new java.util.HashSet<>();
        for (ProviderMessage message : messages) {
            for (MessagePart part : message.parts()) {
                if (part instanceof ToolCallPart call) {
                    if (!calls.add(call.toolCallId())) {
                        throw protocol("Duplicate ToolCall in provider input");
                    }
                } else if (part instanceof ToolResultPart result) {
                    if (!calls.contains(result.toolCallId())
                            || !results.add(result.toolCallId())) {
                        throw protocol(
                                "ToolResult is orphaned or duplicated in provider input"
                        );
                    }
                }
            }
        }
        if (!calls.equals(results)) {
            throw protocol(
                    "Provider input contains ToolCall without ToolResult"
            );
        }
    }

    private String providerId(String providerId, String internalId) {
        return providerId == null || providerId.isBlank()
                ? internalId
                : providerId;
    }

    private ModelProtocolException protocol(String message) {
        return new ModelProtocolException(
                "invalid_provider_message_pairing",
                message
        );
    }

    public enum Role {
        SYSTEM,
        USER,
        ASSISTANT,
        TOOL
    }

    public sealed interface MessagePart {
    }

    public record TextPart(String text) implements MessagePart {
    }

    public record ProviderStatePart(
            String stateKey,
            String content
    ) implements MessagePart {
    }

    public record ToolCallPart(
            String toolCallId,
            String providerCallId,
            String name,
            JsonNode arguments
    ) implements MessagePart {
    }

    public record ToolResultPart(
            String toolCallId,
            String providerCallId,
            String outcomeKind,
            JsonNode content
    ) implements MessagePart {
    }

    public record ProviderMessage(
            Role role,
            List<MessagePart> parts
    ) {
        public ProviderMessage {
            parts = List.copyOf(parts);
        }
    }

    public record CompiledConversation(
            List<ProviderMessage> messages,
            List<ModelRequest.ToolDefinition> tools
    ) {
        public CompiledConversation {
            messages = List.copyOf(messages);
            tools = List.copyOf(tools);
        }
    }
}
