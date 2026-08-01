package com.iris.tools.industry.mes._08trace.genealogy;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.node.ObjectNode;
import com.iris.industry.demo.IndustrialDemoRepository;
import com.iris.tools.industry.IndustrialToolSchemas;
import com.iris.tools.industry.mes.AbstractMesReadTool;
import org.springframework.stereotype.Component;

@Component
public class QueryMesBatchTraceTool extends AbstractMesReadTool {

    public QueryMesBatchTraceTool(
            ObjectMapper objectMapper,
            IndustrialDemoRepository repository
    ) {
        super(
                objectMapper,
                repository,
                readManifest(
                        "iris.industry.mes.batch_trace",
                        "query_mes_batch_trace",
                        "追溯 MES 域批次全生命周期：按批号或物料跨表串出 计划→批次→投料→快检→半制品→成型→硫化→仓储 各段记录（每段一行、带阶段标记）；质量追溯与去向排查时使用",
                        inputSchema(objectMapper),
                        IndustrialToolSchemas.output(objectMapper)
                )
        );
    }

    @Override
    protected String view() {
        return "batch_trace";
    }

    @Override
    protected ObjectNode normalize(JsonNode input) {
        ObjectNode normalized = normalizedBase(input);
        copyText(input, normalized, "batch_no", 60);
        copyText(input, normalized, "item", 80);
        if (normalized.path("batch_no").asText().isBlank()
                && normalized.path("item").asText().isBlank()) {
            throw invalid("batch_no 与 item 至少提供一个");
        }
        return normalized;
    }

    @Override
    protected ObjectNode query(ObjectNode normalized) {
        return repository.batchTrace(domain(), normalized);
    }

    @Override
    protected String impact(ObjectNode normalized) {
        return "跨表追溯 " + domain() + " 域批次谱系（按 "
                + (normalized.path("batch_no").asText().isBlank()
                        ? "物料"
                        : "批号")
                + "），不改变任何业务状态";
    }

    private static ObjectNode inputSchema(ObjectMapper mapper) {
        ObjectNode schema = IndustrialToolSchemas.input(mapper);
        IndustrialToolSchemas.string(
                schema,
                "batch_no",
                "批次号片段；与 item 至少提供一个，优先按批号追溯"
        );
        IndustrialToolSchemas.string(
                schema,
                "item",
                "物料或制品编码、名称片段；按物料列出相关批次与下游记录"
        );
        return schema;
    }
}
