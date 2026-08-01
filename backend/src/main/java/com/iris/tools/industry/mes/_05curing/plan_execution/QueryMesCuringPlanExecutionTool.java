package com.iris.tools.industry.mes._05curing.plan_execution;

import com.fasterxml.jackson.databind.ObjectMapper;
import com.iris.industry.demo.IndustrialDemoRepository;
import com.iris.tools.industry.IndustrialToolSchemas;
import com.iris.tools.industry.mes.AbstractMesProcessQueryTool;
import org.springframework.stereotype.Component;

import java.util.Set;

@Component
public class QueryMesCuringPlanExecutionTool
        extends AbstractMesProcessQueryTool {
    private static final Set<String> TYPES =
            Set.of("plan", "production");

    public QueryMesCuringPlanExecutionTool(
            ObjectMapper objectMapper,
            IndustrialDemoRepository repository
    ) {
        super(
                objectMapper,
                repository,
                readManifest(
                        "iris.industry.mes.curing_plan_execution",
                        "query_mes_curing_plan_execution",
                        "查询 MES 域的硫化计划与生产实绩；核对设备负荷、模具安排、周期和合格产出时使用，不包含质量终检或设备维护",
                        processInputSchema(
                                objectMapper,
                                TYPES,
                                "记录类型：plan 表示硫化计划，production 表示生产实绩",
                                "硫化设备编码，精确匹配"
                        ),
                        IndustrialToolSchemas.output(objectMapper)
                ),
                "curing",
                "curing_plan_execution",
                TYPES
        );
    }
}
