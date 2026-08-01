package com.iris.tools.industry.mes._10plan.delays;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.node.ObjectNode;
import com.iris.industry.demo.IndustrialDemoRepository;
import com.iris.tools.industry.IndustrialToolSchemas;
import com.iris.tools.industry.mes.AbstractMesReadTool;
import org.springframework.stereotype.Component;

import java.util.Set;

@Component
public class QueryMesPlanDelaysTool extends AbstractMesReadTool {
    private static final Set<String> PROCESSES = Set.of(
            "mixing",
            "forming",
            "curing"
    );

    public QueryMesPlanDelaysTool(
            ObjectMapper objectMapper,
            IndustrialDemoRepository repository
    ) {
        super(
                objectMapper,
                repository,
                readManifest(
                        "iris.industry.mes.plan_delays",
                        "query_mes_plan_delays",
                        "查询 MES 域截至基准日仍未完成的延误计划（延误天数、机台、物料、剩余量），附延误合计；排查交期风险与延误归因时使用",
                        inputSchema(objectMapper),
                        IndustrialToolSchemas.output(objectMapper)
                )
        );
    }

    @Override
    protected String view() {
        return "plan_delays";
    }

    @Override
    protected ObjectNode normalize(JsonNode input) {
        ObjectNode normalized = normalizedBase(input);
        copyDate(input, normalized, "as_of_date");
        if (normalized.path("as_of_date").asText().isBlank()) {
            throw invalid("as_of_date 必填，格式 YYYY-MM-DD");
        }
        copyEnum(input, normalized, "process_code", PROCESSES);
        copyText(input, normalized, "equipment_code", 40);
        return normalized;
    }

    @Override
    protected ObjectNode query(ObjectNode normalized) {
        return repository.planDelays(domain(), normalized);
    }

    private static ObjectNode inputSchema(ObjectMapper mapper) {
        ObjectNode schema = IndustrialToolSchemas.input(mapper);
        IndustrialToolSchemas.string(
                schema,
                "as_of_date",
                "基准日期 YYYY-MM-DD，必填；计划日期早于该日且未完成的计划计为延误"
        );
        IndustrialToolSchemas.stringEnum(
                schema,
                "process_code",
                "工序；不传则覆盖全部工序",
                PROCESSES.stream().sorted().toList()
        );
        IndustrialToolSchemas.string(
                schema,
                "equipment_code",
                "机台编码，精确匹配"
        );
        return schema;
    }
}
