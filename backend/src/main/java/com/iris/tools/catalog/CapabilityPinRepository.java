package com.iris.tools.catalog;

import org.springframework.jdbc.core.simple.JdbcClient;
import org.springframework.stereotype.Repository;

import java.time.Instant;
import java.util.List;

/**
 * 能力收藏持久化（docs/37 §2.4）：SQLite 单表，按 ordinal 升序。
 */
@Repository
public class CapabilityPinRepository {

    private final JdbcClient jdbc;

    public CapabilityPinRepository(JdbcClient jdbc) {
        this.jdbc = jdbc;
    }

    public List<Pin> list() {
        return jdbc.sql("""
                        SELECT path, ordinal FROM capability_pin
                        ORDER BY ordinal ASC
                        """)
                .query((rs, rowNum) -> new Pin(
                        rs.getString("path"),
                        rs.getInt("ordinal")
                ))
                .list();
    }

    public void replaceAll(List<String> paths, Instant now) {
        jdbc.sql("DELETE FROM capability_pin").update();
        for (int ordinal = 0; ordinal < paths.size(); ordinal++) {
            jdbc.sql("""
                            INSERT INTO capability_pin(path, ordinal, created_at)
                            VALUES (:path, :ordinal, :createdAt)
                            """)
                    .param("path", paths.get(ordinal))
                    .param("ordinal", ordinal)
                    .param("createdAt", now.toString())
                    .update();
        }
    }

    public record Pin(String path, int ordinal) {
    }
}
