package com.iris.tools.industry.mes._13mould.changes;

import com.fasterxml.jackson.databind.ObjectMapper;
import com.iris.industry.demo.IndustrialDemoRepository;
import com.iris.tools.industry.IndustrialToolSchemas;
import com.iris.tools.industry.mes.AbstractMesProcessQueryTool;
import org.springframework.stereotype.Component;

import java.util.Set;

@Component
public class QueryMesMouldChangesTool extends AbstractMesProcessQueryTool {
    private static final Set<String> RECORD_TYPES = Set.of("change_plan");

    public QueryMesMouldChangesTool(
            ObjectMapper objectMapper,
            IndustrialDemoRepository repository
    ) {
        super(
                objectMapper,
                repository,
                readManifest(
                        "iris.industry.mes.mould_changes",
                        "query_mes_mould_changes",
                        "查询 MES 域的换模计划（机台、从/到模具、计划开始时间、原因）；安排换模或评估硫化产能影响时使用",
                        processInputSchema(
                                objectMapper,
                                RECORD_TYPES,
                                "记录类型：change_plan=换模计划",
                                "换模机台编码，精确匹配"
                        ),
                        IndustrialToolSchemas.output(objectMapper)
                ),
                "mould",
                "mould_changes",
                RECORD_TYPES
        );
    }
}
