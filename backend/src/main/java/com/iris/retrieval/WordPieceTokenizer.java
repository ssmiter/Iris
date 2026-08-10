package com.iris.retrieval;

import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.HashMap;
import java.util.List;
import java.util.Map;

/** Minimal cased multilingual BERT tokenizer; vocabulary remains local data. */
final class WordPieceTokenizer {
    private final Map<String, Integer> vocabulary;
    private final int unknownId;
    private final int classificationId;
    private final int separatorId;
    private final int paddingId;
    private final int maxTokens;

    WordPieceTokenizer(Path vocabPath, int maxTokens) throws IOException {
        List<String> lines = Files.readAllLines(
                vocabPath,
                StandardCharsets.UTF_8
        );
        this.vocabulary = new HashMap<>(lines.size());
        for (int index = 0; index < lines.size(); index++) {
            vocabulary.putIfAbsent(lines.get(index), index);
        }
        this.unknownId = required("[UNK]");
        this.classificationId = required("[CLS]");
        this.separatorId = required("[SEP]");
        this.paddingId = required("[PAD]");
        this.maxTokens = Math.max(8, maxTokens);
    }

    Encoded encode(String text) {
        List<Integer> ids = new ArrayList<>();
        ids.add(classificationId);
        for (String token : basicTokens(text)) {
            for (Integer piece : wordPieces(token)) {
                if (ids.size() >= maxTokens - 1) {
                    break;
                }
                ids.add(piece);
            }
            if (ids.size() >= maxTokens - 1) {
                break;
            }
        }
        ids.add(separatorId);
        long[] inputIds = new long[maxTokens];
        long[] attention = new long[maxTokens];
        long[] tokenTypes = new long[maxTokens];
        java.util.Arrays.fill(inputIds, paddingId);
        for (int index = 0; index < ids.size(); index++) {
            inputIds[index] = ids.get(index);
            attention[index] = 1L;
        }
        return new Encoded(inputIds, attention, tokenTypes);
    }

    private List<Integer> wordPieces(String token) {
        if (token.codePointCount(0, token.length()) > 100) {
            return List.of(unknownId);
        }
        List<Integer> result = new ArrayList<>();
        int start = 0;
        while (start < token.length()) {
            Integer matched = null;
            int matchedEnd = token.length();
            for (int end = token.length(); end > start; end--) {
                String piece = token.substring(start, end);
                if (start > 0) {
                    piece = "##" + piece;
                }
                matched = vocabulary.get(piece);
                if (matched != null) {
                    matchedEnd = end;
                    break;
                }
            }
            if (matched == null) {
                return List.of(unknownId);
            }
            result.add(matched);
            start = matchedEnd;
        }
        return result;
    }

    private List<String> basicTokens(String text) {
        List<String> result = new ArrayList<>();
        StringBuilder current = new StringBuilder();
        text.codePoints().forEach(codePoint -> {
            if (Character.isWhitespace(codePoint)
                    || Character.isISOControl(codePoint)) {
                flush(current, result);
            } else if (isCjk(codePoint) || isPunctuation(codePoint)) {
                flush(current, result);
                result.add(new String(Character.toChars(codePoint)));
            } else {
                current.appendCodePoint(codePoint);
            }
        });
        flush(current, result);
        return result;
    }

    private boolean isCjk(int codePoint) {
        Character.UnicodeScript script = Character.UnicodeScript.of(codePoint);
        return script == Character.UnicodeScript.HAN
                || script == Character.UnicodeScript.HIRAGANA
                || script == Character.UnicodeScript.KATAKANA
                || script == Character.UnicodeScript.HANGUL;
    }

    private boolean isPunctuation(int codePoint) {
        int type = Character.getType(codePoint);
        return type == Character.CONNECTOR_PUNCTUATION
                || type == Character.DASH_PUNCTUATION
                || type == Character.START_PUNCTUATION
                || type == Character.END_PUNCTUATION
                || type == Character.INITIAL_QUOTE_PUNCTUATION
                || type == Character.FINAL_QUOTE_PUNCTUATION
                || type == Character.OTHER_PUNCTUATION;
    }

    private void flush(StringBuilder current, List<String> result) {
        if (!current.isEmpty()) {
            result.add(current.toString());
            current.setLength(0);
        }
    }

    private int required(String token) {
        Integer id = vocabulary.get(token);
        if (id == null) {
            throw new IllegalArgumentException(
                    "Embedding vocabulary is missing " + token
            );
        }
        return id;
    }

    record Encoded(long[] inputIds, long[] attention, long[] tokenTypes) {
    }
}
