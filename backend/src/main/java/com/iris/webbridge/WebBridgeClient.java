package com.iris.webbridge;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.node.ObjectNode;
import com.iris.tools.core.ToolRuntimeException;
import org.springframework.beans.factory.annotation.Qualifier;
import org.springframework.stereotype.Component;

import java.io.IOException;
import java.net.URI;
import java.net.URLEncoder;
import java.net.http.HttpClient;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;
import java.nio.charset.StandardCharsets;
import java.time.Duration;

/**
 * Backend 到 WebBridge daemon 的唯一协议适配器。
 */
@Component
public class WebBridgeClient {

    private static final Duration READ_TIMEOUT = Duration.ofSeconds(8);
    private static final Duration ACTION_TIMEOUT = Duration.ofSeconds(45);

    private final HttpClient http;
    private final ObjectMapper objectMapper;
    private final BrowserRuntimeCatalog runtimes;

    public WebBridgeClient(
            @Qualifier("webBridgeHttpClient") HttpClient http,
            ObjectMapper objectMapper,
            BrowserRuntimeCatalog runtimes
    ) {
        this.http = http;
        this.objectMapper = objectMapper;
        this.runtimes = runtimes;
    }

    public JsonNode health(String runtimeId) {
        return send(
                runtimes.require(runtimeId),
                "GET",
                "/health",
                null,
                READ_TIMEOUT
        );
    }

    public JsonNode listSessions(String runtimeId) {
        return send(
                runtimes.require(runtimeId),
                "GET",
                "/sessions",
                null,
                READ_TIMEOUT
        );
    }

    public JsonNode openSession(String runtimeId, String initialUrl) {
        ObjectNode body = objectMapper.createObjectNode();
        if (initialUrl != null && !initialUrl.isBlank()) {
            body.put("url", initialUrl);
        }
        return send(
                runtimes.require(runtimeId),
                "POST",
                "/sessions",
                body,
                ACTION_TIMEOUT
        );
    }

    public JsonNode observe(
            String runtimeId,
            String sessionId,
            String pageId,
            int maxTextCharacters,
            int maxElements
    ) {
        ObjectNode body = objectMapper.createObjectNode();
        if (pageId != null && !pageId.isBlank()) {
            body.put("pageId", pageId);
        }
        body.put("maxTextCharacters", maxTextCharacters);
        body.put("maxElements", maxElements);
        return send(
                runtimes.require(runtimeId),
                "POST",
                "/sessions/" + segment(sessionId) + "/observe",
                body,
                ACTION_TIMEOUT
        );
    }

    public JsonNode waitForPage(
            String runtimeId,
            String sessionId,
            String pageId,
            String afterObservationRef,
            String condition,
            String text,
            int timeoutMs
    ) {
        ObjectNode body = objectMapper.createObjectNode();
        body.put("pageId", pageId);
        body.put("afterObservationRef", afterObservationRef);
        body.put("condition", condition);
        if (text != null) {
            body.put("text", text);
        }
        body.put("timeoutMs", timeoutMs);
        return send(
                runtimes.require(runtimeId),
                "POST",
                "/sessions/" + segment(sessionId) + "/wait",
                body,
                Duration.ofMillis(timeoutMs + 3_000L)
        );
    }

    public JsonNode navigate(
            String runtimeId,
            String sessionId,
            String pageId,
            String url,
            String expectedObservationRef,
            String executionId
    ) {
        ObjectNode body = objectMapper.createObjectNode();
        body.put("toolExecutionId", executionId);
        body.put("actionAttemptId", executionId + ":navigate");
        body.put("idempotencyKey", executionId);
        if (expectedObservationRef != null
                && !expectedObservationRef.isBlank()) {
            body.put("expectedObservationRef", expectedObservationRef);
        }
        body.put("primitive", "navigate");
        ObjectNode arguments = body.putObject("normalizedArgs");
        arguments.put("pageId", pageId);
        arguments.put("url", url);
        return send(
                runtimes.require(runtimeId),
                "POST",
                "/sessions/" + segment(sessionId) + "/actions",
                body,
                ACTION_TIMEOUT
        );
    }

    public JsonNode resolveElement(
            String runtimeId,
            String sessionId,
            String pageId,
            String observationRef,
            String elementRef
    ) {
        ObjectNode body = objectMapper.createObjectNode();
        body.put("pageId", pageId);
        body.put("observationRef", observationRef);
        body.put("elementRef", elementRef);
        return send(
                runtimes.require(runtimeId),
                "POST",
                "/sessions/" + segment(sessionId) + "/elements/resolve",
                body,
                READ_TIMEOUT
        );
    }

    public JsonNode click(
            String runtimeId,
            String sessionId,
            String pageId,
            String observationRef,
            String elementRef,
            String executionId
    ) {
        ObjectNode body = objectMapper.createObjectNode();
        body.put("toolExecutionId", executionId);
        body.put("actionAttemptId", executionId + ":click");
        body.put("idempotencyKey", executionId);
        body.put("expectedObservationRef", observationRef);
        body.put("primitive", "click");
        ObjectNode arguments = body.putObject("normalizedArgs");
        arguments.put("pageId", pageId);
        arguments.put("elementRef", elementRef);
        return send(
                runtimes.require(runtimeId),
                "POST",
                "/sessions/" + segment(sessionId) + "/actions",
                body,
                ACTION_TIMEOUT
        );
    }

    public JsonNode fill(
            String runtimeId,
            String sessionId,
            String pageId,
            String observationRef,
            String elementRef,
            String value,
            String executionId
    ) {
        ObjectNode body = objectMapper.createObjectNode();
        body.put("toolExecutionId", executionId);
        body.put("actionAttemptId", executionId + ":fill");
        body.put("idempotencyKey", executionId);
        body.put("expectedObservationRef", observationRef);
        body.put("primitive", "fill");
        ObjectNode arguments = body.putObject("normalizedArgs");
        arguments.put("pageId", pageId);
        arguments.put("elementRef", elementRef);
        arguments.put("value", value);
        return send(
                runtimes.require(runtimeId),
                "POST",
                "/sessions/" + segment(sessionId) + "/actions",
                body,
                ACTION_TIMEOUT
        );
    }

    public JsonNode select(
            String runtimeId,
            String sessionId,
            String pageId,
            String observationRef,
            String elementRef,
            String value,
            String executionId
    ) {
        ObjectNode body = objectMapper.createObjectNode();
        body.put("toolExecutionId", executionId);
        body.put("actionAttemptId", executionId + ":select");
        body.put("idempotencyKey", executionId);
        body.put("expectedObservationRef", observationRef);
        body.put("primitive", "select");
        ObjectNode arguments = body.putObject("normalizedArgs");
        arguments.put("pageId", pageId);
        arguments.put("elementRef", elementRef);
        arguments.put("value", value);
        return send(
                runtimes.require(runtimeId),
                "POST",
                "/sessions/" + segment(sessionId) + "/actions",
                body,
                ACTION_TIMEOUT
        );
    }

    public JsonNode scroll(
            String runtimeId,
            String sessionId,
            String pageId,
            String observationRef,
            String direction,
            int amount,
            String executionId
    ) {
        ObjectNode body = objectMapper.createObjectNode();
        body.put("toolExecutionId", executionId);
        body.put("actionAttemptId", executionId + ":scroll");
        body.put("idempotencyKey", executionId);
        body.put("expectedObservationRef", observationRef);
        body.put("primitive", "scroll");
        ObjectNode arguments = body.putObject("normalizedArgs");
        arguments.put("pageId", pageId);
        arguments.put("direction", direction);
        arguments.put("amount", amount);
        return send(
                runtimes.require(runtimeId),
                "POST",
                "/sessions/" + segment(sessionId) + "/actions",
                body,
                ACTION_TIMEOUT
        );
    }

    public ScreenshotPayload captureScreenshot(
            String runtimeId,
            String sessionId,
            String pageId,
            String format,
            int quality,
            boolean fullPage
    ) {
        ObjectNode body = objectMapper.createObjectNode();
        body.put("pageId", pageId);
        body.put("format", format);
        body.put("quality", quality);
        body.put("fullPage", fullPage);
        BrowserRuntimeCatalog.Binding binding =
                runtimes.require(runtimeId);
        HttpRequest request = HttpRequest.newBuilder()
                .uri(resolve(
                        binding.endpoint(),
                        "/sessions/" + segment(sessionId) + "/screenshot"
                ))
                .timeout(ACTION_TIMEOUT)
                .header("Accept", "image/png, image/jpeg")
                .header("Authorization", "Bearer " + binding.token())
                .header("Content-Type", "application/json")
                .POST(HttpRequest.BodyPublishers.ofString(
                        body.toString(),
                        StandardCharsets.UTF_8
                ))
                .build();
        HttpResponse<byte[]> response;
        try {
            response = http.send(
                    request,
                    HttpResponse.BodyHandlers.ofByteArray()
            );
        } catch (InterruptedException exception) {
            Thread.currentThread().interrupt();
            throw new ToolRuntimeException(
                    "webbridge_interrupted",
                    "Browser Runtime 截图请求被中断"
            );
        } catch (IOException exception) {
            throw new ToolRuntimeException(
                    "webbridge_unreachable",
                    "Browser Runtime 当前不可达"
            );
        }
        if (response.statusCode() < 200
                || response.statusCode() >= 300) {
            JsonNode problem = parse(new String(
                    response.body(),
                    StandardCharsets.UTF_8
            ));
            throw new ToolRuntimeException(
                    problem.path("error").path("code").asText(
                            "webbridge_screenshot_failed"
                    ),
                    problem.path("error").path("message").asText(
                            "Browser Runtime 截图失败"
                    )
            );
        }
        String mediaType = response.headers()
                .firstValue("Content-Type")
                .orElse("");
        if (!"image/png".equals(mediaType)
                && !"image/jpeg".equals(mediaType)) {
            throw new ToolRuntimeException(
                    "webbridge_invalid_screenshot",
                    "Browser Runtime 返回了不支持的截图媒体类型"
            );
        }
        byte[] bytes = response.body();
        if (bytes.length == 0 || bytes.length > 12 * 1024 * 1024) {
            throw new ToolRuntimeException(
                    "webbridge_invalid_screenshot",
                    "Browser Runtime 截图为空或超过 12 MB"
            );
        }
        return new ScreenshotPayload(
                bytes,
                mediaType,
                response.headers()
                        .firstValue("X-Iris-Observation-Ref")
                        .orElse(""),
                response.headers()
                        .firstValue("X-Iris-Page-Id")
                        .orElse(pageId)
        );
    }

    public JsonNode closeSession(
            String runtimeId,
            String sessionId
    ) {
        return send(
                runtimes.require(runtimeId),
                "DELETE",
                "/sessions/" + segment(sessionId),
                null,
                ACTION_TIMEOUT
        );
    }

    public JsonNode readActionResult(
            String runtimeId,
            String sessionId,
            String idempotencyKey
    ) {
        return send(
                runtimes.require(runtimeId),
                "GET",
                "/sessions/" + segment(sessionId)
                        + "/actions/" + segment(idempotencyKey),
                null,
                READ_TIMEOUT
        );
    }

    private JsonNode send(
            BrowserRuntimeCatalog.Binding binding,
            String method,
            String path,
            JsonNode body,
            Duration timeout
    ) {
        HttpRequest.Builder request = HttpRequest.newBuilder()
                .uri(resolve(binding.endpoint(), path))
                .timeout(timeout)
                .header("Accept", "application/json")
                .header("Authorization", "Bearer " + binding.token());
        if (body == null) {
            request.method(method, HttpRequest.BodyPublishers.noBody());
        } else {
            request.header("Content-Type", "application/json")
                    .method(
                            method,
                            HttpRequest.BodyPublishers.ofString(
                                    body.toString(),
                                    StandardCharsets.UTF_8
                            )
                    );
        }
        HttpResponse<String> response;
        try {
            response = http.send(
                    request.build(),
                    HttpResponse.BodyHandlers.ofString(StandardCharsets.UTF_8)
            );
        } catch (InterruptedException exception) {
            Thread.currentThread().interrupt();
            throw new ToolRuntimeException(
                    "webbridge_interrupted",
                    "Browser Runtime 请求被中断"
            );
        } catch (IOException exception) {
            throw new ToolRuntimeException(
                    "webbridge_unreachable",
                    "Browser Runtime 当前不可达"
            );
        }
        JsonNode payload = parse(response.body());
        if (response.statusCode() < 200 || response.statusCode() >= 300) {
            String code = payload.path("error").path("code").asText(
                    payload.path("code").asText("webbridge_request_failed")
            );
            String message = payload.path("error").path("message").asText(
                    payload.path("message").asText(
                            "Browser Runtime 返回 HTTP "
                                    + response.statusCode()
                    )
            );
            throw new ToolRuntimeException(code, message);
        }
        return payload;
    }

    private JsonNode parse(String body) {
        try {
            return objectMapper.readTree(body);
        } catch (Exception exception) {
            throw new ToolRuntimeException(
                    "webbridge_invalid_response",
                    "Browser Runtime 返回了无法解析的响应"
            );
        }
    }

    private URI resolve(URI endpoint, String path) {
        return URI.create(endpoint.toString() + path);
    }

    private String segment(String value) {
        if (value == null || value.isBlank()) {
            throw new ToolRuntimeException(
                    "invalid_browser_object_id",
                    "Browser Session/Page 对象 ID 不能为空"
            );
        }
        return URLEncoder.encode(value, StandardCharsets.UTF_8)
                .replace("+", "%20");
    }

    public record ScreenshotPayload(
            byte[] bytes,
            String mediaType,
            String observationRef,
            String pageId
    ) {
        public ScreenshotPayload {
            bytes = bytes.clone();
        }

        @Override
        public byte[] bytes() {
            return bytes.clone();
        }
    }
}
