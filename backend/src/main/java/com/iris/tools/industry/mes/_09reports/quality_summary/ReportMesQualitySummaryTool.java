package com.iris.tools.industry.mes._09reports.quality_summary;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.node.ObjectNode;
import com.iris.industry.demo.IndustrialDemoRepository;
import com.iris.tools.industry.IndustrialToolSchemas;
import com.iris.tools.industry.mes.AbstractMesReadTool;
import org.springframework.stereotype.Component;

@Component
public class ReportMesQualitySummaryTool extends AbstractMesReadTool {

    public ReportMesQualitySummaryTool(
            ObjectMapper objectMapper,
            IndustrialDemoRepository repository
    ) {
        super(
                objectMapper,
                repository,
                readManifest(
                        "iris.industry.mes.report_quality_summary",
                        "report_mes_quality_summary",
                        "按物料聚合 MES 域的快检测量数、合格率与未闭环质量异常数，附合计；做质量汇总或筛查重点物料时使用",
                        inputSchema(objectMapper),
                        IndustrialToolSchemas.output(objectMapper)
                )
        );
    }

    @Override
    protected String view() {
        return "report_quality_summary";
    }

    @Override
    protected ObjectNode normalize(JsonNode input) {
        ObjectNode normalized = normalizedBase(input);
        copyDate(input, normalized, "start_date");
        copyDate(input, normalized, "end_date");
        requireDateOrder(normalized);
        return normalized;
    }

    @Override
    protected ObjectNode query(ObjectNode normalized) {
        return repository.reportQualitySummary(domain(), normalized);
    }

    private static ObjectNode inputSchema(ObjectMapper mapper) {
        ObjectNode schema = IndustrialToolSchemas.input(mapper);
        IndustrialToolSchemas.string(
                schema,
                "start_date",
                "采样开始日期 YYYY-MM-DD；不传则不设下界"
        );
        IndustrialToolSchemas.string(
                schema,
                "end_date",
                "采样结束日期 YYYY-MM-DD；不传则不设上界"
        );
        return schema;
    }
}
