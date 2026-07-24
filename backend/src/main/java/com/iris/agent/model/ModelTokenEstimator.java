package com.iris.agent.model;

import com.fasterxml.jackson.core.JsonProcessingException;
import com.fasterxml.jackson.databind.ObjectMapper;
import org.springframework.stereotype.Component;

/**
 * Conservative provider-neutral estimate. It intentionally overestimates
 * mixed CJK/JSON input and is replaceable by a profile-specific tokenizer.
 */
@Component
public class ModelTokenEstimator {
    private final ObjectMapper objectMapper;

    public ModelTokenEstimator(ObjectMapper objectMapper) {
        this.objectMapper = objectMapper;
    }

    public int estimate(Object value) {
        try {
            return estimateText(objectMapper.writeValueAsString(value));
        } catch (JsonProcessingException exception) {
            throw new IllegalArgumentException(
                    "Model context cannot be token-estimated",
                    exception
            );
        }
    }

    public int estimateText(String value) {
        if (value == null || value.isEmpty()) {
            return 0;
        }
        long weightedUnits = value.codePoints()
                .mapToLong(codePoint -> {
                    if (isCjk(codePoint)) {
                        return 4;
                    }
                    if (Character.isWhitespace(codePoint)) {
                        return 1;
                    }
                    return codePoint < 128 ? 1 : 2;
                })
                .sum();
        return Math.toIntExact(Math.max(1, (weightedUnits + 2) / 3));
    }

    private boolean isCjk(int codePoint) {
        Character.UnicodeScript script =
                Character.UnicodeScript.of(codePoint);
        return script == Character.UnicodeScript.HAN
                || script == Character.UnicodeScript.HIRAGANA
                || script == Character.UnicodeScript.KATAKANA
                || script == Character.UnicodeScript.HANGUL;
    }
}
