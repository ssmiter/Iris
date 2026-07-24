package com.iris.conversation.domain;

import com.fasterxml.jackson.databind.JsonNode;

import java.time.Instant;

public record ConversationEvent(
        int schemaVersion,
        String eventId,
        String eventType,
        String conversationId,
        String branchId,
        String turnId,
        String runId,
        String parentRunId,
        long sequence,
        AggregateRef aggregate,
        String causationId,
        String correlationId,
        Instant occurredAt,
        JsonNode payload
) {
    public record AggregateRef(String kind, String id, long version) {
    }

    public EventEnvelope envelope() {
        return new EventEnvelope(
                schemaVersion,
                eventId,
                conversationId,
                branchId,
                turnId,
                runId,
                parentRunId,
                sequence,
                aggregate,
                causationId,
                correlationId,
                occurredAt,
                payload
        );
    }

    public record EventEnvelope(
            int schemaVersion,
            String eventId,
            String conversationId,
            String branchId,
            String turnId,
            String runId,
            String parentRunId,
            long sequence,
            AggregateRef aggregate,
            String causationId,
            String correlationId,
            Instant occurredAt,
            JsonNode payload
    ) {
    }
}
