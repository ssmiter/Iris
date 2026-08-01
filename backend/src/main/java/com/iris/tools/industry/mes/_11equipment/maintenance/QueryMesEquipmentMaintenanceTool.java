package com.iris.tools.industry.mes._11equipment.maintenance;

import com.fasterxml.jackson.databind.ObjectMapper;
import com.iris.industry.demo.IndustrialDemoRepository;
import com.iris.tools.industry.IndustrialToolSchemas;
import com.iris.tools.industry.mes.AbstractMesProcessQueryTool;
import org.springframework.stereotype.Component;

import java.util.Set;

@Component
public class QueryMesEquipmentMaintenanceTool
        extends AbstractMesProcessQueryTool {
    private static final Set<String> RECORD_TYPES = Set.of(
            "inspection",
            "maintenance"
    );

    public QueryMesEquipmentMaintenanceTool(
            ObjectMapper objectMapper,
            IndustrialDemoRepository repository
    ) {
        super(
                objectMapper,
                repository,
                readManifest(
                        "iris.industry.mes.equipment_maintenance",
                        "query_mes_equipment_maintenance",
                        "查询 MES 域的设备点检与维护记录、结果与下次到期；安排保养或排查设备隐患时使用",
                        processInputSchema(
                                objectMapper,
                                RECORD_TYPES,
                                "记录类型：inspection=点检，maintenance=维护",
                                "设备编码，精确匹配"
                        ),
                        IndustrialToolSchemas.output(objectMapper)
                ),
                "equipment",
                "equipment_maintenance",
                RECORD_TYPES
        );
    }
}
