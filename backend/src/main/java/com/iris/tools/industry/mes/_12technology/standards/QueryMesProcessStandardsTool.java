package com.iris.tools.industry.mes._12technology.standards;

import com.fasterxml.jackson.databind.ObjectMapper;
import com.iris.industry.demo.IndustrialDemoRepository;
import com.iris.tools.industry.IndustrialToolSchemas;
import com.iris.tools.industry.mes.AbstractMesReferenceQueryTool;
import org.springframework.stereotype.Component;

@Component
public class QueryMesProcessStandardsTool
        extends AbstractMesReferenceQueryTool {

    public QueryMesProcessStandardsTool(
            ObjectMapper objectMapper,
            IndustrialDemoRepository repository
    ) {
        super(
                objectMapper,
                repository,
                readManifest(
                        "iris.industry.mes.process_standards",
                        "query_mes_process_standards",
                        "查询 MES 域的工艺标准版本与关键参数摘要；确认工艺窗口或比对现场执行参数时使用",
                        referenceInputSchema(objectMapper, "工艺标准"),
                        IndustrialToolSchemas.output(objectMapper)
                ),
                "process_standard",
                "process_standards"
        );
    }
}
