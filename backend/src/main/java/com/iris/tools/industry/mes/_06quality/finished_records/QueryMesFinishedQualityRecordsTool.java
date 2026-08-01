package com.iris.tools.industry.mes._06quality.finished_records;

import com.fasterxml.jackson.databind.ObjectMapper;
import com.iris.industry.demo.IndustrialDemoRepository;
import com.iris.tools.industry.IndustrialToolSchemas;
import com.iris.tools.industry.mes.AbstractMesProcessQueryTool;
import org.springframework.stereotype.Component;

import java.util.Set;

@Component
public class QueryMesFinishedQualityRecordsTool
        extends AbstractMesProcessQueryTool {
    private static final Set<String> TYPES =
            Set.of("inspection", "exception");

    public QueryMesFinishedQualityRecordsTool(
            ObjectMapper objectMapper,
            IndustrialDemoRepository repository
    ) {
        super(
                objectMapper,
                repository,
                readManifest(
                        "iris.industry.mes.finished_quality_records",
                        "query_mes_finished_quality_records",
                        "查询 MES 域的成品检验批次与质量异常；分析通过数量、缺陷影响范围和待处置问题时使用，不替代密炼胶料测量工具",
                        processInputSchema(
                                objectMapper,
                                TYPES,
                                "记录类型：inspection 表示检验批次，exception 表示质量异常",
                                "检验线或检测资源编码，精确匹配"
                        ),
                        IndustrialToolSchemas.output(objectMapper)
                ),
                "quality",
                "finished_quality_records",
                TYPES
        );
    }
}
