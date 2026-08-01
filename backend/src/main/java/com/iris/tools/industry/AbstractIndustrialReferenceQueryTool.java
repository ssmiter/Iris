package com.iris.tools.industry;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.node.ObjectNode;
import com.iris.industry.demo.IndustrialDemoRepository;
import com.iris.tools.core.ToolManifest;

import java.util.Set;

/**
 * 配方、标准、班组等版本化业务对象共享的只读查询骨架（域无关）。
 *
 * <p>一个工具可固定一组 object type（如工厂日历 + 班次模板），
 * 模型不能借此选择任意对象类型。</p>
 */
public abstract class AbstractIndustrialReferenceQueryTool
        extends AbstractIndustrialReadTool {
    private final Set<String> objectTypes;
    private final String view;

    protected AbstractIndustrialReferenceQueryTool(
            ObjectMapper objectMapper,
            IndustrialDemoRepository repository,
            ToolManifest manifest,
            String objectType,
            String view
    ) {
        this(objectMapper, repository, manifest, Set.of(objectType), view);
    }

    protected AbstractIndustrialReferenceQueryTool(
            ObjectMapper objectMapper,
            IndustrialDemoRepository repository,
            ToolManifest manifest,
            Set<String> objectTypes,
            String view
    ) {
        super(objectMapper, repository, manifest);
        this.objectTypes = Set.copyOf(objectTypes);
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
                objectTypes,
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
