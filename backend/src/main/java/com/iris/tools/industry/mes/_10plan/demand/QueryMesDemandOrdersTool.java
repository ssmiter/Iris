package com.iris.tools.industry.mes._10plan.demand;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.node.ObjectNode;
import com.iris.industry.demo.IndustrialDemoRepository;
import com.iris.tools.industry.IndustrialToolSchemas;
import com.iris.tools.industry.mes.AbstractMesReadTool;
import org.springframework.stereotype.Component;

import java.util.Set;

@Component
public class QueryMesDemandOrdersTool extends AbstractMesReadTool {
    private static final Set<String> STATES = Set.of(
            "unscheduled",
            "scheduled",
            "released",
            "completed"
    );
    private static final Set<String> PRIORITIES = Set.of(
            "high",
            "normal"
    );

    public QueryMesDemandOrdersTool(
            ObjectMapper objectMapper,
            IndustrialDemoRepository repository
    ) {
        super(
                objectMapper,
                repository,
                readManifest(
                        "iris.industry.mes.demand_orders",
                        "query_mes_demand_orders",
                        "查询 MES 域的需求订单（数量、交期、优先级、排产状态）；了解链头需求、排查未排产订单或评估交期压力时使用，排产结果见 query_mes_aps_master_plan",
                        inputSchema(objectMapper),
                        IndustrialToolSchemas.output(objectMapper)
                )
        );
    }

    @Override
    protected String view() {
        return "demand_orders";
    }

    @Override
    protected ObjectNode normalize(JsonNode input) {
        ObjectNode normalized = normalizedBase(input);
        copyDate(input, normalized, "start_date");
        copyDate(input, normalized, "end_date");
        requireDateOrder(normalized);
        copyText(input, normalized, "item", 80);
        copyEnum(input, normalized, "state", STATES);
        copyEnum(input, normalized, "priority", PRIORITIES);
        return normalized;
    }

    @Override
    protected ObjectNode query(ObjectNode normalized) {
        return repository.demandOrders(domain(), normalized);
    }

    private static ObjectNode inputSchema(ObjectMapper mapper) {
        ObjectNode schema = IndustrialToolSchemas.input(mapper);
        IndustrialToolSchemas.string(
                schema,
                "start_date",
                "交期下界 YYYY-MM-DD；不传则不设下界"
        );
        IndustrialToolSchemas.string(
                schema,
                "end_date",
                "交期上界 YYYY-MM-DD；不传则不设上界"
        );
        IndustrialToolSchemas.string(
                schema,
                "item",
                "制品编码或名称片段"
        );
        IndustrialToolSchemas.stringEnum(
                schema,
                "state",
                "排产状态：unscheduled=未排产，scheduled=已排产，released=已下达，completed=已完成；不传则返回全部",
                STATES.stream().sorted().toList()
        );
        IndustrialToolSchemas.stringEnum(
                schema,
                "priority",
                "需求优先级；不传则返回全部",
                PRIORITIES.stream().sorted().toList()
        );
        return schema;
    }
}
