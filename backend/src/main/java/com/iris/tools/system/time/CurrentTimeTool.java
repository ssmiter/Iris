package com.iris.tools.system.time;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.node.ObjectNode;
import com.iris.tools.core.CommittedOperation;
import com.iris.tools.core.PreparedOperation;
import com.iris.tools.core.RiskLevel;
import com.iris.tools.core.Tool;
import com.iris.tools.core.ToolContext;
import com.iris.tools.core.ToolManifest;
import com.iris.tools.core.ToolOutcome;
import com.iris.tools.core.VerificationResult;
import org.springframework.stereotype.Component;

import java.time.Instant;
import java.time.ZoneId;
import java.time.ZonedDateTime;
import java.util.List;

@Component
public class CurrentTimeTool implements Tool {
    private final ObjectMapper objectMapper;
    private final ToolManifest manifest;

    public CurrentTimeTool(ObjectMapper objectMapper) {
        this.objectMapper = objectMapper;
        this.manifest = new ToolManifest(
                "iris.system.time.current_time",
                "3",
                "current_time",
                "读取指定时区的当前时间；需要可靠时间事实而非模型猜测时使用",
                inputSchema(),
                outputSchema(),
                RiskLevel.READ_ONLY,
                ToolManifest.SideEffect.NONE,
                5,
                2_000,
                ToolManifest.IdempotencySemantics.NON_IDEMPOTENT,
                ToolManifest.EvidencePolicy.SUMMARY,
                ToolManifest.ContextRetention.PINNED,
                ToolManifest.ConcurrencySemantics.PARALLEL_SAFE,
                ToolManifest.CancellationSemantics.COOPERATIVE
        );
    }

    @Override
    public ToolManifest manifest() {
        return manifest;
    }

    @Override
    public PreparedOperation prepare(JsonNode input, ToolContext context) {
        String zone = input.path("zone").asText("UTC");
        ZoneId.of(zone);
        ObjectNode normalized = objectMapper.createObjectNode();
        normalized.put("zone", zone);
        return new PreparedOperation(
                normalized,
                "读取 " + zone + " 的当前时间，不改变任何外部状态",
                List.of(),
                Instant.now().plusSeconds(30)
        );
    }

    @Override
    public ToolOutcome execute(
            CommittedOperation operation,
            ToolContext context
    ) {
        String zone = operation.normalizedInput().path("zone").asText();
        ZonedDateTime current = ZonedDateTime.now(ZoneId.of(zone));
        ObjectNode output = objectMapper.createObjectNode();
        output.put("zone", zone);
        output.put("time", current.toString());
        output.put("epochMillis", current.toInstant().toEpochMilli());
        return ToolOutcome.succeeded(output);
    }

    @Override
    public VerificationResult verify(
            ToolOutcome outcome,
            CommittedOperation operation,
            ToolContext context
    ) {
        return VerificationResult.confirmed(List.of(
                new VerificationResult.Evidence(
                        "system_clock",
                        null,
                        "时间来自本机 Java 时钟"
                )
        ));
    }

    private JsonNode inputSchema() {
        ObjectNode schema = objectMapper.createObjectNode();
        schema.put("type", "object");
        schema.put("additionalProperties", false);
        ObjectNode properties = schema.putObject("properties");
        properties.putObject("zone")
                .put("type", "string")
                .put("description", "IANA 时区 ID，如 Asia/Hong_Kong；默认 UTC");
        return schema;
    }

    private JsonNode outputSchema() {
        ObjectNode schema = objectMapper.createObjectNode();
        schema.put("type", "object");
        schema.put("additionalProperties", false);
        ObjectNode properties = schema.putObject("properties");
        properties.putObject("zone")
                .put("type", "string")
                .put("description", "实际使用的 IANA 时区");
        properties.putObject("time")
                .put("type", "string")
                .put("description", "带时区的 ISO-8601 时间");
        properties.putObject("epochMillis")
                .put("type", "integer")
                .put("description", "Unix epoch 毫秒");
        schema.putArray("required").add("zone").add("time").add("epochMillis");
        return schema;
    }
}
