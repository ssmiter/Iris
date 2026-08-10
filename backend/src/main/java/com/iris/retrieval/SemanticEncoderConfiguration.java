package com.iris.retrieval;

import org.springframework.beans.factory.annotation.Value;
import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Configuration;

import java.nio.file.Path;

@Configuration
public class SemanticEncoderConfiguration {
    @Bean(destroyMethod = "close")
    public SemanticEncoder semanticEncoder(
            @Value("${iris.retrieval.embedding.mode:disabled}") String mode,
            @Value("${iris.retrieval.embedding.model-path:}") String modelPath,
            @Value("${iris.retrieval.embedding.vocab-path:}") String vocabPath,
            @Value("${iris.retrieval.embedding.identity:local-semantic-v1}") String identity,
            @Value("${iris.retrieval.embedding.max-tokens:256}") int maxTokens,
            @Value("${iris.retrieval.embedding.batch-size:32}") int batchSize
    ) {
        if ("onnx".equalsIgnoreCase(mode)
                && !modelPath.isBlank()
                && !vocabPath.isBlank()) {
            return new OnnxSemanticEncoder(
                    identity,
                    Path.of(modelPath).toAbsolutePath().normalize(),
                    Path.of(vocabPath).toAbsolutePath().normalize(),
                    maxTokens,
                    batchSize
            );
        }
        return new DisabledSemanticEncoder(identity + ":disabled");
    }
}
