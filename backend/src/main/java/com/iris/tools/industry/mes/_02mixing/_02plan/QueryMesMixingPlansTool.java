package com.iris.tools.industry.mes._02mixing._02plan;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.node.ObjectNode;
import com.iris.industry.demo.IndustrialDemoRepository;
import com.iris.tools.industry.IndustrialToolSchemas;
import com.iris.tools.industry.mes.AbstractMesReadTool;
import org.springframework.stereotype.Component;

import java.util.Set;

@Component
public class QueryMesMixingPlansTool extends AbstractMesReadTool {
    private static final Set<String> STATUSES = Set.of(
            "scheduled",
            "running",
            "completed",
            "paused"
    );

    public QueryMesMixingPlansTool(
            ObjectMapper objectMapper,
            IndustrialDemoRepository repository
    ) {
        super(
                objectMapper,
                repository,
                readManifest(
                        "iris.industry.mes.mixing_plans",
                        "query_mes_mixing_plans",
                        "查询 MES 域的密炼计划、班次、优先级与实际完成进度；判断计划执行情况时使用",
                        inputSchema(objectMapper),
                        IndustrialToolSchemas.output(objectMapper)
                )
        );
    }

    @Override
    protected String view() {
        return "mixing_plans";
    }

    @Override
    protected ObjectNode normalize(JsonNode input) {
        ObjectNode normalized = normalizedBase(input);
        copyDate(input, normalized, "start_date");
        copyDate(input, normalized, "end_date");
        requireDateOrder(normalized);
        copyText(input, normalized, "equipment_code", 40);
        copyText(input, normalized, "material_code", 40);
        copyEnum(input, normalized, "status", STATUSES);
        return normalized;
    }

    @Override
    protected ObjectNode query(ObjectNode normalized) {
        return repository.productionPlans(domain(), view(), normalized);
    }

    private static ObjectNode inputSchema(ObjectMapper mapper) {
        ObjectNode schema = IndustrialToolSchemas.input(mapper);
        IndustrialToolSchemas.string(
                schema,
                "start_date",
                "计划开始日期 YYYY-MM-DD；不传则不设下界"
        );
        IndustrialToolSchemas.string(
                schema,
                "end_date",
                "计划结束日期 YYYY-MM-DD；不传则不设上界"
        );
        IndustrialToolSchemas.string(
                schema,
                "equipment_code",
                "密炼设备编码，精确匹配"
        );
        IndustrialToolSchemas.string(
                schema,
                "material_code",
                "胶料编码，精确匹配"
        );
        IndustrialToolSchemas.string(
                schema,
                "status",
                "计划状态：scheduled、running、completed 或 paused"
        );
        return schema;
    }
}
