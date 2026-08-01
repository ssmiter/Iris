package com.iris.tools.industry.mes._14personnel.output;

import com.fasterxml.jackson.databind.ObjectMapper;
import com.iris.industry.demo.IndustrialDemoRepository;
import com.iris.tools.industry.IndustrialToolSchemas;
import com.iris.tools.industry.mes.AbstractMesProcessQueryTool;
import org.springframework.stereotype.Component;

import java.util.Set;

@Component
public class QueryMesPersonnelOutputTool
        extends AbstractMesProcessQueryTool {
    private static final Set<String> RECORD_TYPES = Set.of("shift_output");

    public QueryMesPersonnelOutputTool(
            ObjectMapper objectMapper,
            IndustrialDemoRepository repository
    ) {
        super(
                objectMapper,
                repository,
                readManifest(
                        "iris.industry.mes.personnel_output",
                        "query_mes_personnel_output",
                        "查询 MES 域的班组班次产出（出勤、产量、所在工序、关联计划）；分析人员绩效与工序人力匹配时使用",
                        processInputSchema(
                                objectMapper,
                                RECORD_TYPES,
                                "记录类型：shift_output=班次产出",
                                "班组所在车间或产线编码，精确匹配"
                        ),
                        IndustrialToolSchemas.output(objectMapper)
                ),
                "personnel",
                "personnel_output",
                RECORD_TYPES
        );
    }
}
