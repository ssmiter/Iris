package com.iris.retrieval;

import org.springframework.beans.factory.annotation.Value;
import org.springframework.stereotype.Service;

import java.util.ArrayList;
import java.util.Comparator;
import java.util.List;
import java.util.Optional;

/**
 * Domain-neutral fusion. Callers retain responsibility for visibility and
 * lifecycle filtering before candidates enter this engine.
 */
@Service
public class HybridRetrievalEngine {
    private final SemanticVectorService semantics;
    private final double lexicalWeight;
    private final double semanticWeight;
    private final double semanticThreshold;

    public HybridRetrievalEngine(
            SemanticVectorService semantics,
            @Value("${iris.retrieval.hybrid.lexical-weight:0.55}")
            double lexicalWeight,
            @Value("${iris.retrieval.hybrid.semantic-weight:0.45}")
            double semanticWeight,
            @Value("${iris.retrieval.hybrid.semantic-threshold:0.48}")
            double semanticThreshold
    ) {
        this.semantics = semantics;
        double total = lexicalWeight + semanticWeight;
        if (lexicalWeight < 0D || semanticWeight < 0D || total <= 0D) {
            throw new IllegalArgumentException(
                    "Hybrid retrieval weights must be non-negative"
            );
        }
        this.lexicalWeight = lexicalWeight / total;
        this.semanticWeight = semanticWeight / total;
        this.semanticThreshold = Math.max(-1D, Math.min(1D, semanticThreshold));
    }

    public <T> SearchResult<T> rank(
            String query,
            List<Candidate<T>> candidates,
            int limit
    ) {
        if (candidates.isEmpty() || limit < 1) {
            return new SearchResult<>("lexical", null, List.of());
        }
        double maxLexical = candidates.stream()
                .mapToDouble(Candidate::lexicalScore)
                .max()
                .orElse(0D);
        List<String> texts = new ArrayList<>(candidates.size() + 1);
        texts.add(query);
        candidates.forEach(candidate -> texts.add(candidate.semanticText()));
        SemanticVectorService.VectorBatch batch = semantics.vectors(texts);
        Optional<float[]> queryVector = batch.vectors().isEmpty()
                ? Optional.empty() : batch.vectors().getFirst();
        boolean semanticAvailable = batch.available()
                && queryVector.isPresent()
                && batch.vectors().size() == texts.size();

        List<Ranked<T>> ranked = new ArrayList<>();
        for (int index = 0; index < candidates.size(); index++) {
            Candidate<T> candidate = candidates.get(index);
            double lexical = maxLexical <= 0D
                    ? 0D : candidate.lexicalScore() / maxLexical;
            Double semantic = null;
            if (semanticAvailable) {
                Optional<float[]> vector = batch.vectors().get(index + 1);
                if (vector.isPresent()) {
                    semantic = cosine(queryVector.orElseThrow(), vector.get());
                }
            }
            boolean semanticHit = semantic != null
                    && semantic >= semanticThreshold;
            if (candidate.lexicalScore() <= 0D && !semanticHit) {
                continue;
            }
            double combined;
            String strategy;
            if (semantic == null) {
                combined = lexical;
                strategy = "lexical";
            } else {
                combined = lexicalWeight * lexical
                        + semanticWeight * Math.max(0D, semantic);
                strategy = candidate.lexicalScore() > 0D
                        ? "hybrid" : "semantic";
            }
            if (candidate.exactAnchor()) {
                combined = Math.max(combined, 0.92D);
            }
            ranked.add(new Ranked<>(
                    candidate.value(),
                    candidate.id(),
                    lexical,
                    semantic,
                    Math.min(1D, combined),
                    candidate.exactAnchor(),
                    strategy
            ));
        }
        ranked.sort(Comparator
                .comparingDouble((Ranked<T> item) -> item.combinedScore())
                .reversed()
                .thenComparing(Ranked::id));
        String strategy = semanticAvailable ? "hybrid" : "lexical";
        return new SearchResult<>(
                strategy,
                semanticAvailable ? batch.modelIdentity() : null,
                ranked.stream().limit(limit).toList()
        );
    }

    private double cosine(float[] left, float[] right) {
        if (left.length != right.length || left.length == 0) {
            return -1D;
        }
        double dot = 0D;
        double leftNorm = 0D;
        double rightNorm = 0D;
        for (int index = 0; index < left.length; index++) {
            dot += left[index] * right[index];
            leftNorm += left[index] * left[index];
            rightNorm += right[index] * right[index];
        }
        if (leftNorm <= 0D || rightNorm <= 0D) {
            return -1D;
        }
        return Math.max(
                -1D,
                Math.min(1D, dot / Math.sqrt(leftNorm * rightNorm))
        );
    }

    public record Candidate<T>(
            T value,
            String id,
            String semanticText,
            double lexicalScore,
            boolean exactAnchor
    ) {
    }

    public record Ranked<T>(
            T value,
            String id,
            double lexicalScore,
            Double semanticScore,
            double combinedScore,
            boolean exactAnchor,
            String strategy
    ) {
    }

    public record SearchResult<T>(
            String strategy,
            String modelIdentity,
            List<Ranked<T>> matches
    ) {
    }
}
