package com.iris.tools.industry.mes._09reports.plan_execution;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.node.ObjectNode;
import com.iris.industry.demo.IndustrialDemoRepository;
import com.iris.tools.industry.IndustrialToolSchemas;
import com.iris.tools.industry.mes.AbstractMesReadTool;
import org.springframework.stereotype.Component;

import java.util.Set;

@Component
public class ReportMesPlanExecutionTool extends AbstractMesReadTool {
    private static final Set<String> PROCESSES = Set.of(
            "mixing",
            "forming",
            "curing"
    );

    public ReportMesPlanExecutionTool(
            ObjectMapper objectMapper,
            IndustrialDemoRepository repository
    ) {
        super(
                objectMapper,
                repository,
                readManifest(
                        "iris.industry.mes.report_plan_execution",
                        "report_mes_plan_execution",
                        "按工序与日期聚合 MES 域的计划量、完成量与达成率，附合计；做计划执行日报或评估达成情况时使用",
                        inputSchema(objectMapper),
                        IndustrialToolSchemas.output(objectMapper)
                )
        );
    }

    @Override
    protected String view() {
        return "report_plan_execution";
    }

    @Override
    protected ObjectNode normalize(JsonNode input) {
        ObjectNode normalized = normalizedBase(input);
        copyDate(input, normalized, "start_date");
        copyDate(input, normalized, "end_date");
        requireDateOrder(normalized);
        copyEnum(input, normalized, "process_code", PROCESSES);
        return normalized;
    }

    @Override
    protected ObjectNode query(ObjectNode normalized) {
        return repository.reportPlanExecution(domain(), normalized);
    }

    private static ObjectNode inputSchema(ObjectMapper mapper) {
        ObjectNode schema = IndustrialToolSchemas.input(mapper);
        IndustrialToolSchemas.string(
                schema,
                "start_date",
                "统计开始日期 YYYY-MM-DD；不传则不设下界"
        );
        IndustrialToolSchemas.string(
                schema,
                "end_date",
                "统计结束日期 YYYY-MM-DD；不传则不设上界"
        );
        IndustrialToolSchemas.stringEnum(
                schema,
                "process_code",
                "工序；不传则覆盖全部工序",
                PROCESSES.stream().sorted().toList()
        );
        return schema;
    }
}
