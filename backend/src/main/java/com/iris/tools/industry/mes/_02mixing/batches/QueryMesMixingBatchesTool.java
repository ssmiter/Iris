package com.iris.tools.industry.mes._02mixing.batches;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.node.ObjectNode;
import com.iris.industry.demo.IndustrialDemoRepository;
import com.iris.tools.industry.IndustrialToolSchemas;
import com.iris.tools.industry.mes.AbstractMesReadTool;
import org.springframework.stereotype.Component;

import java.util.Set;

@Component
public class QueryMesMixingBatchesTool extends AbstractMesReadTool {
    private static final Set<String> QUALITY_STATES = Set.of(
            "pending",
            "pass",
            "fail"
    );

    public QueryMesMixingBatchesTool(
            ObjectMapper objectMapper,
            IndustrialDemoRepository repository
    ) {
        super(
                objectMapper,
                repository,
                readManifest(
                        "iris.industry.mes.mixing_batches",
                        "query_mes_mixing_batches",
                        "查询 MES 域的密炼批次谱系主档：来源计划、机台、产出量、质量状态与下游去向；追溯批次或核对产出时使用",
                        inputSchema(objectMapper),
                        IndustrialToolSchemas.output(objectMapper)
                )
        );
    }

    @Override
    protected String view() {
        return "mixing_batches";
    }

    @Override
    protected ObjectNode normalize(JsonNode input) {
        ObjectNode normalized = normalizedBase(input);
        copyText(input, normalized, "batch", 60);
        copyText(input, normalized, "item", 80);
        copyText(input, normalized, "plan_no", 60);
        copyText(input, normalized, "equipment_code", 40);
        copyEnum(input, normalized, "quality_state", QUALITY_STATES);
        return normalized;
    }

    @Override
    protected ObjectNode query(ObjectNode normalized) {
        return repository.batches(domain(), normalized);
    }

    private static ObjectNode inputSchema(ObjectMapper mapper) {
        ObjectNode schema = IndustrialToolSchemas.input(mapper);
        IndustrialToolSchemas.string(
                schema,
                "batch",
                "批次号片段"
        );
        IndustrialToolSchemas.string(
                schema,
                "item",
                "胶料编码或名称片段"
        );
        IndustrialToolSchemas.string(
                schema,
                "plan_no",
                "来源计划号，精确匹配"
        );
        IndustrialToolSchemas.string(
                schema,
                "equipment_code",
                "密炼设备编码，精确匹配"
        );
        IndustrialToolSchemas.stringEnum(
                schema,
                "quality_state",
                "批次质量状态；不传则返回全部",
                QUALITY_STATES.stream().sorted().toList()
        );
        return schema;
    }
}
