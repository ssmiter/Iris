package com.iris.agent.model;

import com.fasterxml.jackson.databind.ObjectMapper;
import com.iris.agent.model.ModelAttemptRepository.AttemptRow;
import com.iris.agent.model.provider.ModelProvider;
import com.iris.conversation.domain.ConversationViews.RoundView;
import com.iris.conversation.infrastructure.ConversationQueryRepository;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.jdbc.core.simple.JdbcClient;
import org.springframework.test.context.DynamicPropertyRegistry;
import org.springframework.test.context.DynamicPropertySource;
import reactor.core.publisher.Flux;

import java.io.IOException;
import java.nio.file.Files;
import java.nio.file.Path;
import java.time.Duration;
import java.time.Instant;
import java.util.List;
import java.util.Map;

import static org.assertj.core.api.Assertions.assertThat;

/**
 * docs/42 §5.2/§5.3：请求 header 完整快照逐 attempt 落库（sameAsPrevious
 * 只标记不省行、hash 变化可区分），Round 投影聚合缓存 token 并逐步骤暴露。
 */
@SpringBootTest
class ModelRequestSnapshotIntegrationTest {
    private static final Path DATABASE = Path.of(
            "target",
            "test-data",
            "model-request-snapshot.db"
    ).toAbsolutePath();
    private static final Path WORKSPACE = Path.of(
            "target",
            "test-workspace"
    ).toAbsolutePath();
    private static final String HASH_PLACEHOLDER =
            "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";

    @Autowired
    private JdbcClient jdbc;

    @Autowired
    private ObjectMapper objectMapper;

    @Autowired
    private ModelRequestSnapshotService snapshots;

    @Autowired
    private ConversationQueryRepository queries;

    @DynamicPropertySource
    static void testProperties(DynamicPropertyRegistry registry)
            throws IOException {
        Files.createDirectories(DATABASE.getParent());
        Files.deleteIfExists(DATABASE);
        Files.deleteIfExists(Path.of(DATABASE + "-wal"));
        Files.deleteIfExists(Path.of(DATABASE + "-shm"));
        Files.createDirectories(WORKSPACE);
        registry.add(
                "spring.datasource.url",
                () -> "jdbc:sqlite:" + DATABASE.toString().replace('\\', '/')
        );
        registry.add("iris.workspace", WORKSPACE::toString);
    }

    @Test
    void identicalHeaderMarksSameAsPreviousButStillInsertsRow() {
        String suffix = "same-" + Instant.now().toEpochMilli();
        seedParents(suffix);
        seedRound(suffix, 0);
        AttemptRow first = seedAttempt(suffix, 0);
        AttemptRow second = seedAttempt(suffix, 1);
        ModelProvider provider = provider("deepseek", "medium", 8192);

        snapshots.capture(provider, first, request(first.attemptId()));
        snapshots.capture(provider, second, request(second.attemptId()));

        String firstHash = snapshotHash(first.attemptId());
        String secondHash = snapshotHash(second.attemptId());
        assertThat(secondHash).isEqualTo(firstHash);
        assertThat(sameAsPrevious(first.attemptId())).isZero();
        assertThat(sameAsPrevious(second.attemptId())).isOne();
        // 完整快照语义：内容相同也照插一行
        assertThat(snapshotJson(second.attemptId())).isPresent();
    }

    @Test
    void configChangeProducesNewHashAndEffortLandsInSnapshot() {
        String suffix = "diff-" + Instant.now().toEpochMilli();
        seedParents(suffix);
        seedRound(suffix, 0);
        AttemptRow first = seedAttempt(suffix, 0);
        AttemptRow second = seedAttempt(suffix, 1);

        snapshots.capture(
                provider("deepseek", "medium", 8192),
                first,
                request(first.attemptId())
        );
        snapshots.capture(
                provider("deepseek", "high", 8192),
                second,
                request(second.attemptId())
        );

        assertThat(snapshotHash(second.attemptId()))
                .isNotEqualTo(snapshotHash(first.attemptId()));
        assertThat(sameAsPrevious(second.attemptId())).isZero();
        String json = snapshotJson(second.attemptId()).orElseThrow();
        assertThat(json).contains("\"effort\":\"high\"");
        assertThat(json).contains("\"maxOutputTokens\":8192");
        assertThat(json).contains("\"profileId\":\"deepseek\"");
        assertThat(json).contains("\"renderedSha256\":\"");
        assertThat(json).contains("\"read_file\"");
    }

    @Test
    void roundStatsExposeAggregatedCacheTokens() {
        String suffix = "usage-" + Instant.now().toEpochMilli();
        seedParents(suffix);
        seedRound(suffix, 0);
        seedRound(suffix, 1);
        AttemptRow first = seedAttempt(suffix, 0);
        AttemptRow second = seedAttempt(suffix, 1);
        insertUsage(first.attemptId(), 1000, 50, 800, 200);
        insertUsage(second.attemptId(), 2000, 80, 1500, 500);

        RoundView round = queries.roundView("round-" + suffix + "-0");
        assertThat(round.stats().inputTokens()).isEqualTo(3000);
        assertThat(round.stats().outputTokens()).isEqualTo(130);
        assertThat(round.stats().cacheReadTokens()).isEqualTo(2300);
        assertThat(round.stats().cacheMissTokens()).isEqualTo(700);

        RoundView empty = queries.roundView("round-" + suffix + "-1");
        assertThat(empty.stats().inputTokens()).isNull();
        assertThat(empty.stats().cacheReadTokens()).isNull();
        assertThat(empty.stats().cacheMissTokens()).isNull();
    }

    private ModelRequest request(String attemptId) {
        return new ModelRequest(
                attemptId,
                "conv-unused",
                "run-unused",
                "round-unused",
                "test-model",
                "你是 Iris，一个个人 AI 助手。",
                List.of(),
                List.of(new ModelRequest.ToolDefinition(
                        "read_file",
                        "读取工作区内文件内容",
                        objectMapper.createObjectNode(),
                        "manifest-hash"
                )),
                Map.of(
                        "promptDefinitionId", "iris.agentic.default",
                        "promptVersion", "3"
                )
        );
    }

    private ModelProvider provider(
            String profileId,
            String effort,
            int maxOutputTokens
    ) {
        return new ModelProvider() {
            @Override
            public String profileId() {
                return profileId;
            }

            @Override
            public String providerKind() {
                return "openai-compatible";
            }

            @Override
            public String modelId() {
                return "test-model";
            }

            @Override
            public String effort() {
                return effort;
            }

            @Override
            public int maxOutputTokens() {
                return maxOutputTokens;
            }

            @Override
            public Duration timeout() {
                return Duration.ofSeconds(30);
            }

            @Override
            public Flux<ModelStreamEvent> stream(ModelRequest request) {
                return Flux.empty();
            }
        };
    }

    private String snapshotHash(String attemptId) {
        return jdbc.sql("""
                SELECT snapshot_hash FROM model_request_snapshot
                WHERE attempt_id = :attemptId
                """)
                .param("attemptId", attemptId)
                .query(String.class)
                .single();
    }

    private int sameAsPrevious(String attemptId) {
        return jdbc.sql("""
                SELECT same_as_previous FROM model_request_snapshot
                WHERE attempt_id = :attemptId
                """)
                .param("attemptId", attemptId)
                .query(Integer.class)
                .single();
    }

    private java.util.Optional<String> snapshotJson(String attemptId) {
        return jdbc.sql("""
                SELECT snapshot_json FROM model_request_snapshot
                WHERE attempt_id = :attemptId
                """)
                .param("attemptId", attemptId)
                .query(String.class)
                .optional();
    }

    private void seedParents(String suffix) {
        String now = Instant.now().toString();
        jdbc.sql("""
                INSERT INTO iris_conversation(
                    conversation_id, root_branch_id, title, version,
                    created_at, updated_at
                ) VALUES (:convId, :branchId, 'snapshot test', 1, :now, :now)
                """)
                .param("convId", "conv-" + suffix)
                .param("branchId", "branch-" + suffix)
                .param("now", now)
                .update();
        jdbc.sql("""
                INSERT INTO conversation_branch(
                    branch_id, conversation_id, status, version, created_at
                ) VALUES (:branchId, :convId, 'active', 1, :now)
                """)
                .param("branchId", "branch-" + suffix)
                .param("convId", "conv-" + suffix)
                .param("now", now)
                .update();
        jdbc.sql("""
                INSERT INTO message(
                    message_id, conversation_id, branch_id, turn_id,
                    role, content, created_at
                ) VALUES (:msgId, :convId, :branchId, :turnId, 'user', '你好', :now)
                """)
                .param("msgId", "msg-" + suffix)
                .param("convId", "conv-" + suffix)
                .param("branchId", "branch-" + suffix)
                .param("turnId", "turn-" + suffix)
                .param("now", now)
                .update();
        jdbc.sql("""
                INSERT INTO conversation_turn(
                    turn_id, conversation_id, branch_id, request_message_id,
                    root_run_id, phase, version, started_at
                ) VALUES (:turnId, :convId, :branchId, :msgId, :runId, 'running', 1, :now)
                """)
                .param("turnId", "turn-" + suffix)
                .param("convId", "conv-" + suffix)
                .param("branchId", "branch-" + suffix)
                .param("msgId", "msg-" + suffix)
                .param("runId", "run-" + suffix)
                .param("now", now)
                .update();
        jdbc.sql("""
                INSERT INTO agent_run(
                    run_id, conversation_id, branch_id, turn_id,
                    parent_run_id, root_run_id, kind, purpose, phase,
                    version, started_at
                ) VALUES (
                    :runId, :convId, :branchId, :turnId, NULL, :runId,
                    'agentic', '快照测试', 'running', 1, :now
                )
                """)
                .param("runId", "run-" + suffix)
                .param("convId", "conv-" + suffix)
                .param("branchId", "branch-" + suffix)
                .param("turnId", "turn-" + suffix)
                .param("now", now)
                .update();
    }

    private void seedRound(String suffix, int roundIndex) {
        String now = Instant.now().toString();
        jdbc.sql("""
                INSERT INTO agent_round(
                    round_id, conversation_id, branch_id, turn_id, run_id,
                    round_index, phase, tool_call_count, duration_ms,
                    version, created_at, updated_at
                ) VALUES (
                    :roundId, :convId, :branchId, :turnId, :runId,
                    :roundIndex, 'model_streaming', 0, 0, 1, :now, :now
                )
                """)
                .param("roundId", "round-" + suffix + "-" + roundIndex)
                .param("convId", "conv-" + suffix)
                .param("branchId", "branch-" + suffix)
                .param("turnId", "turn-" + suffix)
                .param("runId", "run-" + suffix)
                .param("roundIndex", roundIndex)
                .param("now", now)
                .update();
    }

    private AttemptRow seedAttempt(String suffix, int attemptIndex) {
        String now = Instant.now().toString();
        String attemptId = "attempt-" + suffix + "-" + attemptIndex;
        String roundId = "round-" + suffix + "-0";
        jdbc.sql("""
                INSERT INTO model_attempt(
                    attempt_id, conversation_id, turn_id, run_id, round_id,
                    attempt_index, provider_profile, model_id, context_hash,
                    capability_lease_hash, phase, version, started_at
                ) VALUES (
                    :attemptId, :convId, :turnId, :runId, :roundId,
                    :attemptIndex, 'deepseek', 'test-model', :hash,
                    :hash, 'streaming', 1, :now
                )
                """)
                .param("attemptId", attemptId)
                .param("convId", "conv-" + suffix)
                .param("turnId", "turn-" + suffix)
                .param("runId", "run-" + suffix)
                .param("roundId", roundId)
                .param("attemptIndex", attemptIndex)
                .param("hash", HASH_PLACEHOLDER)
                .param("now", now)
                .update();
        return new AttemptRow(
                attemptId,
                "conv-" + suffix,
                "turn-" + suffix,
                "run-" + suffix,
                roundId,
                attemptIndex,
                "deepseek",
                "test-model",
                HASH_PLACEHOLDER,
                HASH_PLACEHOLDER,
                "streaming",
                1
        );
    }

    private void insertUsage(
            String attemptId,
            int inputTokens,
            int outputTokens,
            int cacheReadTokens,
            int cacheMissTokens
    ) {
        jdbc.sql("""
                INSERT INTO model_attempt_usage(
                    attempt_id, input_tokens, output_tokens,
                    cache_read_tokens, cache_miss_tokens,
                    reasoning_tokens, created_at
                ) VALUES (
                    :attemptId, :inputTokens, :outputTokens,
                    :cacheReadTokens, :cacheMissTokens, 0, :now
                )
                """)
                .param("attemptId", attemptId)
                .param("inputTokens", inputTokens)
                .param("outputTokens", outputTokens)
                .param("cacheReadTokens", cacheReadTokens)
                .param("cacheMissTokens", cacheMissTokens)
                .param("now", Instant.now().toString())
                .update();
    }
}
