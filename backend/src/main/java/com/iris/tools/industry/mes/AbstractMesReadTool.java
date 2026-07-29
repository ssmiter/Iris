package com.iris.tools.industry.mes;

import com.fasterxml.jackson.databind.ObjectMapper;
import com.iris.industry.demo.IndustrialDemoRepository;
import com.iris.tools.core.ToolManifest;
import com.iris.tools.industry.AbstractIndustrialReadTool;

/**
 * 单一通用 MES 样例域。未来域授权只需改变 Catalog/Runtime 可见性，
 * 领域工具不感知登录态。
 */
public abstract class AbstractMesReadTool
        extends AbstractIndustrialReadTool {

    protected AbstractMesReadTool(
            ObjectMapper objectMapper,
            IndustrialDemoRepository repository,
            ToolManifest manifest
    ) {
        super(objectMapper, repository, manifest);
    }

    @Override
    protected final String domain() {
        return "mes";
    }
}
