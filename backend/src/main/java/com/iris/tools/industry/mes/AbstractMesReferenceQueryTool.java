package com.iris.tools.industry.mes;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.node.ObjectNode;
import com.iris.industry.demo.IndustrialDemoRepository;
import com.iris.tools.core.ToolManifest;
import com.iris.tools.industry.IndustrialToolSchemas;

/**
 * 配方、模具等版本化业务对象共享的只读查询骨架。
 */
public abstract class AbstractMesReferenceQueryTool
        extends AbstractMesReadTool {
    private final String objectType;
    private final String view;

    protected AbstractMesReferenceQueryTool(
            ObjectMapper objectMapper,
            IndustrialDemoRepository repository,
            ToolManifest manifest,
            String objectType,
            String view
    ) {
        super(objectMapper, repository, manifest);
        this.objectType = objectType;
        this.view = view;
    }

    @Override
    protected final String view() {
        return view;
    }

    @Override
    protected final ObjectNode normalize(JsonNode input) {
        ObjectNode normalized = normalizedBase(input);
        copyText(input, normalized, "query", 80);
        copyText(input, normalized, "process_code", 40);
        copyText(input, normalized, "status", 40);
        return normalized;
    }

    @Override
    protected final ObjectNode query(ObjectNode normalized) {
        return repository.referenceObjects(
                domain(),
                objectType,
                view,
                normalized
        );
    }

    protected static ObjectNode referenceInputSchema(
            ObjectMapper mapper,
            String objectDescription
    ) {
        ObjectNode schema = IndustrialToolSchemas.input(mapper);
        IndustrialToolSchemas.string(
                schema,
                "query",
                objectDescription + "编码或名称片段"
        );
        IndustrialToolSchemas.string(
                schema,
                "process_code",
                "适用工序编码，精确匹配"
        );
        IndustrialToolSchemas.string(
                schema,
                "status",
                "对象状态，精确匹配；先不传可观察当前状态值"
        );
        return schema;
    }
}
