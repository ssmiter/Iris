package com.iris.tools.industry.mes.aps.demand_schedule;

import com.fasterxml.jackson.databind.ObjectMapper;
import com.iris.industry.demo.IndustrialDemoRepository;
import com.iris.tools.industry.IndustrialToolSchemas;
import com.iris.tools.industry.mes.AbstractMesProcessQueryTool;
import org.springframework.stereotype.Component;

import java.util.Set;

@Component
public class QueryMesApsDemandScheduleTool
        extends AbstractMesProcessQueryTool {
    private static final Set<String> TYPES =
            Set.of("demand", "schedule");

    public QueryMesApsDemandScheduleTool(
            ObjectMapper objectMapper,
            IndustrialDemoRepository repository
    ) {
        super(
                objectMapper,
                repository,
                readManifest(
                        "iris.industry.mes.aps_demand_schedule",
                        "query_mes_aps_demand_schedule",
                        "查询 MES 域的排产需求与跨工序计划结果；比较需求数量、可行排程、瓶颈和预计完成时间时使用，不执行重新排产或发布计划",
                        processInputSchema(
                                objectMapper,
                                TYPES,
                                "记录类型：demand 表示待满足需求，schedule 表示计算后的排程结果",
                                "排程资源组或产线组编码，精确匹配"
                        ),
                        IndustrialToolSchemas.output(objectMapper)
                ),
                "aps",
                "aps_demand_schedule",
                TYPES
        );
    }
}
