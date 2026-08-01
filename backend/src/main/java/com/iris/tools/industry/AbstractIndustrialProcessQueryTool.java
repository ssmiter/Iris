package com.iris.tools.industry;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.node.ObjectNode;
import com.iris.industry.demo.IndustrialDemoRepository;
import com.iris.tools.core.ToolManifest;

import java.util.Set;

/**
 * 计划、实绩、库存和异常等工序记录共享的查询契约（域无关）。
 *
 * <p>具体 Tool 固定 process 和允许的 record type，模型不能借此选择任意表或视图。</p>
 */
public abstract class AbstractIndustrialProcessQueryTool
        extends AbstractIndustrialReadTool {
    private final String process;
    private final String view;
    private final Set<String> recordTypes;

    protected AbstractIndustrialProcessQueryTool(
            ObjectMapper objectMapper,
            IndustrialDemoRepository repository,
            ToolManifest manifest,
            String process,
            String view,
            Set<String> recordTypes
    ) {
        super(objectMapper, repository, manifest);
        this.process = process;
        this.view = view;
        this.recordTypes = Set.copyOf(recordTypes);
    }

    @Override
    protected final String view() {
        return view;
    }

    @Override
    protected final ObjectNode normalize(JsonNode input) {
        ObjectNode normalized = normalizedBase(input);
        copyEnum(input, normalized, "record_type", recordTypes);
        copyDate(input, normalized, "start_date");
        copyDate(input, normalized, "end_date");
        requireDateOrder(normalized);
        copyText(input, normalized, "item", 80);
        copyText(input, normalized, "resource_code", 40);
        copyText(input, normalized, "status", 40);
        return normalized;
    }

    @Override
    protected final ObjectNode query(ObjectNode normalized) {
        return repository.processRecords(
                domain(),
                process,
                view,
                normalized
        );
    }

    protected static ObjectNode processInputSchema(
            ObjectMapper mapper,
            Set<String> recordTypes,
            String recordTypeDescription,
            String resourceDescription
    ) {
        ObjectNode schema = IndustrialToolSchemas.input(mapper);
        IndustrialToolSchemas.stringEnum(
                schema,
                "record_type",
                recordTypeDescription + "；不传则返回全部类型",
                recordTypes.stream().sorted().toList()
        );
        IndustrialToolSchemas.string(
                schema,
                "start_date",
                "业务开始日期 YYYY-MM-DD；不传则不设下界"
        );
        IndustrialToolSchemas.string(
                schema,
                "end_date",
                "业务结束日期 YYYY-MM-DD；不传则不设上界"
        );
        IndustrialToolSchemas.string(
                schema,
                "item",
                "物料或制品编码、名称片段"
        );
        IndustrialToolSchemas.string(
                schema,
                "resource_code",
                resourceDescription
        );
        IndustrialToolSchemas.string(
                schema,
                "status",
                "业务状态，精确匹配；先不传可观察当前数据中的状态值"
        );
        return schema;
    }
}
