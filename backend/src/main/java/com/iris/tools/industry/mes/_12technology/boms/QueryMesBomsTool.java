package com.iris.tools.industry.mes._12technology.boms;

import com.fasterxml.jackson.databind.ObjectMapper;
import com.iris.industry.demo.IndustrialDemoRepository;
import com.iris.tools.industry.IndustrialToolSchemas;
import com.iris.tools.industry.mes.AbstractMesReferenceQueryTool;
import org.springframework.stereotype.Component;

@Component
public class QueryMesBomsTool extends AbstractMesReferenceQueryTool {

    public QueryMesBomsTool(
            ObjectMapper objectMapper,
            IndustrialDemoRepository repository
    ) {
        super(
                objectMapper,
                repository,
                readManifest(
                        "iris.industry.mes.boms",
                        "query_mes_boms",
                        "查询 MES 域的产品与半制品 BOM 组成；核算物料需求或排查用料差异时使用",
                        referenceInputSchema(objectMapper, "BOM"),
                        IndustrialToolSchemas.output(objectMapper)
                ),
                "bom",
                "boms"
        );
    }
}
