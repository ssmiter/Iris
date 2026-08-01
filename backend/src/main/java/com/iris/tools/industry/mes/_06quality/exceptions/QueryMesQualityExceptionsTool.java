package com.iris.tools.industry.mes._06quality.exceptions;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.node.ObjectNode;
import com.iris.industry.demo.IndustrialDemoRepository;
import com.iris.tools.industry.IndustrialToolSchemas;
import com.iris.tools.industry.mes.AbstractMesReadTool;
import org.springframework.stereotype.Component;

import java.util.Set;

@Component
public class QueryMesQualityExceptionsTool extends AbstractMesReadTool {
    private static final Set<String> STATUSES = Set.of(
            "open",
            "disposed",
            "closed"
    );
    private static final Set<String> DISPOSITIONS = Set.of(
            "none",
            "rework",
            "concession",
            "scrap"
    );

    public QueryMesQualityExceptionsTool(
            ObjectMapper objectMapper,
            IndustrialDemoRepository repository
    ) {
        super(
                objectMapper,
                repository,
                readManifest(
                        "iris.industry.mes.quality_exceptions",
                        "query_mes_quality_exceptions",
                        "查询 MES 域的质量异常台账（缺陷类别、影响数量、处置状态、乐观锁版本），附 open/disposed 合计；排查未闭环异常时使用，处置前必须先查本视图取 version 传给 dispose_mes_quality_exception",
                        inputSchema(objectMapper),
                        IndustrialToolSchemas.output(objectMapper)
                )
        );
    }

    @Override
    protected String view() {
        return "quality_exceptions";
    }

    @Override
    protected ObjectNode normalize(JsonNode input) {
        ObjectNode normalized = normalizedBase(input);
        copyText(input, normalized, "item", 80);
        copyEnum(input, normalized, "status", STATUSES);
        copyEnum(input, normalized, "disposition", DISPOSITIONS);
        return normalized;
    }

    @Override
    protected ObjectNode query(ObjectNode normalized) {
        return repository.qualityExceptions(domain(), normalized);
    }

    private static ObjectNode inputSchema(ObjectMapper mapper) {
        ObjectNode schema = IndustrialToolSchemas.input(mapper);
        IndustrialToolSchemas.string(
                schema,
                "item",
                "物料或制品编码、名称片段"
        );
        IndustrialToolSchemas.stringEnum(
                schema,
                "status",
                "闭环状态：open=待处置，disposed=已处置，closed=已关闭；不传则返回全部",
                STATUSES.stream().sorted().toList()
        );
        IndustrialToolSchemas.stringEnum(
                schema,
                "disposition",
                "处置方式；none 表示尚未处置；不传则返回全部",
                DISPOSITIONS.stream().sorted().toList()
        );
        return schema;
    }
}
