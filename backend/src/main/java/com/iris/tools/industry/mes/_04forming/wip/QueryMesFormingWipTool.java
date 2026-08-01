package com.iris.tools.industry.mes._04forming.wip;

import com.fasterxml.jackson.databind.ObjectMapper;
import com.iris.industry.demo.IndustrialDemoRepository;
import com.iris.tools.industry.IndustrialToolSchemas;
import com.iris.tools.industry.mes.AbstractMesProcessQueryTool;
import org.springframework.stereotype.Component;

import java.util.Set;

@Component
public class QueryMesFormingWipTool extends AbstractMesProcessQueryTool {
    private static final Set<String> RECORD_TYPES = Set.of("wip");

    public QueryMesFormingWipTool(
            ObjectMapper objectMapper,
            IndustrialDemoRepository repository
    ) {
        super(
                objectMapper,
                repository,
                readManifest(
                        "iris.industry.mes.forming_wip",
                        "query_mes_forming_wip",
                        "查询 MES 域的成型在制品缓冲（半制品用料、龄期、分配的下游计划）；判断成型与硫化工序间的在制积压时使用",
                        processInputSchema(
                                objectMapper,
                                RECORD_TYPES,
                                "记录类型：wip=成型在制品",
                                "在制品缓冲区或机台编码，精确匹配"
                        ),
                        IndustrialToolSchemas.output(objectMapper)
                ),
                "forming",
                "forming_wip",
                RECORD_TYPES
        );
    }
}
