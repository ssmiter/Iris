package com.iris.tools.industry.mes._10plan.calendars;

import com.fasterxml.jackson.databind.ObjectMapper;
import com.iris.industry.demo.IndustrialDemoRepository;
import com.iris.tools.industry.IndustrialToolSchemas;
import com.iris.tools.industry.mes.AbstractMesReferenceQueryTool;
import org.springframework.stereotype.Component;

import java.util.Set;

@Component
public class QueryMesPlanCalendarsTool
        extends AbstractMesReferenceQueryTool {

    public QueryMesPlanCalendarsTool(
            ObjectMapper objectMapper,
            IndustrialDemoRepository repository
    ) {
        super(
                objectMapper,
                repository,
                readManifest(
                        "iris.industry.mes.plan_calendars",
                        "query_mes_plan_calendars",
                        "查询 MES 域的工厂日历与班次模板（工作日、节假日、班次起止、休息安排）；评估排产可行性与资源可用时段时使用",
                        referenceInputSchema(objectMapper, "日历或班次模板"),
                        IndustrialToolSchemas.output(objectMapper)
                ),
                Set.of("calendar", "shift_template"),
                "plan_calendars"
        );
    }
}
