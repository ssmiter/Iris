package com.iris.tools.core;

import com.fasterxml.jackson.databind.JsonNode;

/**
 * 工具清单。searchHint 为可选的发现辅助短语（3-10 个与工具名正交的
 * 同义/领域词，docs/42 §4 P0）：目录浏览覆盖「我知道去哪找」，
 * searchHint 覆盖「我只知道要干什么」；未声明为 null。
 */
public record ToolManifest(
        String id,
        String version,
        String name,
        String description,
        JsonNode inputSchema,
        JsonNode outputSchema,
        RiskLevel riskLevel,
        SideEffect sideEffect,
        int timeoutSeconds,
        int resultCharacterLimit,
        IdempotencySemantics idempotency,
        EvidencePolicy evidencePolicy,
        ContextRetention contextRetention,
        ConcurrencySemantics concurrency,
        CancellationSemantics cancellation,
        String searchHint
) {
    public ToolManifest {
        searchHint = searchHint == null || searchHint.isBlank()
                ? null
                : searchHint.trim();
    }

    /** 未声明 searchHint 的全量构造器；存量工具沿用，等价于 searchHint = null。 */
    public ToolManifest(
            String id,
            String version,
            String name,
            String description,
            JsonNode inputSchema,
            JsonNode outputSchema,
            RiskLevel riskLevel,
            SideEffect sideEffect,
            int timeoutSeconds,
            int resultCharacterLimit,
            IdempotencySemantics idempotency,
            EvidencePolicy evidencePolicy,
            ContextRetention contextRetention,
            ConcurrencySemantics concurrency,
            CancellationSemantics cancellation
    ) {
        this(
                id,
                version,
                name,
                description,
                inputSchema,
                outputSchema,
                riskLevel,
                sideEffect,
                timeoutSeconds,
                resultCharacterLimit,
                idempotency,
                evidencePolicy,
                contextRetention,
                concurrency,
                cancellation,
                null
        );
    }

    public ToolManifest(
            String id,
            String version,
            String name,
            String description,
            JsonNode inputSchema,
            JsonNode outputSchema,
            RiskLevel riskLevel,
            SideEffect sideEffect,
            int timeoutSeconds,
            int resultCharacterLimit,
            IdempotencySemantics idempotency,
            EvidencePolicy evidencePolicy
    ) {
        this(
                id,
                version,
                name,
                description,
                inputSchema,
                outputSchema,
                riskLevel,
                sideEffect,
                timeoutSeconds,
                resultCharacterLimit,
                idempotency,
                evidencePolicy,
                ContextRetention.PINNED,
                ConcurrencySemantics.SERIAL,
                sideEffect == SideEffect.NONE
                        ? CancellationSemantics.COOPERATIVE
                        : CancellationSemantics.COMMIT_BOUNDARY
        );
    }

    /** 同上便捷形，附带 searchHint 声明。 */
    public ToolManifest(
            String id,
            String version,
            String name,
            String description,
            JsonNode inputSchema,
            JsonNode outputSchema,
            RiskLevel riskLevel,
            SideEffect sideEffect,
            int timeoutSeconds,
            int resultCharacterLimit,
            IdempotencySemantics idempotency,
            EvidencePolicy evidencePolicy,
            String searchHint
    ) {
        this(
                id,
                version,
                name,
                description,
                inputSchema,
                outputSchema,
                riskLevel,
                sideEffect,
                timeoutSeconds,
                resultCharacterLimit,
                idempotency,
                evidencePolicy,
                ContextRetention.PINNED,
                ConcurrencySemantics.SERIAL,
                sideEffect == SideEffect.NONE
                        ? CancellationSemantics.COOPERATIVE
                        : CancellationSemantics.COMMIT_BOUNDARY,
                searchHint
        );
    }

    public ToolManifest(
            String id,
            String version,
            String name,
            String description,
            JsonNode inputSchema,
            JsonNode outputSchema,
            RiskLevel riskLevel,
            SideEffect sideEffect,
            int timeoutSeconds,
            int resultCharacterLimit,
            IdempotencySemantics idempotency,
            EvidencePolicy evidencePolicy,
            ContextRetention contextRetention
    ) {
        this(
                id,
                version,
                name,
                description,
                inputSchema,
                outputSchema,
                riskLevel,
                sideEffect,
                timeoutSeconds,
                resultCharacterLimit,
                idempotency,
                evidencePolicy,
                contextRetention,
                ConcurrencySemantics.SERIAL,
                sideEffect == SideEffect.NONE
                        ? CancellationSemantics.COOPERATIVE
                        : CancellationSemantics.COMMIT_BOUNDARY
        );
    }

    public enum SideEffect {
        NONE,
        /** Iris 私有控制平面中的版本化状态，不改变用户工作区或外部系统。 */
        INTERNAL_STATE,
        WORKSPACE_WRITE,
        EXTERNAL_WRITE,
        DESTRUCTIVE
    }

    public enum IdempotencySemantics {
        IDEMPOTENT,
        IDEMPOTENT_WITH_KEY,
        NON_IDEMPOTENT
    }

    public enum EvidencePolicy {
        NONE,
        SUMMARY,
        REQUIRED
    }

    public enum ContextRetention {
        /** Observation 不可自动替换为引用。 */
        PINNED,
        /** 完整 payload 可通过稳定 executionId 无损读回。 */
        REFETCHABLE
    }

    public enum ConcurrencySemantics {
        /** 与前后 ToolCall 形成顺序屏障。 */
        SERIAL,
        /** 可与同一连续批次中的其他 parallel-safe 只读调用并行。 */
        PARALLEL_SAFE
    }

    public enum CancellationSemantics {
        /** 执行期间周期读取实时取消信号并安全停止。 */
        COOPERATIVE,
        /** 只在副作用提交边界前取消，提交后必须 verify/reconcile。 */
        COMMIT_BOUNDARY
    }
}
