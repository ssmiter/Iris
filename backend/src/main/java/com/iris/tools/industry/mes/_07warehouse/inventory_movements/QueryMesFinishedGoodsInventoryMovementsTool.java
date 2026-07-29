package com.iris.tools.industry.mes._07warehouse.inventory_movements;

import com.fasterxml.jackson.databind.ObjectMapper;
import com.iris.industry.demo.IndustrialDemoRepository;
import com.iris.tools.industry.IndustrialToolSchemas;
import com.iris.tools.industry.mes.AbstractMesProcessQueryTool;
import org.springframework.stereotype.Component;

import java.util.Set;

@Component
public class QueryMesFinishedGoodsInventoryMovementsTool
        extends AbstractMesProcessQueryTool {
    private static final Set<String> TYPES =
            Set.of("inventory", "movement");

    public QueryMesFinishedGoodsInventoryMovementsTool(
            ObjectMapper objectMapper,
            IndustrialDemoRepository repository
    ) {
        super(
                objectMapper,
                repository,
                readManifest(
                        "iris.industry.mes.finished_goods_inventory_movements",
                        "query_mes_finished_goods_inventory_movements",
                        "查询脱敏模拟 MES 的成品库存与出入库流转；确认可用量、分配冻结或某批装运执行情况时使用，不包含原材料仓库存",
                        processInputSchema(
                                objectMapper,
                                TYPES,
                                "记录类型：inventory 表示成品库存，movement 表示出入库或装运流转",
                                "成品仓、库位或装运月台编码，精确匹配"
                        ),
                        IndustrialToolSchemas.output(objectMapper)
                ),
                "warehouse",
                "finished_goods_inventory_movements",
                TYPES
        );
    }
}
