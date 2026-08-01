package com.iris.tools.industry.mes._02mixing.consumption;

import com.fasterxml.jackson.databind.ObjectMapper;
import com.iris.industry.demo.IndustrialDemoRepository;
import com.iris.tools.industry.IndustrialToolSchemas;
import com.iris.tools.industry.mes.AbstractMesProcessQueryTool;
import org.springframework.stereotype.Component;

import java.util.Set;

@Component
public class QueryMesMixingConsumptionTool
        extends AbstractMesProcessQueryTool {
    private static final Set<String> RECORD_TYPES = Set.of("consumption");

    public QueryMesMixingConsumptionTool(
            ObjectMapper objectMapper,
            IndustrialDemoRepository repository
    ) {
        super(
                objectMapper,
                repository,
                readManifest(
                        "iris.industry.mes.mixing_consumption",
                        "query_mes_mixing_consumption",
                        "查询 MES 域的密炼投料与消耗明细（组分、目标与实际用量、关联批次）；核对配方执行与物料消耗时使用",
                        processInputSchema(
                                objectMapper,
                                RECORD_TYPES,
                                "记录类型：consumption=投料消耗",
                                "密炼设备编码，精确匹配"
                        ),
                        IndustrialToolSchemas.output(objectMapper)
                ),
                "mixing",
                "mixing_consumption",
                RECORD_TYPES
        );
    }
}
