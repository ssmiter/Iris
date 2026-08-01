package com.iris.tools.industry.mes._07warehouse.shipments;

import com.fasterxml.jackson.databind.ObjectMapper;
import com.iris.industry.demo.IndustrialDemoRepository;
import com.iris.tools.industry.IndustrialToolSchemas;
import com.iris.tools.industry.mes.AbstractMesProcessQueryTool;
import org.springframework.stereotype.Component;

import java.util.Set;

@Component
public class QueryMesShipmentsTool extends AbstractMesProcessQueryTool {
    private static final Set<String> RECORD_TYPES = Set.of("shipment");

    public QueryMesShipmentsTool(
            ObjectMapper objectMapper,
            IndustrialDemoRepository repository
    ) {
        super(
                objectMapper,
                repository,
                readManifest(
                        "iris.industry.mes.shipments",
                        "query_mes_shipments",
                        "查询 MES 域的成品发运记录（方向、车位、包数、关联需求）；核对交付与发运进度时使用，不包含库存台账（见 query_mes_finished_goods_inventory_movements）",
                        processInputSchema(
                                objectMapper,
                                RECORD_TYPES,
                                "记录类型：shipment=发运",
                                "发货月台编码，精确匹配"
                        ),
                        IndustrialToolSchemas.output(objectMapper)
                ),
                "warehouse",
                "warehouse_shipments",
                RECORD_TYPES
        );
    }
}
