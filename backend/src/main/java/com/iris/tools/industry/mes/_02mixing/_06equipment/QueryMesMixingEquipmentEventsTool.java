package com.iris.tools.industry.mes._02mixing._06equipment;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.node.ObjectNode;
import com.iris.industry.demo.IndustrialDemoRepository;
import com.iris.tools.industry.IndustrialToolSchemas;
import com.iris.tools.industry.mes.AbstractMesReadTool;
import org.springframework.stereotype.Component;

import java.util.Set;

@Component
public class QueryMesMixingEquipmentEventsTool
        extends AbstractMesReadTool {
    private static final Set<String> SEVERITIES = Set.of(
            "info",
            "low",
            "medium",
            "high"
    );

    public QueryMesMixingEquipmentEventsTool(
            ObjectMapper objectMapper,
            IndustrialDemoRepository repository
    ) {
        super(
                objectMapper,
                repository,
                readManifest(
                        "iris.industry.mes.mixing_equipment_events",
                        "query_mes_mixing_equipment_events",
                        "查询 MES 域的密炼设备停机、降速与过程告警事件；定位损失时间和未闭环异常时使用",
                        inputSchema(objectMapper),
                        IndustrialToolSchemas.output(objectMapper)
                )
        );
    }

    @Override
    protected String view() {
        return "mixing_equipment_events";
    }

    @Override
    protected ObjectNode normalize(JsonNode input) {
        ObjectNode normalized = normalizedBase(input);
        copyDate(input, normalized, "start_date");
        copyDate(input, normalized, "end_date");
        requireDateOrder(normalized);
        copyText(input, normalized, "equipment_code", 40);
        copyEnum(input, normalized, "severity", SEVERITIES);
        normalized.put(
                "unresolved_only",
                input.path("unresolved_only").asBoolean(false)
        );
        // 本工具只覆盖密炼工序；跨工序视角见 _11equipment/events
        normalized.put("process_code", "mixing");
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
                "密炼设备编码，精确匹配"
        );
        IndustrialToolSchemas.string(
                schema,
                "severity",
                "严重度：info、low、medium 或 high"
        );
        IndustrialToolSchemas.bool(
                schema,
                "unresolved_only",
                "是否只返回尚未闭环的事件；默认 false"
        );
        return schema;
    }
}
