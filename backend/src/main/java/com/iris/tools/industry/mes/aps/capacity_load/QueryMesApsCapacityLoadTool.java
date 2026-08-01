package com.iris.tools.industry.mes.aps.capacity_load;

import com.fasterxml.jackson.databind.ObjectMapper;
import com.iris.industry.demo.IndustrialDemoRepository;
import com.iris.tools.industry.IndustrialToolSchemas;
import com.iris.tools.industry.mes.AbstractMesProcessQueryTool;
import org.springframework.stereotype.Component;

import java.util.Set;

@Component
public class QueryMesApsCapacityLoadTool
        extends AbstractMesProcessQueryTool {
    private static final Set<String> RECORD_TYPES = Set.of("capacity");

    public QueryMesApsCapacityLoadTool(
            ObjectMapper objectMapper,
            IndustrialDemoRepository repository
    ) {
        super(
                objectMapper,
                repository,
                readManifest(
                        "iris.industry.mes.aps_capacity_load",
                        "query_mes_aps_capacity_load",
                        "查询 MES 域的产线组产能与负荷、瓶颈标记；评估排产可行性与定位瓶颈工序时使用",
                        processInputSchema(
                                objectMapper,
                                RECORD_TYPES,
                                "记录类型：capacity=产能负荷",
                                "产线组编码，精确匹配"
                        ),
                        IndustrialToolSchemas.output(objectMapper)
                ),
                "aps",
                "aps_capacity_load",
                RECORD_TYPES
        );
    }
}
