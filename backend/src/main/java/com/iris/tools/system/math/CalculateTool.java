package com.iris.tools.system.math;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.node.ObjectNode;
import com.iris.calculation.DecimalExpressionEvaluator;
import com.iris.tools.core.CommittedOperation;
import com.iris.tools.core.PreparedOperation;
import com.iris.tools.core.RiskLevel;
import com.iris.tools.core.Tool;
import com.iris.tools.core.ToolContext;
import com.iris.tools.core.ToolManifest;
import com.iris.tools.core.ToolOutcome;
import com.iris.tools.core.ToolRuntimeException;
import com.iris.tools.core.VerificationResult;
import org.springframework.stereotype.Component;

import java.math.BigDecimal;
import java.time.Instant;
import java.util.List;

/**
 * 确定性的十进制算术原语。
 */
@Component
public class CalculateTool implements Tool {

    private static final int DEFAULT_PRECISION = 34;
    private static final int MAX_PRECISION = 100;

    private final ObjectMapper objectMapper;
    private final DecimalExpressionEvaluator evaluator;
    private final ToolManifest manifest;

    public CalculateTool(
            ObjectMapper objectMapper,
            DecimalExpressionEvaluator evaluator
    ) {
        this.objectMapper = objectMapper;
        this.evaluator = evaluator;
        this.manifest = new ToolManifest(
                "iris.system.math.calculate",
                "1",
                "calculate",
                "用确定性十进制算术计算表达式；金额、比例、工时或产量不能依赖语言模型心算时使用",
                inputSchema(),
                outputSchema(),
                RiskLevel.READ_ONLY,
                ToolManifest.SideEffect.NONE,
                10,
                20_000,
                ToolManifest.IdempotencySemantics.IDEMPOTENT,
                ToolManifest.EvidencePolicy.SUMMARY,
                ToolManifest.ContextRetention.REFETCHABLE,
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
        String expression = input.path("expression").asText().trim();
        int precision = input.path("precision").asInt(DEFAULT_PRECISION);
        if (precision < 1 || precision > MAX_PRECISION) {
            throw new ToolRuntimeException(
                    "calculation_precision_out_of_range",
                    "precision 必须在 1 到 100 之间"
            );
        }
        ObjectNode normalized = objectMapper.createObjectNode();
        normalized.put("expression", expression);
        normalized.put("precision", precision);
        return new PreparedOperation(
                normalized,
                "以 " + precision + " 位有效数字计算十进制表达式，不改变任何外部状态",
                List.of(),
                Instant.now().plusSeconds(60)
        );
    }

    @Override
    public ToolOutcome execute(
            CommittedOperation operation,
            ToolContext context
    ) {
        JsonNode input = operation.normalizedInput();
        int precision = input.path("precision").asInt();
        BigDecimal value = evaluator.evaluate(
                input.path("expression").asText(),
                precision,
                context::cancelled
        );
        ObjectNode output = objectMapper.createObjectNode();
        output.put("result", format(value));
        output.put("precision", precision);
        output.put("rounding", "HALF_EVEN");
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
                        "decimal_expression",
                        operation.normalizedInput()
                                .path("expression").asText(),
                        "已由受限十进制求值器完成"
                )
        ));
    }

    private String format(BigDecimal value) {
        if (value.signum() == 0) {
            return "0";
        }
        return value.stripTrailingZeros().toPlainString();
    }

    private JsonNode inputSchema() {
        ObjectNode schema = objectMapper.createObjectNode();
        schema.put("type", "object");
        schema.put("additionalProperties", false);
        ObjectNode properties = schema.putObject("properties");
        properties.putObject("expression")
                .put("type", "string")
                .put("description", "仅含十进制数字、+ - * / % ^、括号和空白的表达式");
        properties.putObject("precision")
                .put("type", "integer")
                .put("minimum", 1)
                .put("maximum", MAX_PRECISION)
                .put("description", "有效数字位数；默认 34，舍入为 HALF_EVEN");
        schema.putArray("required").add("expression");
        return schema;
    }

    private JsonNode outputSchema() {
        ObjectNode schema = objectMapper.createObjectNode();
        schema.put("type", "object");
        schema.put("additionalProperties", false);
        ObjectNode properties = schema.putObject("properties");
        properties.putObject("result")
                .put("type", "string")
                .put("description", "不使用科学计数法的十进制结果");
        properties.putObject("precision")
                .put("type", "integer")
                .put("description", "本次计算的有效数字位数");
        properties.putObject("rounding")
                .put("type", "string")
                .put("description", "舍入规则，固定为 HALF_EVEN");
        schema.putArray("required")
                .add("result").add("precision").add("rounding");
        return schema;
    }
}
