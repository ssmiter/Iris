package com.iris.tools.industry.mes._14personnel.teams;

import com.fasterxml.jackson.databind.ObjectMapper;
import com.iris.industry.demo.IndustrialDemoRepository;
import com.iris.tools.industry.IndustrialToolSchemas;
import com.iris.tools.industry.mes.AbstractMesReferenceQueryTool;
import org.springframework.stereotype.Component;

@Component
public class QueryMesShiftTeamsTool extends AbstractMesReferenceQueryTool {

    public QueryMesShiftTeamsTool(
            ObjectMapper objectMapper,
            IndustrialDemoRepository repository
    ) {
        super(
                objectMapper,
                repository,
                readManifest(
                        "iris.industry.mes.shift_teams",
                        "query_mes_shift_teams",
                        "查询 MES 域的班组主数据（人数、技能标签、适用工序）；评估人力配置与排班时使用，班次产出见 query_mes_personnel_output",
                        referenceInputSchema(objectMapper, "班组"),
                        IndustrialToolSchemas.output(objectMapper)
                ),
                "team",
                "shift_teams"
        );
    }
}
