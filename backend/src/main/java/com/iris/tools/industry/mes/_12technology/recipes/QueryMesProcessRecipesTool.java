package com.iris.tools.industry.mes._12technology.recipes;

import com.fasterxml.jackson.databind.ObjectMapper;
import com.iris.industry.demo.IndustrialDemoRepository;
import com.iris.tools.industry.IndustrialToolSchemas;
import com.iris.tools.industry.mes.AbstractMesReferenceQueryTool;
import org.springframework.stereotype.Component;

@Component
public class QueryMesProcessRecipesTool extends AbstractMesReferenceQueryTool {

    public QueryMesProcessRecipesTool(
            ObjectMapper objectMapper,
            IndustrialDemoRepository repository
    ) {
        super(
                objectMapper,
                repository,
                readManifest(
                        "iris.industry.mes.process_recipes",
                        "query_mes_process_recipes",
                        "查询脱敏模拟 MES 的配方版本、启用状态、适用工序和关键摘要；核对生产使用哪个配方或版本是否批准时使用，不返回真实配比明细",
                        referenceInputSchema(
                                objectMapper,
                                "配方"
                        ),
                        IndustrialToolSchemas.output(objectMapper)
                ),
                "recipe",
                "process_recipes"
        );
    }
}
