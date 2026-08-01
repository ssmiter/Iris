package com.iris.tools.industry.mes._01raw.incoming_quality;

import com.fasterxml.jackson.databind.ObjectMapper;
import com.iris.industry.demo.IndustrialDemoRepository;
import com.iris.tools.industry.IndustrialToolSchemas;
import com.iris.tools.industry.mes.AbstractMesProcessQueryTool;
import org.springframework.stereotype.Component;

import java.util.Set;

@Component
public class QueryMesRawIncomingQualityTool
        extends AbstractMesProcessQueryTool {
    private static final Set<String> RECORD_TYPES = Set.of("inspection");

    public QueryMesRawIncomingQualityTool(
            ObjectMapper objectMapper,
            IndustrialDemoRepository repository
    ) {
        super(
                objectMapper,
                repository,
                readManifest(
                        "iris.industry.mes.raw_incoming_quality",
                        "query_mes_raw_incoming_quality",
                        "查询 MES 域的来料检验记录、指标明细与判定结论；评估来料质量或处理来料搁置时使用，不包含密炼在线快检（见 query_mes_mixing_quality）",
                        processInputSchema(
                                objectMapper,
                                RECORD_TYPES,
                                "记录类型：inspection=来料检验",
                                "检验台位或采样点编码，精确匹配"
                        ),
                        IndustrialToolSchemas.output(objectMapper)
                ),
                "raw",
                "raw_incoming_quality",
                RECORD_TYPES
        );
    }
}
