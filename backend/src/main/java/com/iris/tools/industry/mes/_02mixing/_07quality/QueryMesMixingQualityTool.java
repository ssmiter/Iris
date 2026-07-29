package com.iris.tools.industry.mes._02mixing._07quality;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.node.ObjectNode;
import com.iris.industry.demo.IndustrialDemoRepository;
import com.iris.tools.industry.IndustrialToolSchemas;
import com.iris.tools.industry.mes.AbstractMesReadTool;
import org.springframework.stereotype.Component;

import java.util.Set;

@Component
public class QueryMesMixingQualityTool extends AbstractMesReadTool {
    private static final Set<String> RESULTS = Set.of("pass", "fail");

    public QueryMesMixingQualityTool(
            ObjectMapper objectMapper,
            IndustrialDemoRepository repository
    ) {
        super(
                objectMapper,
                repository,
                readManifest(
                        "iris.industry.mes.mixing_quality",
                        "query_mes_mixing_quality",
                        "查询脱敏模拟 MES 的胶料检验测量、上下限、判定和通过率；分析批次质量异常时使用",
                        inputSchema(objectMapper),
                        IndustrialToolSchemas.output(objectMapper)
                )
        );
    }

    @Override
    protected String view() {
        return "mixing_quality";
    }

    @Override
    protected ObjectNode normalize(JsonNode input) {
        ObjectNode normalized = normalizedBase(input);
        copyDate(input, normalized, "start_date");
        copyDate(input, normalized, "end_date");
        requireDateOrder(normalized);
        copyText(input, normalized, "material_code", 40);
        copyText(input, normalized, "equipment_code", 40);
        copyEnum(input, normalized, "judge_result", RESULTS);
        return normalized;
    }

    @Override
    protected ObjectNode query(ObjectNode normalized) {
        return repository.qualityMeasurements(domain(), normalized);
    }

    private static ObjectNode inputSchema(ObjectMapper mapper) {
        ObjectNode schema = IndustrialToolSchemas.input(mapper);
        IndustrialToolSchemas.string(
                schema,
                "start_date",
                "采样开始日期 YYYY-MM-DD；不传则不设下界"
        );
        IndustrialToolSchemas.string(
                schema,
                "end_date",
                "采样结束日期 YYYY-MM-DD；不传则不设上界"
        );
        IndustrialToolSchemas.string(
                schema,
                "material_code",
                "胶料编码，精确匹配"
        );
        IndustrialToolSchemas.string(
                schema,
                "equipment_code",
                "生产设备编码，精确匹配"
        );
        IndustrialToolSchemas.string(
                schema,
                "judge_result",
                "测量判定：pass 或 fail"
        );
        return schema;
    }
}
