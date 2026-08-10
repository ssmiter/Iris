package com.iris.retrieval;

import java.util.List;

final class DisabledSemanticEncoder implements SemanticEncoder {
    private final String identity;

    DisabledSemanticEncoder(String identity) {
        this.identity = identity;
    }

    @Override
    public String identity() {
        return identity;
    }

    @Override
    public boolean available() {
        return false;
    }

    @Override
    public List<float[]> encode(List<String> texts) {
        return List.of();
    }
}
