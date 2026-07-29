package com.iris.tools.industry.mes._01raw.inventory;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.node.ObjectNode;
import com.iris.industry.demo.IndustrialDemoRepository;
import com.iris.tools.industry.IndustrialToolSchemas;
import com.iris.tools.industry.mes.AbstractMesReadTool;
import org.springframework.stereotype.Component;

@Component
public class QueryMesMaterialInventoryTool extends AbstractMesReadTool {

    public QueryMesMaterialInventoryTool(
            ObjectMapper objectMapper,
            IndustrialDemoRepository repository
    ) {
        super(
                objectMapper,
                repository,
                readManifest(
                        "iris.industry.mes.material_inventory",
                        "query_mes_material_inventory",
                        "查询脱敏模拟 MES 的原材料可用量、预留量与安全库存；排查缺料或库存风险时使用",
                        inputSchema(objectMapper),
                        IndustrialToolSchemas.output(objectMapper)
                )
        );
    }

    @Override
    protected String view() {
        return "material_inventory";
    }

    @Override
    protected ObjectNode normalize(JsonNode input) {
        ObjectNode normalized = normalizedBase(input);
        copyText(input, normalized, "material", 80);
        copyText(input, normalized, "warehouse_code", 40);
        normalized.put(
                "below_safety_stock",
                input.path("below_safety_stock").asBoolean(false)
        );
        return normalized;
    }

    @Override
    protected ObjectNode query(ObjectNode normalized) {
        return repository.materialInventory(domain(), normalized);
    }

    private static ObjectNode inputSchema(ObjectMapper mapper) {
        ObjectNode schema = IndustrialToolSchemas.input(mapper);
        IndustrialToolSchemas.string(
                schema,
                "material",
                "物料编码或名称片段；不传则不过滤"
        );
        IndustrialToolSchemas.string(
                schema,
                "warehouse_code",
                "仓库编码，精确匹配；不传则查询全部仓库"
        );
        IndustrialToolSchemas.bool(
                schema,
                "below_safety_stock",
                "是否只返回可用量低于安全库存的物料；默认 false"
        );
        return schema;
    }
}
