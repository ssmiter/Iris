package com.iris.tools.industry.mes._11equipment.status;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.node.ObjectNode;
import com.iris.industry.demo.IndustrialDemoRepository;
import com.iris.tools.industry.IndustrialToolSchemas;
import com.iris.tools.industry.mes.AbstractMesReadTool;
import org.springframework.stereotype.Component;

import java.util.Set;

@Component
public class QueryMesEquipmentStatusTool extends AbstractMesReadTool {
    private static final Set<String> STATES = Set.of(
            "running",
            "idle",
            "warning",
            "maintenance",
            "offline"
    );

    public QueryMesEquipmentStatusTool(
            ObjectMapper objectMapper,
            IndustrialDemoRepository repository
    ) {
        super(
                objectMapper,
                repository,
                readManifest(
                        "iris.industry.mes.equipment_status",
                        "query_mes_equipment_status",
                        "查询脱敏模拟 MES 的设备状态、利用率、当前计划与最新告警；观察车间运行态势时使用",
                        inputSchema(objectMapper),
                        IndustrialToolSchemas.output(objectMapper)
                )
        );
    }

    @Override
    protected String view() {
        return "equipment_status";
    }

    @Override
    protected ObjectNode normalize(JsonNode input) {
        ObjectNode normalized = normalizedBase(input);
        copyText(input, normalized, "process_code", 40);
        copyText(input, normalized, "equipment", 80);
        copyEnum(input, normalized, "state", STATES);
        return normalized;
    }

    @Override
    protected ObjectNode query(ObjectNode normalized) {
        return repository.equipmentStates(domain(), normalized);
    }

    private static ObjectNode inputSchema(ObjectMapper mapper) {
        ObjectNode schema = IndustrialToolSchemas.input(mapper);
        IndustrialToolSchemas.string(
                schema,
                "process_code",
                "工序编码，如 mixing、forming、curing；精确匹配"
        );
        IndustrialToolSchemas.string(
                schema,
                "equipment",
                "设备编码或名称片段"
        );
        IndustrialToolSchemas.string(
                schema,
                "state",
                "设备状态：running、idle、warning、maintenance 或 offline"
        );
        return schema;
    }
}
