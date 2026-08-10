package com.iris.retrieval;

import org.springframework.jdbc.core.simple.JdbcClient;
import org.springframework.stereotype.Repository;

import java.nio.ByteBuffer;
import java.nio.ByteOrder;
import java.time.Instant;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

@Repository
public class SemanticVectorRepository {
    private final JdbcClient jdbc;

    public SemanticVectorRepository(JdbcClient jdbc) {
        this.jdbc = jdbc;
    }

    public Map<String, float[]> findAll(
            String modelIdentity,
            String normalizationVersion,
            List<String> hashes
    ) {
        if (hashes.isEmpty()) {
            return Map.of();
        }
        StringBuilder placeholders = new StringBuilder();
        for (int index = 0; index < hashes.size(); index++) {
            if (index > 0) {
                placeholders.append(',');
            }
            placeholders.append(":hash").append(index);
        }
        JdbcClient.StatementSpec query = jdbc.sql("""
                SELECT content_hash, dimension, vector_blob
                FROM semantic_embedding_cache
                WHERE model_identity = :modelIdentity
                  AND normalization_version = :normalizationVersion
                  AND content_hash IN (%s)
                """.formatted(placeholders));
        query.param("modelIdentity", modelIdentity);
        query.param("normalizationVersion", normalizationVersion);
        for (int index = 0; index < hashes.size(); index++) {
            query.param("hash" + index, hashes.get(index));
        }
        Map<String, float[]> result = new LinkedHashMap<>();
        query.query((rs, rowNum) -> new CachedVector(
                rs.getString("content_hash"),
                decode(
                        rs.getBytes("vector_blob"),
                        rs.getInt("dimension")
                )
        )).list().forEach(item -> result.put(item.hash(), item.vector()));
        return result;
    }

    public void save(
            String modelIdentity,
            String normalizationVersion,
            String contentHash,
            float[] vector,
            Instant now
    ) {
        jdbc.sql("""
                INSERT INTO semantic_embedding_cache(
                    model_identity, normalization_version, content_hash,
                    dimension, vector_blob, created_at, last_used_at
                ) VALUES (
                    :modelIdentity, :normalizationVersion, :contentHash,
                    :dimension, :vector, :now, :now
                )
                ON CONFLICT(model_identity, normalization_version, content_hash)
                DO UPDATE SET last_used_at = excluded.last_used_at
                """)
                .param("modelIdentity", modelIdentity)
                .param("normalizationVersion", normalizationVersion)
                .param("contentHash", contentHash)
                .param("dimension", vector.length)
                .param("vector", encode(vector))
                .param("now", now.toString())
                .update();
    }

    private byte[] encode(float[] vector) {
        ByteBuffer buffer = ByteBuffer
                .allocate(vector.length * Float.BYTES)
                .order(ByteOrder.LITTLE_ENDIAN);
        for (float value : vector) {
            buffer.putFloat(value);
        }
        return buffer.array();
    }

    private float[] decode(byte[] bytes, int dimension) {
        if (bytes == null || bytes.length != dimension * Float.BYTES) {
            throw new IllegalStateException(
                    "Stored semantic vector has an invalid dimension"
            );
        }
        ByteBuffer buffer = ByteBuffer.wrap(bytes)
                .order(ByteOrder.LITTLE_ENDIAN);
        float[] vector = new float[dimension];
        for (int index = 0; index < dimension; index++) {
            vector[index] = buffer.getFloat();
        }
        return vector;
    }

    private record CachedVector(String hash, float[] vector) {
    }
}
