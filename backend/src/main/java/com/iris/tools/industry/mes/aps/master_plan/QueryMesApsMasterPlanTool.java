package com.iris.tools.industry.mes.aps.master_plan;

import com.fasterxml.jackson.databind.ObjectMapper;
import com.iris.industry.demo.IndustrialDemoRepository;
import com.iris.tools.industry.IndustrialToolSchemas;
import com.iris.tools.industry.mes.AbstractMesProcessQueryTool;
import org.springframework.stereotype.Component;

import java.util.Set;

@Component
public class QueryMesApsMasterPlanTool extends AbstractMesProcessQueryTool {
    private static final Set<String> RECORD_TYPES = Set.of("master_plan");

    public QueryMesApsMasterPlanTool(
            ObjectMapper objectMapper,
            IndustrialDemoRepository repository
    ) {
        super(
                objectMapper,
                repository,
                readManifest(
                        "iris.industry.mes.aps_master_plan",
                        "query_mes_aps_master_plan",
                        "查询 MES 域的 AP 主计划结果（计划号、revision、资源、起止日期、关联需求）；跟踪主计划版本与需求覆盖时使用",
                        processInputSchema(
                                objectMapper,
                                RECORD_TYPES,
                                "记录类型：master_plan=AP 主计划",
                                "主计划占用资源（如模具）编码，精确匹配"
                        ),
                        IndustrialToolSchemas.output(objectMapper)
                ),
                "aps",
                "aps_master_plan",
                RECORD_TYPES
        );
    }
}
