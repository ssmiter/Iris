package com.iris.tools.industry.mes._13mould.status;

import com.fasterxml.jackson.databind.ObjectMapper;
import com.iris.industry.demo.IndustrialDemoRepository;
import com.iris.tools.industry.IndustrialToolSchemas;
import com.iris.tools.industry.mes.AbstractMesReferenceQueryTool;
import org.springframework.stereotype.Component;

@Component
public class QueryMesMouldStatusTool extends AbstractMesReferenceQueryTool {

    public QueryMesMouldStatusTool(
            ObjectMapper objectMapper,
            IndustrialDemoRepository repository
    ) {
        super(
                objectMapper,
                repository,
                readManifest(
                        "iris.industry.mes.mould_status",
                        "query_mes_mould_status",
                        "查询脱敏模拟 MES 的模具状态、当前位置、累计使用和维护阈值；判断某制品模具是否可用于排产或是否临近维护时使用",
                        referenceInputSchema(
                                objectMapper,
                                "模具"
                        ),
                        IndustrialToolSchemas.output(objectMapper)
                ),
                "mould",
                "mould_status"
        );
    }
}
