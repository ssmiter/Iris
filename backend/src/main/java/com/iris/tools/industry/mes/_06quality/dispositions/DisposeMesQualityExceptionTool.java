package com.iris.tools.industry.mes._06quality.dispositions;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.node.ObjectNode;
import com.iris.industry.demo.IndustrialDemoRepository;
import com.iris.tools.core.CommittedOperation;
import com.iris.tools.core.PreparedOperation;
import com.iris.tools.core.PreparedOperation.ResourceClaim;
import com.iris.tools.core.ToolContext;
import com.iris.tools.core.ToolOutcome;
import com.iris.tools.core.VerificationResult;
import com.iris.tools.industry.mes.AbstractMesWriteTool;
import org.springframework.stereotype.Component;

import java.time.Instant;
import java.util.List;
import java.util.Set;

/**
 * 质量异常处置闭环（docs/27 §5.3）：open→disposed，
 * 处置方式 rework/concession/scrap，version 乐观锁。
 */
@Component
public class DisposeMesQualityExceptionTool extends AbstractMesWriteTool {
    private static final Set<String> DISPOSITIONS = Set.of(
            "rework",
            "concession",
            "scrap"
    );

    public DisposeMesQualityExceptionTool(
            ObjectMapper objectMapper,
            IndustrialDemoRepository repository
    ) {
        super(
                objectMapper,
                repository,
                writeManifest(
                        "iris.industry.mes.dispose_quality_exception",
                        "dispose_mes_quality_exception",
                        "处置 MES 域的质量异常（rework=返工、concession=让步接收、scrap=报废）：仅 open→disposed，需带当前 version 乐观锁；异常闭环时使用",
                        inputSchema(objectMapper),
                        outputSchema(objectMapper)
                )
        );
    }

    @Override
    public PreparedOperation prepare(JsonNode input, ToolContext context) {
        String exceptionNo = requireText(input, "exception_no", 60);
        String disposition = requireEnum(
                input,
                "disposition",
                DISPOSITIONS
        );
        int expectedVersion = input.path("expected_version").asInt(-1);
        if (expectedVersion < 0) {
            throw invalid(
                    "expected_version 必须为非负整数，"
                            + "请先查询异常台账取当前 version"
            );
        }
        ObjectNode exception = repository.findQualityException(
                domain(),
                exceptionNo
        );
        if (exception == null) {
            throw invalid("质量异常不存在：" + exceptionNo);
        }
        String status = exception.path("status").asText();
        if (!"open".equals(status)) {
            throw invalid(
                    "异常当前状态为 " + status + "，只有 open 可处置"
            );
        }
        int currentVersion = exception.path("version").asInt();
        if (currentVersion != expectedVersion) {
            throw invalid(
                    "版本不匹配：当前版本 " + currentVersion
                            + "，请重新查询后再处置"
            );
        }
        ObjectNode normalized = objectMapper.createObjectNode();
        normalized.put("exception_no", exceptionNo);
        normalized.put("disposition", disposition);
        normalized.put("expected_version", expectedVersion);
        String impact = "将把质量异常 " + exceptionNo + "（"
                + exception.path("itemName").asText() + "，影响数量 "
                + exception.path("affectedQuantity").asText()
                + "）处置为 " + disposition
                + "；状态 open→disposed，版本 +1";
        return new PreparedOperation(
                normalized,
                impact,
                List.of(new ResourceClaim(
                        "industrial_demo_quality_exception",
                        exceptionNo,
                        String.valueOf(currentVersion)
                )),
                Instant.now().plusSeconds(300)
        );
    }

    @Override
    public ToolOutcome execute(
            CommittedOperation operation,
            ToolContext context
    ) {
        JsonNode normalized = operation.normalizedInput();
        String exceptionNo = normalized.path("exception_no").asText();
        String disposition = normalized.path("disposition").asText();
        int expectedVersion = normalized.path("expected_version").asInt();
        checkCancelled(context, "任务已停止，异常尚未处置");
        int updated = repository.disposeQualityException(
                domain(),
                exceptionNo,
                disposition,
                expectedVersion,
                now()
        );
        if (updated == 0) {
            throw conflict("异常已被并发处置或版本已变化，请重新查询");
        }
        ObjectNode output = objectMapper.createObjectNode();
        output.put("exceptionNo", exceptionNo);
        output.put("disposition", disposition);
        output.put("newStatus", "disposed");
        output.put("newVersion", expectedVersion + 1);
        return ToolOutcome.succeeded(output);
    }

    @Override
    public VerificationResult verify(
            ToolOutcome outcome,
            CommittedOperation operation,
            ToolContext context
    ) {
        String exceptionNo = outcome.output()
                .path("exceptionNo")
                .asText();
        ObjectNode exception = repository.findQualityException(
                domain(),
                exceptionNo
        );
        if (exception == null
                || !"disposed".equals(exception.path("status").asText())
                || !outcome.output()
                        .path("disposition")
                        .asText()
                        .equals(exception.path("disposition").asText())
                || exception.path("version").asInt()
                        != outcome.output().path("newVersion").asInt()) {
            return new VerificationResult(
                    VerificationResult.Status.UNKNOWN,
                    List.of(),
                    "处置已返回，但异常最新状态无法确认"
            );
        }
        return VerificationResult.confirmed(List.of(
                new VerificationResult.Evidence(
                        "industrial_demo_quality_exception",
                        exceptionNo,
                        "异常已处置为 "
                                + exception.path("disposition").asText()
                                + "，状态 disposed，版本 "
                                + exception.path("version").asInt()
                )
        ));
    }

    private static ObjectNode inputSchema(ObjectMapper mapper) {
        ObjectNode schema = mapper.createObjectNode();
        schema.put("type", "object");
        schema.put("additionalProperties", false);
        ObjectNode properties = schema.putObject("properties");
        properties.putObject("exception_no")
                .put("type", "string")
                .put(
                        "description",
                        "质量异常单号；先用 query_mes_quality_exceptions 查到 open 状态及当前 version"
                );
        ObjectNode disposition = properties.putObject("disposition");
        disposition.put("type", "string");
        disposition.put(
                "description",
                "处置方式：rework=返工，concession=让步接收，scrap=报废"
        );
        var choices = disposition.putArray("enum");
        DISPOSITIONS.stream().sorted().forEach(choices::add);
        properties.putObject("expected_version")
                .put("type", "integer")
                .put("minimum", 0)
                .put(
                        "description",
                        "查询时读到的 version，乐观锁；不匹配说明他人已处置"
                );
        schema.putArray("required")
                .add("exception_no")
                .add("disposition")
                .add("expected_version");
        return schema;
    }

    private static ObjectNode outputSchema(ObjectMapper mapper) {
        ObjectNode schema = mapper.createObjectNode();
        schema.put("type", "object");
        schema.put("additionalProperties", false);
        ObjectNode properties = schema.putObject("properties");
        properties.putObject("exceptionNo")
                .put("type", "string")
                .put("description", "被处置的异常单号");
        properties.putObject("disposition")
                .put("type", "string")
                .put("description", "实际生效的处置方式");
        properties.putObject("newStatus")
                .put("type", "string")
                .put("description", "处置后状态，固定 disposed");
        properties.putObject("newVersion")
                .put("type", "integer")
                .put("description", "处置后的版本号（原版本 +1）");
        schema.putArray("required")
                .add("exceptionNo")
                .add("disposition")
                .add("newStatus")
                .add("newVersion");
        return schema;
    }
}
