package com.iris.tools.industry.mes;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.iris.industry.demo.IndustrialDemoRepository;
import com.iris.tools.core.RiskLevel;
import com.iris.tools.core.Tool;
import com.iris.tools.core.ToolContext;
import com.iris.tools.core.ToolManifest;
import com.iris.tools.core.ToolRuntimeException;

import java.time.Instant;
import java.util.Set;

/**
 * MES 域业务写工具骨架：完整四阶段契约（prepare 只校验与组装、
 * execute 重读校验 + 取消检查 + 乐观写、verify 独立重读）。
 *
 * <p>副作用落在业务库（EXTERNAL_WRITE），审批模式 required 时挂起；
 * 乐观并发由 SQL 守护条件承载——守护不通过返回 0 行时 Tool 抛业务冲突，
 * 业务规则（锁定、状态机、冲突策略）全部在 Tool 层判定。</p>
 */
public abstract class AbstractMesWriteTool implements Tool {
    protected final ObjectMapper objectMapper;
    protected final IndustrialDemoRepository repository;
    private final ToolManifest manifest;

    protected AbstractMesWriteTool(
            ObjectMapper objectMapper,
            IndustrialDemoRepository repository,
            ToolManifest manifest
    ) {
        this.objectMapper = objectMapper;
        this.repository = repository;
        this.manifest = manifest;
    }

    @Override
    public final ToolManifest manifest() {
        return manifest;
    }

    protected final String domain() {
        return "mes";
    }

    protected final String requireText(
            JsonNode input,
            String field,
            int maxCharacters
    ) {
        String value = input.path(field).asText().trim();
        if (value.isBlank()) {
            throw invalid(field + " 不能为空");
        }
        if (value.length() > maxCharacters) {
            throw invalid(field + " 过长");
        }
        return value;
    }

    protected final String requireEnum(
            JsonNode input,
            String field,
            Set<String> allowed
    ) {
        String value = input.path(field).asText().trim().toLowerCase();
        if (!allowed.contains(value)) {
            throw invalid(field + " 只允许 " + String.join(", ", allowed));
        }
        return value;
    }

    protected final String now() {
        return Instant.now().toString();
    }

    /** 提交前的业务校验失败：无副作用，可直接重试。 */
    protected final ToolRuntimeException invalid(String message) {
        return ToolRuntimeException.beforeCommit(
                "invalid_mes_write",
                message
        );
    }

    /** 乐观守护冲突：并发或状态漂移导致守护条件不通过。 */
    protected final ToolRuntimeException conflict(String message) {
        return ToolRuntimeException.beforeCommit(
                "mes_write_conflict",
                message
        );
    }

    protected final void checkCancelled(ToolContext context, String message) {
        if (context.cancelled()) {
            throw ToolRuntimeException.beforeCommit(
                    "cancelled_before_commit",
                    message
            );
        }
    }

    protected static ToolManifest writeManifest(
            String id,
            String name,
            String description,
            JsonNode inputSchema,
            JsonNode outputSchema
    ) {
        return writeManifest(
                id,
                name,
                description,
                inputSchema,
                outputSchema,
                ToolManifest.IdempotencySemantics.NON_IDEMPOTENT
        );
    }

    protected static ToolManifest writeManifest(
            String id,
            String name,
            String description,
            JsonNode inputSchema,
            JsonNode outputSchema,
            ToolManifest.IdempotencySemantics idempotency
    ) {
        return new ToolManifest(
                id,
                "1",
                name,
                description,
                inputSchema,
                outputSchema,
                RiskLevel.ELEVATED,
                ToolManifest.SideEffect.EXTERNAL_WRITE,
                30,
                8_000,
                idempotency,
                ToolManifest.EvidencePolicy.REQUIRED
        );
    }
}
