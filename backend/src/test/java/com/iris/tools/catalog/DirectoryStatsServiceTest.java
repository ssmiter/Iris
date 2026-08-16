package com.iris.tools.catalog;

import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;
import org.springframework.jdbc.core.simple.JdbcClient;
import org.springframework.jdbc.datasource.SingleConnectionDataSource;

import java.nio.file.Path;
import java.time.Instant;
import java.time.temporal.ChronoUnit;
import java.util.List;
import java.util.Map;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;

/**
 * 目录统计口径（docs/31 §2.2）：真实 SQLite 上验证 success_rate_7d 与
 * p50_ms_7d 的窗口、GLOB 边界、零样本缺省与未知口径跳过。
 */
class DirectoryStatsServiceTest {

    @TempDir
    Path tempDir;

    @Test
    void computesWindowedRateAndMedianWithinDirectoryBoundary()
            throws Exception {
        try (SingleConnectionDataSource dataSource = dataSource()) {
            DirectoryStatsService service = service(dataSource);
            Instant now = Instant.now();
            // 窗口内：/industry/mes 下 3 条，2 成功（1200ms / 3400ms）1 失败
            insert(dataSource, "/industry/mes/a", "succeeded",
                    now.minus(1, ChronoUnit.DAYS), 1_200);
            insert(dataSource, "/industry/mes/b", "failed", now, 500);
            insert(dataSource, "/industry/mes/c", "succeeded", now, 3_400);
            // 相邻目录与窗口外样本不得混入
            insert(dataSource, "/industry/mens/x", "succeeded", now, 9_999);
            insert(dataSource, "/industry/mes/old", "succeeded",
                    now.minus(10, ChronoUnit.DAYS), 100);

            Map<String, Object> stats = service.stats(
                    "/industry/mes",
                    43,
                    List.of("tool_count", "success_rate_7d", "p50_ms_7d")
            );

            assertEquals(43, stats.get("tool_count"));
            assertEquals(0.667,
                    (Double) stats.get("success_rate_7d"), 0.0005);
            // p50 只取成功样本：中位数 = (1200 + 3400) / 2
            assertEquals(2_300L, stats.get("p50_ms_7d"));
        }
    }

    @Test
    void zeroSampleMetricsAreOmittedAndUnknownMetricsSkipped()
            throws Exception {
        try (SingleConnectionDataSource dataSource = dataSource()) {
            DirectoryStatsService service = service(dataSource);

            Map<String, Object> stats = service.stats(
                    "/empty/dir",
                    0,
                    List.of("tool_count", "success_rate_7d", "p50_ms_7d",
                            "not_a_metric")
            );

            assertEquals(Map.of("tool_count", 0), stats);
            assertFalse(stats.containsKey("success_rate_7d"));
            assertFalse(stats.containsKey("p50_ms_7d"));
        }
    }

    private SingleConnectionDataSource dataSource() {
        return new SingleConnectionDataSource(
                "jdbc:sqlite:" + tempDir.resolve("stats.db").toAbsolutePath(),
                true
        );
    }

    private DirectoryStatsService service(
            SingleConnectionDataSource dataSource
    ) {
        JdbcClient jdbc = JdbcClient.create(dataSource);
        jdbc.sql("""
                CREATE TABLE tool_execution(
                    capability_path TEXT,
                    phase TEXT,
                    created_at TEXT,
                    updated_at TEXT
                )
                """).update();
        return new DirectoryStatsService(jdbc);
    }

    private void insert(
            SingleConnectionDataSource dataSource,
            String capabilityPath,
            String phase,
            Instant created,
            long durationMs
    ) {
        // 与生产写入同构：Instant.toString()（毫秒位数可变，
        // julianday 必须都能解析）
        JdbcClient.create(dataSource)
                .sql("INSERT INTO tool_execution("
                        + "capability_path, phase, created_at, updated_at)"
                        + " VALUES (?,?,?,?)")
                .params(
                        capabilityPath,
                        phase,
                        created.toString(),
                        created.plusMillis(durationMs).toString()
                )
                .update();
    }
}
