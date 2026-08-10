package com.iris.tools.web.browser;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.node.ObjectNode;
import com.iris.tools.core.ToolRuntimeException;
import com.iris.tools.core.ToolOutcome;

import java.net.URI;
import java.util.regex.Pattern;

final class BrowserToolSupport {

    private static final Pattern OBJECT_ID =
            Pattern.compile("[A-Za-z0-9][A-Za-z0-9._:-]{0,127}");

    private BrowserToolSupport() {
    }

    static ObjectNode objectSchema(ObjectMapper objectMapper) {
        ObjectNode schema = objectMapper.createObjectNode();
        schema.put("type", "object");
        schema.put("additionalProperties", false);
        schema.putObject("properties");
        return schema;
    }

    static String requiredId(JsonNode input, String field) {
        String value = input.path(field).asText("").trim();
        if (!OBJECT_ID.matcher(value).matches()) {
            throw new ToolRuntimeException(
                    "invalid_browser_object_id",
                    field + " 不是有效的 Browser Runtime 对象 ID"
            );
        }
        return value;
    }

    static String optionalId(JsonNode input, String field) {
        if (!input.hasNonNull(field)
                || input.path(field).asText().isBlank()) {
            return null;
        }
        return requiredId(input, field);
    }

    static String optionalObservationRef(
            JsonNode input,
            String field
    ) {
        if (!input.hasNonNull(field)
                || input.path(field).asText().isBlank()) {
            return null;
        }
        String value = input.path(field).asText().trim();
        if (!value.matches("obs_[a-f0-9]{16,64}")) {
            throw new ToolRuntimeException(
                    "invalid_browser_observation_ref",
                    field + " 必须来自最近一次 observe_browser_page 返回值"
            );
        }
        return value;
    }

    static String optionalUrl(JsonNode input, String field) {
        if (!input.hasNonNull(field)
                || input.path(field).asText().isBlank()) {
            return null;
        }
        return requiredUrl(input, field);
    }

    static String requiredUrl(JsonNode input, String field) {
        String value = input.path(field).asText("").trim();
        URI uri;
        try {
            uri = URI.create(value);
        } catch (IllegalArgumentException exception) {
            throw invalidUrl(field);
        }
        String scheme = uri.getScheme();
        boolean web = "http".equalsIgnoreCase(scheme)
                || "https".equalsIgnoreCase(scheme);
        boolean blankPage = "about".equalsIgnoreCase(scheme)
                && "blank".equalsIgnoreCase(uri.getSchemeSpecificPart());
        if ((!web && !blankPage)
                || (web && (uri.getHost() == null
                || uri.getUserInfo() != null))) {
            throw invalidUrl(field);
        }
        return uri.toASCIIString();
    }

    static int bounded(
            JsonNode input,
            String field,
            int defaultValue,
            int minimum,
            int maximum
    ) {
        int value = input.path(field).asInt(defaultValue);
        if (value < minimum || value > maximum) {
            throw new ToolRuntimeException(
                    "invalid_tool_input",
                    field + " 必须在 " + minimum
                            + " 到 " + maximum + " 之间"
            );
        }
        return value;
    }

    static ObjectNode browserObservationSchema(
            ObjectMapper objectMapper
    ) {
        ObjectNode observation = objectMapper.createObjectNode();
        observation.put("type", "object");
        observation.put(
                "description",
                "不可变、有界的页面观察；元素 ref 只在本 observation revision 内有效"
        );
        return observation;
    }

    static ToolOutcome actionOutcome(
            JsonNode response,
            String notAppliedCode,
            String notAppliedMessage,
            String unknownCode,
            String unknownMessage
    ) {
        return switch (response.path("status").asText()) {
            case "applied" -> ToolOutcome.succeeded(response);
            case "not_applied" -> ToolOutcome.failed(
                    response,
                    notAppliedCode,
                    response.path("message").asText(notAppliedMessage)
            );
            case "outcome_unknown" -> ToolOutcome.unknown(
                    response,
                    unknownCode,
                    response.path("message").asText(unknownMessage)
            );
            default -> ToolOutcome.failed(
                    response,
                    "invalid_browser_action_status",
                    "Browser Runtime 返回了未知动作状态"
            );
        };
    }

    private static ToolRuntimeException invalidUrl(String field) {
        return new ToolRuntimeException(
                "invalid_browser_url",
                field + " 必须是 http/https URL 或 about:blank，且不能包含账号信息"
        );
    }
}
