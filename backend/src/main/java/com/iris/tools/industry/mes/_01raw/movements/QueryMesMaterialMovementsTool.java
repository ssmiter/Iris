package com.iris.tools.industry.mes._01raw.movements;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.node.ObjectNode;
import com.iris.industry.demo.IndustrialDemoRepository;
import com.iris.tools.industry.IndustrialToolSchemas;
import com.iris.tools.industry.mes.AbstractMesReadTool;
import org.springframework.stereotype.Component;

import java.util.Set;

@Component
public class QueryMesMaterialMovementsTool extends AbstractMesReadTool {
    private static final Set<String> MOVEMENT_TYPES = Set.of(
            "receipt",
            "issue",
            "return"
    );

    public QueryMesMaterialMovementsTool(
            ObjectMapper objectMapper,
            IndustrialDemoRepository repository
    ) {
        super(
                objectMapper,
                repository,
                readManifest(
                        "iris.industry.mes.material_movements",
                        "query_mes_material_movements",
                        "查询 MES 域的原料入库、领出与退回流转及关联单号，附收发退汇总；核对原料去向或批次用料时使用，不包含实时库存（见 query_mes_material_inventory）",
                        inputSchema(objectMapper),
                        IndustrialToolSchemas.output(objectMapper)
                )
        );
    }

    @Override
    protected String view() {
        return "material_movements";
    }

    @Override
    protected ObjectNode normalize(JsonNode input) {
        ObjectNode normalized = normalizedBase(input);
        copyDate(input, normalized, "start_date");
        copyDate(input, normalized, "end_date");
        requireDateOrder(normalized);
        copyText(input, normalized, "material", 40);
        copyEnum(input, normalized, "movement_type", MOVEMENT_TYPES);
        copyText(input, normalized, "warehouse_code", 40);
        copyText(input, normalized, "related_no", 60);
        return normalized;
    }

    @Override
    protected ObjectNode query(ObjectNode normalized) {
        return repository.materialMovements(domain(), normalized);
    }

    private static ObjectNode inputSchema(ObjectMapper mapper) {
        ObjectNode schema = IndustrialToolSchemas.input(mapper);
        IndustrialToolSchemas.string(
                schema,
                "start_date",
                "流转开始日期 YYYY-MM-DD；不传则不设下界"
        );
        IndustrialToolSchemas.string(
                schema,
                "end_date",
                "流转结束日期 YYYY-MM-DD；不传则不设上界"
        );
        IndustrialToolSchemas.string(
                schema,
                "material",
                "原料编码或名称片段"
        );
        IndustrialToolSchemas.stringEnum(
                schema,
                "movement_type",
                "流转类型；不传则返回全部",
                MOVEMENT_TYPES.stream().sorted().toList()
        );
        IndustrialToolSchemas.string(
                schema,
                "warehouse_code",
                "仓库编码，精确匹配"
        );
        IndustrialToolSchemas.string(
                schema,
                "related_no",
                "关联单号（采购单、批次号等），精确匹配"
        );
        return schema;
    }
}
