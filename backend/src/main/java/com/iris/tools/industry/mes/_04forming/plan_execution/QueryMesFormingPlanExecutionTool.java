package com.iris.tools.industry.mes._04forming.plan_execution;

import com.fasterxml.jackson.databind.ObjectMapper;
import com.iris.industry.demo.IndustrialDemoRepository;
import com.iris.tools.industry.IndustrialToolSchemas;
import com.iris.tools.industry.mes.AbstractMesProcessQueryTool;
import org.springframework.stereotype.Component;

import java.util.Set;

@Component
public class QueryMesFormingPlanExecutionTool
        extends AbstractMesProcessQueryTool {
    private static final Set<String> TYPES =
            Set.of("plan", "production");

    public QueryMesFormingPlanExecutionTool(
            ObjectMapper objectMapper,
            IndustrialDemoRepository repository
    ) {
        super(
                objectMapper,
                repository,
                readManifest(
                        "iris.industry.mes.forming_plan_execution",
                        "query_mes_forming_plan_execution",
                        "查询脱敏模拟 MES 的成型计划与生产实绩；比较机台计划数量、实际完成和合格损耗时使用，不负责修改排程或报工",
                        processInputSchema(
                                objectMapper,
                                TYPES,
                                "记录类型：plan 表示成型计划，production 表示生产实绩",
                                "成型机台编码，精确匹配"
                        ),
                        IndustrialToolSchemas.output(objectMapper)
                ),
                "forming",
                "forming_plan_execution",
                TYPES
        );
    }
}
