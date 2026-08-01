package com.iris.tools.industry.mes;

import com.fasterxml.jackson.databind.ObjectMapper;
import com.iris.industry.demo.IndustrialDemoRepository;
import com.iris.tools.core.ToolManifest;
import com.iris.tools.industry.AbstractIndustrialReferenceQueryTool;

import java.util.Set;

/**
 * MES 域版本化业务对象查询骨架：固定 domain=mes，逻辑见
 * {@link AbstractIndustrialReferenceQueryTool}。
 */
public abstract class AbstractMesReferenceQueryTool
        extends AbstractIndustrialReferenceQueryTool {

    protected AbstractMesReferenceQueryTool(
            ObjectMapper objectMapper,
            IndustrialDemoRepository repository,
            ToolManifest manifest,
            String objectType,
            String view
    ) {
        super(objectMapper, repository, manifest, objectType, view);
    }

    protected AbstractMesReferenceQueryTool(
            ObjectMapper objectMapper,
            IndustrialDemoRepository repository,
            ToolManifest manifest,
            Set<String> objectTypes,
            String view
    ) {
        super(objectMapper, repository, manifest, objectTypes, view);
    }

    @Override
    protected final String domain() {
        return "mes";
    }
}
