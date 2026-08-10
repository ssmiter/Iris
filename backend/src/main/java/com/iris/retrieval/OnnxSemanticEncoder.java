package com.iris.retrieval;

import ai.onnxruntime.OnnxTensor;
import ai.onnxruntime.OrtEnvironment;
import ai.onnxruntime.OrtException;
import ai.onnxruntime.OrtSession;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;

import java.io.IOException;
import java.nio.LongBuffer;
import java.nio.file.Files;
import java.nio.file.Path;
import java.time.Duration;
import java.time.Instant;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

/** Lazy local ONNX encoder with bounded batches and failure backoff. */
final class OnnxSemanticEncoder implements SemanticEncoder {
    private static final Logger log = LoggerFactory.getLogger(
            OnnxSemanticEncoder.class
    );
    private static final Duration FAILURE_BACKOFF = Duration.ofMinutes(5);

    private final String identity;
    private final Path modelPath;
    private final Path vocabPath;
    private final int maxTokens;
    private final int batchSize;
    private volatile RuntimeState state;
    private volatile Instant retryAfter = Instant.EPOCH;

    OnnxSemanticEncoder(
            String identity,
            Path modelPath,
            Path vocabPath,
            int maxTokens,
            int batchSize
    ) {
        this.identity = identity;
        this.modelPath = modelPath;
        this.vocabPath = vocabPath;
        this.maxTokens = Math.max(8, maxTokens);
        this.batchSize = Math.max(1, batchSize);
    }

    @Override
    public String identity() {
        return identity;
    }

    @Override
    public boolean available() {
        return runtime() != null;
    }

    @Override
    public List<float[]> encode(List<String> texts) {
        if (texts.isEmpty()) {
            return List.of();
        }
        RuntimeState current = runtime();
        if (current == null) {
            return List.of();
        }
        List<float[]> result = new ArrayList<>(texts.size());
        try {
            for (int from = 0; from < texts.size(); from += batchSize) {
                int to = Math.min(texts.size(), from + batchSize);
                result.addAll(encodeBatch(
                        current,
                        texts.subList(from, to)
                ));
            }
            return List.copyOf(result);
        } catch (RuntimeException exception) {
            fail(exception);
            return List.of();
        }
    }

    private List<float[]> encodeBatch(
            RuntimeState runtime,
            List<String> texts
    ) {
        int rows = texts.size();
        long[] ids = new long[rows * maxTokens];
        long[] masks = new long[rows * maxTokens];
        long[] types = new long[rows * maxTokens];
        for (int row = 0; row < rows; row++) {
            WordPieceTokenizer.Encoded encoded = runtime.tokenizer()
                    .encode(texts.get(row));
            System.arraycopy(
                    encoded.inputIds(), 0, ids, row * maxTokens, maxTokens
            );
            System.arraycopy(
                    encoded.attention(), 0, masks, row * maxTokens, maxTokens
            );
            System.arraycopy(
                    encoded.tokenTypes(), 0, types, row * maxTokens, maxTokens
            );
        }

        long[] shape = {rows, maxTokens};
        try (OnnxTensor inputIds = OnnxTensor.createTensor(
                runtime.environment(), LongBuffer.wrap(ids), shape
        ); OnnxTensor attention = OnnxTensor.createTensor(
                runtime.environment(), LongBuffer.wrap(masks), shape
        ); OnnxTensor tokenTypes = runtime.usesTokenTypes()
                ? OnnxTensor.createTensor(
                        runtime.environment(), LongBuffer.wrap(types), shape
                ) : null) {
            Map<String, OnnxTensor> inputs = new LinkedHashMap<>();
            inputs.put("input_ids", inputIds);
            inputs.put("attention_mask", attention);
            if (tokenTypes != null) {
                inputs.put("token_type_ids", tokenTypes);
            }
            try (OrtSession.Result output = runtime.session().run(inputs)) {
                Object value = output.get(0).getValue();
                if (value instanceof float[][][] tokens) {
                    return meanPool(tokens, masks, rows);
                }
                if (value instanceof float[][] sentences) {
                    List<float[]> vectors = new ArrayList<>(sentences.length);
                    for (float[] sentence : sentences) {
                        vectors.add(normalize(sentence.clone()));
                    }
                    return vectors;
                }
                throw new IllegalStateException(
                        "Unsupported ONNX embedding output: "
                                + value.getClass().getName()
                );
            }
        } catch (OrtException exception) {
            throw new IllegalStateException(
                    "ONNX embedding inference failed",
                    exception
            );
        }
    }

    private List<float[]> meanPool(
            float[][][] tokens,
            long[] masks,
            int rows
    ) {
        List<float[]> result = new ArrayList<>(rows);
        for (int row = 0; row < rows; row++) {
            int dimension = tokens[row][0].length;
            float[] pooled = new float[dimension];
            int count = 0;
            for (int token = 0; token < tokens[row].length; token++) {
                if (masks[row * maxTokens + token] == 0L) {
                    continue;
                }
                count++;
                for (int column = 0; column < dimension; column++) {
                    pooled[column] += tokens[row][token][column];
                }
            }
            if (count > 0) {
                for (int column = 0; column < pooled.length; column++) {
                    pooled[column] /= count;
                }
            }
            result.add(normalize(pooled));
        }
        return result;
    }

    private float[] normalize(float[] vector) {
        double norm = 0D;
        for (float value : vector) {
            norm += value * value;
        }
        if (norm <= 0D) {
            return vector;
        }
        float divisor = (float) Math.sqrt(norm);
        for (int index = 0; index < vector.length; index++) {
            vector[index] /= divisor;
        }
        return vector;
    }

    private RuntimeState runtime() {
        RuntimeState current = state;
        if (current != null) {
            return current;
        }
        if (Instant.now().isBefore(retryAfter)) {
            return null;
        }
        synchronized (this) {
            if (state != null) {
                return state;
            }
            if (Instant.now().isBefore(retryAfter)) {
                return null;
            }
            try {
                if (!Files.isRegularFile(modelPath)
                        || !Files.isRegularFile(vocabPath)) {
                    throw new IOException(
                            "model-path and vocab-path must be readable files"
                    );
                }
                OrtEnvironment environment = OrtEnvironment.getEnvironment();
                OrtSession.SessionOptions options =
                        new OrtSession.SessionOptions();
                options.setOptimizationLevel(
                        OrtSession.SessionOptions.OptLevel.ALL_OPT
                );
                OrtSession session = environment.createSession(
                        modelPath.toString(),
                        options
                );
                WordPieceTokenizer tokenizer = new WordPieceTokenizer(
                        vocabPath,
                        maxTokens
                );
                state = new RuntimeState(
                        environment,
                        session,
                        options,
                        tokenizer,
                        session.getInputNames().contains("token_type_ids")
                );
                log.info("Semantic encoder {} loaded", identity);
                return state;
            } catch (Exception exception) {
                fail(exception);
                return null;
            }
        }
    }

    private synchronized void fail(Exception exception) {
        RuntimeState previous = state;
        state = null;
        retryAfter = Instant.now().plus(FAILURE_BACKOFF);
        if (previous != null) {
            previous.close();
        }
        log.warn(
                "Semantic encoder {} unavailable; lexical retrieval remains active: {}",
                identity,
                exception.getMessage()
        );
    }

    @Override
    public synchronized void close() {
        RuntimeState current = state;
        state = null;
        if (current != null) {
            current.close();
        }
    }

    private record RuntimeState(
            OrtEnvironment environment,
            OrtSession session,
            OrtSession.SessionOptions options,
            WordPieceTokenizer tokenizer,
            boolean usesTokenTypes
    ) {
        private void close() {
            try {
                session.close();
            } catch (Exception ignored) {
            }
            try {
                options.close();
            } catch (Exception ignored) {
            }
        }
    }
}
