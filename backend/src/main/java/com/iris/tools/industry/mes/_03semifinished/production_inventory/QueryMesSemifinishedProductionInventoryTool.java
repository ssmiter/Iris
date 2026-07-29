package com.iris.tools.industry.mes._03semifinished.production_inventory;

import com.fasterxml.jackson.databind.ObjectMapper;
import com.iris.industry.demo.IndustrialDemoRepository;
import com.iris.tools.industry.IndustrialToolSchemas;
import com.iris.tools.industry.mes.AbstractMesProcessQueryTool;
import org.springframework.stereotype.Component;

import java.util.Set;

@Component
public class QueryMesSemifinishedProductionInventoryTool
        extends AbstractMesProcessQueryTool {
    private static final Set<String> TYPES =
            Set.of("production", "inventory");

    public QueryMesSemifinishedProductionInventoryTool(
            ObjectMapper objectMapper,
            IndustrialDemoRepository repository
    ) {
        super(
                objectMapper,
                repository,
                readManifest(
                        "iris.industry.mes.semifinished_production_inventory",
                        "query_mes_semifinished_production_inventory",
                        "查询脱敏模拟 MES 的半制品产出与缓冲库存；判断上游产出能否支撑成型、定位缺料或积压时优先使用，不包含原料和成品库存",
                        processInputSchema(
                                objectMapper,
                                TYPES,
                                "记录类型：production 表示半制品产出，inventory 表示缓冲库存",
                                "生产线或半制品缓存区编码，精确匹配"
                        ),
                        IndustrialToolSchemas.output(objectMapper)
                ),
                "semifinished",
                "semifinished_production_inventory",
                TYPES
        );
    }
}
