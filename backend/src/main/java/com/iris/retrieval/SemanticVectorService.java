package com.iris.retrieval;

import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.stereotype.Service;

import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.security.NoSuchAlgorithmException;
import java.text.Normalizer;
import java.time.Instant;
import java.util.ArrayList;
import java.util.HexFormat;
import java.util.LinkedHashMap;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Map;
import java.util.Optional;

/** Versioned persistent embeddings plus a bounded process-local hot cache. */
@Service
public class SemanticVectorService {
    private static final Logger log = LoggerFactory.getLogger(
            SemanticVectorService.class
    );
    private static final String NORMALIZATION_VERSION = "nfkc-ws-v1";
    private static final int HOT_CACHE_SIZE = 2_048;

    private final SemanticEncoder encoder;
    private final SemanticVectorRepository repository;
    private final Map<String, float[]> hot = java.util.Collections
            .synchronizedMap(new LinkedHashMap<>(256, 0.75F, true) {
                @Override
                protected boolean removeEldestEntry(
                        Map.Entry<String, float[]> eldest
                ) {
                    return size() > HOT_CACHE_SIZE;
                }
            });

    public SemanticVectorService(
            SemanticEncoder encoder,
            SemanticVectorRepository repository
    ) {
        this.encoder = encoder;
        this.repository = repository;
    }

    public VectorBatch vectors(List<String> texts) {
        if (texts.isEmpty() || !encoder.available()) {
            return new VectorBatch(
                    encoder.identity(),
                    false,
                    java.util.Collections.nCopies(texts.size(), Optional.empty())
            );
        }
        List<TextIdentity> identities = texts.stream()
                .map(this::identity)
                .toList();
        Map<String, float[]> resolved = new LinkedHashMap<>();
        LinkedHashSet<String> persistentMisses = new LinkedHashSet<>();
        for (TextIdentity item : identities) {
            float[] cached = hot.get(cacheKey(item.hash()));
            if (cached != null) {
                resolved.put(item.hash(), cached);
            } else {
                persistentMisses.add(item.hash());
            }
        }
        if (!persistentMisses.isEmpty()) {
            Map<String, float[]> persisted = repository.findAll(
                    encoder.identity(),
                    NORMALIZATION_VERSION,
                    List.copyOf(persistentMisses)
            );
            persisted.forEach((hash, vector) -> {
                resolved.put(hash, vector);
                hot.put(cacheKey(hash), vector);
            });
            persistentMisses.removeAll(persisted.keySet());
        }

        if (!persistentMisses.isEmpty()) {
            Map<String, String> missingTexts = new LinkedHashMap<>();
            for (TextIdentity item : identities) {
                if (persistentMisses.contains(item.hash())) {
                    missingTexts.putIfAbsent(item.hash(), item.normalized());
                }
            }
            List<String> hashes = List.copyOf(missingTexts.keySet());
            List<float[]> encoded = encoder.encode(
                    List.copyOf(missingTexts.values())
            );
            if (encoded.size() == hashes.size()) {
                Instant now = Instant.now();
                for (int index = 0; index < hashes.size(); index++) {
                    float[] vector = encoded.get(index);
                    if (vector == null || vector.length == 0) {
                        continue;
                    }
                    String hash = hashes.get(index);
                    resolved.put(hash, vector);
                    hot.put(cacheKey(hash), vector);
                    repository.save(
                            encoder.identity(),
                            NORMALIZATION_VERSION,
                            hash,
                            vector,
                            now
                    );
                }
            } else if (!encoded.isEmpty()) {
                log.warn(
                        "Semantic encoder {} returned {} vectors for {} texts",
                        encoder.identity(),
                        encoded.size(),
                        hashes.size()
                );
            }
        }

        List<Optional<float[]>> ordered = new ArrayList<>(texts.size());
        for (TextIdentity item : identities) {
            ordered.add(Optional.ofNullable(resolved.get(item.hash())));
        }
        boolean available = ordered.stream().anyMatch(Optional::isPresent);
        return new VectorBatch(
                encoder.identity(),
                available,
                List.copyOf(ordered)
        );
    }

    private TextIdentity identity(String text) {
        String normalized = Normalizer.normalize(
                        text == null ? "" : text,
                        Normalizer.Form.NFKC
                )
                .replaceAll("\\s+", " ")
                .trim();
        return new TextIdentity(normalized, hash(normalized));
    }

    private String hash(String value) {
        try {
            return HexFormat.of().formatHex(
                    MessageDigest.getInstance("SHA-256").digest(
                            value.getBytes(StandardCharsets.UTF_8)
                    )
            );
        } catch (NoSuchAlgorithmException exception) {
            throw new IllegalStateException("SHA-256 unavailable", exception);
        }
    }

    private String cacheKey(String hash) {
        return encoder.identity() + ":" + NORMALIZATION_VERSION + ":" + hash;
    }

    private record TextIdentity(String normalized, String hash) {
    }

    public record VectorBatch(
            String modelIdentity,
            boolean available,
            List<Optional<float[]>> vectors
    ) {
    }
}
