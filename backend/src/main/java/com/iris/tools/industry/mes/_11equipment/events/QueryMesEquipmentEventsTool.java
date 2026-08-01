package com.iris.tools.industry.mes._11equipment.events;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.node.ObjectNode;
import com.iris.industry.demo.IndustrialDemoRepository;
import com.iris.tools.industry.IndustrialToolSchemas;
import com.iris.tools.industry.mes.AbstractMesReadTool;
import org.springframework.stereotype.Component;

import java.util.Set;

@Component
public class QueryMesEquipmentEventsTool extends AbstractMesReadTool {
    private static final Set<String> SEVERITIES = Set.of(
            "info",
            "low",
            "medium",
            "high"
    );
    private static final Set<String> PROCESSES = Set.of(
            "mixing",
            "forming",
            "curing",
            "quality"
    );

    public QueryMesEquipmentEventsTool(
            ObjectMapper objectMapper,
            IndustrialDemoRepository repository
    ) {
        super(
                objectMapper,
                repository,
                readManifest(
                        "iris.industry.mes.equipment_events",
                        "query_mes_equipment_events",
                        "查询 MES 域跨工序的设备停机、降速与过程告警事件，可按工序过滤；分析设备损失与异常分布时使用，只看密炼工序可用 query_mes_mixing_equipment_events",
                        inputSchema(objectMapper),
                        IndustrialToolSchemas.output(objectMapper)
                )
        );
    }

    @Override
    protected String view() {
        return "equipment_events";
    }

    @Override
    protected ObjectNode normalize(JsonNode input) {
        ObjectNode normalized = normalizedBase(input);
        copyDate(input, normalized, "start_date");
        copyDate(input, normalized, "end_date");
        requireDateOrder(normalized);
        copyText(input, normalized, "equipment_code", 40);
        copyEnum(input, normalized, "severity", SEVERITIES);
        copyEnum(input, normalized, "process_code", PROCESSES);
        normalized.put(
                "unresolved_only",
                input.path("unresolved_only").asBoolean(false)
        );
        return normalized;
    }

    @Override
    protected ObjectNode query(ObjectNode normalized) {
        return repository.equipmentEvents(domain(), normalized);
    }

    private static ObjectNode inputSchema(ObjectMapper mapper) {
        ObjectNode schema = IndustrialToolSchemas.input(mapper);
        IndustrialToolSchemas.string(
                schema,
                "start_date",
                "事件开始日期 YYYY-MM-DD；不传则不设下界"
        );
        IndustrialToolSchemas.string(
                schema,
                "end_date",
                "事件结束日期 YYYY-MM-DD；不传则不设上界"
        );
        IndustrialToolSchemas.string(
                schema,
                "equipment_code",
                "设备编码，精确匹配"
        );
        IndustrialToolSchemas.stringEnum(
                schema,
                "severity",
                "严重度；不传则返回全部",
                SEVERITIES.stream().sorted().toList()
        );
        IndustrialToolSchemas.stringEnum(
                schema,
                "process_code",
                "所属工序；不传则跨工序返回",
                PROCESSES.stream().sorted().toList()
        );
        IndustrialToolSchemas.bool(
                schema,
                "unresolved_only",
                "是否只返回尚未闭环的事件；默认 false"
        );
        return schema;
    }
}
