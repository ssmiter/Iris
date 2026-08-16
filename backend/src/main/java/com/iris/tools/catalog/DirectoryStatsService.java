package com.iris.tools.catalog;

import org.springframework.jdbc.core.simple.JdbcClient;
import org.springframework.stereotype.Component;

import java.time.Clock;
import java.time.Duration;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

/**
 * 目录统计口径的实时计算（docs/31 §2.2）：值永不手写进文件，
 * `_directory.yml` 只声明暴露哪些口径，这里按 tool_execution 实绩算。
 *
 * <p>p50 口径说明：tool_execution 只有 created/updated 两个时间戳，
 * 耗时是"入闸到出结果"的墙钟差，包含审批等待——作为导航信号足够，
 * 不作为性能审计依据。</p>
 */
@Component
public class DirectoryStatsService {

    private static final Duration WINDOW = Duration.ofDays(7);
    private static final int DURATION_SAMPLE_LIMIT = 5_000;

    private final JdbcClient jdbc;
    private final Clock clock = Clock.systemUTC();

    public DirectoryStatsService(JdbcClient jdbc) {
        this.jdbc = jdbc;
    }

    /**
     * 按声明的口径实时计算；无样本的口径缺省不返回（0 样本不是 0 值）。
     */
    public Map<String, Object> stats(
            String directoryPath,
            int toolCount,
            List<String> expose
    ) {
        Map<String, Object> result = new LinkedHashMap<>();
        for (String metric : expose) {
            switch (metric) {
                case "tool_count" -> result.put("tool_count", toolCount);
                case "success_rate_7d" -> successRate(directoryPath)
                        .ifPresent(value ->
                                result.put("success_rate_7d", value));
                case "p50_ms_7d" -> p50Ms(directoryPath)
                        .ifPresent(value -> result.put("p50_ms_7d", value));
                default -> {
                    // 未知口径静默跳过：清单校验层已提示，运行期不炸列表
                }
            }
        }
        return result;
    }

    private java.util.Optional<Double> successRate(String directoryPath) {
        var row = jdbc.sql("""
                SELECT COUNT(*) AS total,
                       COALESCE(SUM(CASE WHEN phase = 'succeeded'
                                    THEN 1 ELSE 0 END), 0) AS ok
                FROM tool_execution
                WHERE capability_path GLOB :pattern
                  AND created_at >= :since
                """)
                .param("pattern", directoryPath + "/*")
                .param("since", clock.instant().minus(WINDOW).toString())
                .query((rs, n) -> new long[]{
                        rs.getLong("total"), rs.getLong("ok")
                })
                .single();
        if (row[0] == 0) {
            return java.util.Optional.empty();
        }
        double rate = (double) row[1] / (double) row[0];
        return java.util.Optional.of(Math.round(rate * 1000.0) / 1000.0);
    }

    private java.util.Optional<Long> p50Ms(String directoryPath) {
        List<Double> samples = new ArrayList<>(jdbc.sql("""
                SELECT (julianday(updated_at) - julianday(created_at))
                       * 86400000.0 AS ms
                FROM tool_execution
                WHERE capability_path GLOB :pattern
                  AND phase = 'succeeded'
                  AND created_at >= :since
                ORDER BY ms
                LIMIT :limit
                """)
                .param("pattern", directoryPath + "/*")
                .param("since", clock.instant().minus(WINDOW).toString())
                .param("limit", DURATION_SAMPLE_LIMIT)
                .query(Double.class)
                .list());
        if (samples.isEmpty()) {
            return java.util.Optional.empty();
        }
        int middle = samples.size() / 2;
        double median = samples.size() % 2 == 1
                ? samples.get(middle)
                : (samples.get(middle - 1) + samples.get(middle)) / 2.0;
        return java.util.Optional.of(Math.round(median));
    }
}
