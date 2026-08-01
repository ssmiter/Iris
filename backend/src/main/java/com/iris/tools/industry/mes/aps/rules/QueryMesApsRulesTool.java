package com.iris.tools.industry.mes.aps.rules;

import com.fasterxml.jackson.databind.ObjectMapper;
import com.iris.industry.demo.IndustrialDemoRepository;
import com.iris.tools.industry.IndustrialToolSchemas;
import com.iris.tools.industry.mes.AbstractMesReferenceQueryTool;
import org.springframework.stereotype.Component;

@Component
public class QueryMesApsRulesTool extends AbstractMesReferenceQueryTool {

    public QueryMesApsRulesTool(
            ObjectMapper objectMapper,
            IndustrialDemoRepository repository
    ) {
        super(
                objectMapper,
                repository,
                readManifest(
                        "iris.industry.mes.aps_rules",
                        "query_mes_aps_rules",
                        "查询 MES 域的排产规则词表（硬/软约束、适用范围、业务解释）；解释排产结果依据或讨论排产策略时使用",
                        referenceInputSchema(objectMapper, "排产规则"),
                        IndustrialToolSchemas.output(objectMapper)
                ),
                "scheduling_rule",
                "aps_rules"
        );
    }
}
