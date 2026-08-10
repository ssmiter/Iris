package com.iris.retrieval;

import java.util.List;

/** A process-scoped sentence encoder. Retrieval must survive its absence. */
public interface SemanticEncoder extends AutoCloseable {
    String identity();

    boolean available();

    List<float[]> encode(List<String> texts);

    @Override
    default void close() {
    }
}
