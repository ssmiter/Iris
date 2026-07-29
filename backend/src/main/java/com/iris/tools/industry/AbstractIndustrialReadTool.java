package com.iris.tools.industry;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.node.ObjectNode;
import com.iris.industry.demo.IndustrialDemoRepository;
import com.iris.tools.core.CommittedOperation;
import com.iris.tools.core.PreparedOperation;
import com.iris.tools.core.PreparedOperation.ResourceClaim;
import com.iris.tools.core.RiskLevel;
import com.iris.tools.core.Tool;
import com.iris.tools.core.ToolContext;
import com.iris.tools.core.ToolManifest;
import com.iris.tools.core.ToolOutcome;
import com.iris.tools.core.ToolRuntimeException;
import com.iris.tools.core.VerificationResult;

import java.time.Instant;
import java.time.LocalDate;
import java.time.format.DateTimeParseException;
import java.util.List;
import java.util.Set;

/**
 * 工业样例只读能力的统一运行时骨架。
 */
public abstract class AbstractIndustrialReadTool implements Tool {
    protected static final int DEFAULT_LIMIT = 50;
    protected static final int MAX_LIMIT = 200;

    protected final ObjectMapper objectMapper;
    protected final IndustrialDemoRepository repository;
    private final ToolManifest manifest;

    protected AbstractIndustrialReadTool(
            ObjectMapper objectMapper,
            IndustrialDemoRepository repository,
            ToolManifest manifest
    ) {
        this.objectMapper = objectMapper;
        this.repository = repository;
        this.manifest = manifest;
    }

    @Override
    public final ToolManifest manifest() {
        return manifest;
    }

    @Override
    public final PreparedOperation prepare(
            JsonNode input,
            ToolContext context
    ) {
        ObjectNode normalized = normalize(input);
        return new PreparedOperation(
                normalized,
                impact(normalized),
                List.of(new ResourceClaim(
                        "industrial_demo_view",
                        domain() + "/" + view(),
                        null
                )),
                Instant.now().plusSeconds(90)
        );
    }

    @Override
    public final ToolOutcome execute(
            CommittedOperation operation,
            ToolContext context
    ) {
        if (context.cancelled()) {
            throw new ToolRuntimeException(
                    "industrial_query_cancelled",
                    "查询在读取模拟数据前已停止"
            );
        }
        return ToolOutcome.succeeded(
                query((ObjectNode) operation.normalizedInput())
        );
    }

    @Override
    public final VerificationResult verify(
            ToolOutcome outcome,
            CommittedOperation operation,
            ToolContext context
    ) {
        JsonNode output = outcome.output();
        return VerificationResult.confirmed(List.of(
                new VerificationResult.Evidence(
                        "industrial_demo_query",
                        domain() + "/" + view(),
                        "固定只读视图返回 " + output.path("rowCount").asInt()
                                + " 条脱敏模拟记录"
                )
        ));
    }

    protected abstract String domain();

    protected abstract String view();

    protected abstract ObjectNode normalize(JsonNode input);

    protected abstract ObjectNode query(ObjectNode normalized);

    protected String impact(ObjectNode normalized) {
        return "读取 " + domain() + " 样例域的 " + view()
                + " 模拟数据，最多返回 "
                + normalized.path("limit").asInt()
                + " 条，不改变任何业务状态";
    }

    protected ObjectNode normalizedBase(JsonNode input) {
        ObjectNode normalized = objectMapper.createObjectNode();
        int limit = input.path("limit").asInt(DEFAULT_LIMIT);
        if (limit < 1 || limit > MAX_LIMIT) {
            throw invalid(
                    "limit 必须在 1 到 " + MAX_LIMIT + " 之间"
            );
        }
        normalized.put("limit", limit);
        return normalized;
    }

    protected void copyText(
            JsonNode input,
            ObjectNode normalized,
            String field,
            int maxCharacters
    ) {
        String value = input.path(field).asText().trim();
        if (value.length() > maxCharacters) {
            throw invalid(field + " 过长");
        }
        normalized.put(field, value);
    }

    protected void copyEnum(
            JsonNode input,
            ObjectNode normalized,
            String field,
            Set<String> allowed
    ) {
        String value = input.path(field).asText().trim().toLowerCase();
        if (!value.isBlank() && !allowed.contains(value)) {
            throw invalid(
                    field + " 只允许 " + String.join(", ", allowed)
            );
        }
        normalized.put(field, value);
    }

    protected void copyDate(
            JsonNode input,
            ObjectNode normalized,
            String field
    ) {
        String value = input.path(field).asText().trim();
        if (!value.isBlank()) {
            try {
                LocalDate.parse(value);
            } catch (DateTimeParseException exception) {
                throw invalid(field + " 必须为 YYYY-MM-DD");
            }
        }
        normalized.put(field, value);
    }

    protected void requireDateOrder(ObjectNode normalized) {
        String start = normalized.path("start_date").asText();
        String end = normalized.path("end_date").asText();
        if (!start.isBlank() && !end.isBlank()
                && LocalDate.parse(start).isAfter(LocalDate.parse(end))) {
            throw invalid("start_date 不能晚于 end_date");
        }
    }

    protected ToolRuntimeException invalid(String message) {
        return new ToolRuntimeException(
                "invalid_industrial_query",
                message
        );
    }

    protected static ToolManifest readManifest(
            String id,
            String name,
            String description,
            JsonNode inputSchema,
            JsonNode outputSchema
    ) {
        return new ToolManifest(
                id,
                "1",
                name,
                description,
                inputSchema,
                outputSchema,
                RiskLevel.READ_ONLY,
                ToolManifest.SideEffect.NONE,
                30,
                40_000,
                ToolManifest.IdempotencySemantics.IDEMPOTENT,
                ToolManifest.EvidencePolicy.SUMMARY,
                ToolManifest.ContextRetention.REFETCHABLE,
                ToolManifest.ConcurrencySemantics.PARALLEL_SAFE,
                ToolManifest.CancellationSemantics.COOPERATIVE
        );
    }
}
