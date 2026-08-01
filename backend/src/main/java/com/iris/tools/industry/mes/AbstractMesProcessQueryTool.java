package com.iris.tools.industry.mes;

import com.fasterxml.jackson.databind.ObjectMapper;
import com.iris.industry.demo.IndustrialDemoRepository;
import com.iris.tools.core.ToolManifest;
import com.iris.tools.industry.AbstractIndustrialProcessQueryTool;

import java.util.Set;

/**
 * MES 域工序记录查询骨架：固定 domain=mes，逻辑见
 * {@link AbstractIndustrialProcessQueryTool}。
 */
public abstract class AbstractMesProcessQueryTool
        extends AbstractIndustrialProcessQueryTool {

    protected AbstractMesProcessQueryTool(
            ObjectMapper objectMapper,
            IndustrialDemoRepository repository,
            ToolManifest manifest,
            String process,
            String view,
            Set<String> recordTypes
    ) {
        super(objectMapper, repository, manifest, process, view, recordTypes);
    }

    @Override
    protected final String domain() {
        return "mes";
    }
}
