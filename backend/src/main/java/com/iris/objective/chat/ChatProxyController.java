package com.iris.objective.chat;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.node.ArrayNode;
import com.fasterxml.jackson.databind.node.ObjectNode;
import org.springframework.http.HttpHeaders;
import org.springframework.http.HttpStatus;
import org.springframework.http.MediaType;
import org.springframework.http.codec.ServerSentEvent;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RestController;
import org.springframework.web.reactive.function.client.WebClient;
import org.springframework.web.server.ResponseStatusException;
import reactor.core.publisher.Flux;

import java.net.URI;
import java.time.Duration;
import java.util.ArrayList;
import java.util.HashMap;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.Set;

/**
 * 前端 Agent Runtime 的模型边界。
 *
 * <p>这里不做工具编排、不写会话历史，只把统一的内部请求翻译成供应商协议，
 * 再把供应商的 SSE 翻译回统一的 Iris chunk。这样前端可以自主驱动 agent loop，
 * 而 Java 后端仍然保留凭证、CORS、超时和错误语义的单一边界。</p>
 */
@RestController
@RequestMapping("/api/chat")
public class ChatProxyController {

    private static final Duration TIMEOUT = Duration.ofSeconds(180);
    private static final String ANTHROPIC_VERSION = "2023-06-01";

    private final com.iris.gateway.model.ModelGatewayProfileCatalog catalog;
    private final WebClient.Builder clients;
    private final ObjectMapper objectMapper;

    public ChatProxyController(
            com.iris.gateway.model.ModelGatewayProfileCatalog catalog,
            WebClient.Builder clients,
            ObjectMapper objectMapper
    ) {
        this.catalog = catalog;
        this.clients = clients;
        this.objectMapper = objectMapper;
    }

    @PostMapping(value = "/proxy", produces = MediaType.TEXT_EVENT_STREAM_VALUE)
    public Flux<ServerSentEvent<String>> proxy(@RequestBody JsonNode body) {
        if (body == null || !body.isObject()) {
            return errorStream("请求体必须是 JSON 对象");
        }

        final ProxyTarget target;
        final ObjectNode upstream;
        try {
            target = resolveTarget(body);
            upstream = target.anthropic()
                    ? buildAnthropicRequest(body, target)
                    : buildOpenAiRequest(body, target);
        } catch (ResponseStatusException | IllegalArgumentException ex) {
            return errorStream(messageOf(ex));
        }

        Flux<ServerSentEvent<String>> stream = send(target, upstream);
        if (target.anthropic()) {
            stream = normalizeAnthropicStream(stream);
        }

        // Provider 的 HTTP 错误不能在 SSE 已建立后再变成 500，否则浏览器只能看到
        // “模型服务暂时不可用”并重试，丢掉上游真正的 400/401/429 原因。统一转成
        // 前端可消费的 in-band error，保持与 MESCLI ChatProxyService 相同的语义。
        return stream
                .timeout(TIMEOUT)
                .onErrorResume(error -> isCancellation(error)
                        ? Flux.empty()
                        : errorStream(messageOf(error)));
    }

    private Flux<ServerSentEvent<String>> send(ProxyTarget target, ObjectNode upstream) {
        WebClient.RequestBodySpec request = clients.baseUrl(target.baseUrl())
                .defaultHeaders(headers -> {
                    if (target.anthropic()) {
                        headers.set("x-api-key", target.apiKey());
                        headers.set("anthropic-version", ANTHROPIC_VERSION);
                        if (upstream.has("output_config")) {
                            headers.set("anthropic-beta", "effort-2025-11-24");
                        }
                    } else if (!target.apiKey().isBlank()) {
                        headers.setBearerAuth(target.apiKey());
                    }
                })
                .build()
                .post()
                .uri(target.endpointPath())
                .contentType(MediaType.APPLICATION_JSON)
                .accept(MediaType.TEXT_EVENT_STREAM);

        return request.bodyValue(upstream)
                .exchangeToFlux(response -> {
                    if (response.statusCode().isError()) {
                        return response.bodyToMono(String.class)
                                .defaultIfEmpty("")
                                .flatMapMany(text -> Flux.error(new ProviderProxyException(
                                        response.statusCode().value(), safeProviderError(text))));
                    }
                    MediaType contentType = response.headers().contentType().orElse(null);
                    if (contentType == null
                            || !MediaType.TEXT_EVENT_STREAM.isCompatibleWith(contentType)) {
                        return response.bodyToMono(String.class)
                                .defaultIfEmpty("")
                                .flatMapMany(text -> Flux.error(new ProviderProxyException(
                                        response.statusCode().value(),
                                        "模型服务返回了非流式响应：" + safeProviderError(text))));
                    }
                    return response.bodyToFlux(
                            new org.springframework.core.ParameterizedTypeReference<ServerSentEvent<String>>() { });
                });
    }

    /** 凭证来源：请求携带的 BYOK 优先；否则回落到本机激活 profile。 */
    private ProxyTarget resolveTarget(JsonNode body) {
        String requestKey = text(body, "apiKey");
        String requestBase = text(body, "baseUrl");
        String provider = text(body, "provider");
        boolean requestedAnthropic = isAnthropic(body, provider);

        if (!blank(requestKey) && !blank(requestBase)) {
            String endpoint = text(body, "endpointPath");
            endpoint = blank(endpoint)
                    ? defaultEndpoint(requestBase, requestedAnthropic)
                    : normalizePath(endpoint);
            return new ProxyTarget(
                    stripTrailingSlash(requestBase.trim()), endpoint, requestKey.trim(),
                    requestedAnthropic, null);
        }

        var profile = catalog.activeProfile();
        boolean anthropic = isAnthropicKind(profile.getKind())
                || requestedAnthropic && "unconfigured".equalsIgnoreCase(profile.getKind());
        String endpoint = blank(profile.getEndpointPath())
                ? defaultEndpoint(profile.getBaseUrl(), anthropic)
                : normalizePath(profile.getEndpointPath());
        return new ProxyTarget(
                stripTrailingSlash(profile.getBaseUrl()), endpoint,
                profile.getApiKey() == null ? "" : profile.getApiKey(), anthropic, profile);
    }

    /** OpenAI-compatible wire format。内部 messages 已由前端完成配对归一化。 */
    private ObjectNode buildOpenAiRequest(JsonNode body, ProxyTarget target) {
        ArrayNode messages = requireMessages(body);
        ObjectNode upstream = objectMapper.createObjectNode();
        upstream.put("model", model(body, target));
        upstream.put("stream", true);
        upstream.set("messages", withSystemPrompt(body, normalizeOpenAiMessages(messages)));
        copyArrayIfPresent(body, upstream, "tools");
        copyIfNumber(body, upstream, "temperature");
        copyIfPresent(body, upstream, "response_format");

        int maxTokens = number(body, "maxTokens", number(body, "max_tokens",
                target.profile() == null ? 8192 : target.profile().getMaxOutputTokens()));
        upstream.put("max_tokens", Math.max(1, maxTokens));

        String effort = text(body, "effort");
        if (!blank(effort)) {
            // DeepSeek V4 等 OpenAI 兼容端点使用 reasoning_effort，
            // 而 Anthropic 的同名语义由 output_config 承载。
            upstream.put("reasoning_effort", effort.trim());
        }
        copyIfPresent(body, upstream, "stream_options");
        return upstream;
    }

    /** Anthropic Messages wire format。 */
    private ObjectNode buildAnthropicRequest(JsonNode body, ProxyTarget target) {
        ArrayNode source = requireMessages(body);
        ObjectNode upstream = objectMapper.createObjectNode();
        upstream.put("model", model(body, target));
        upstream.put("stream", true);
        upstream.put("max_tokens", Math.max(1, number(body, "maxTokens", number(body, "max_tokens",
                target.profile() == null ? 16384 : target.profile().getMaxOutputTokens()))));

        List<String> systemParts = new ArrayList<>();
        String explicitSystem = text(body, "systemPrompt");
        if (!blank(explicitSystem)) systemParts.add(explicitSystem);
        ArrayNode messages = objectMapper.createArrayNode();
        for (JsonNode message : source) {
            String role = text(message, "role");
            if ("system".equalsIgnoreCase(role)) {
                String content = text(message, "content");
                if (!blank(content)) systemParts.add(content);
                continue;
            }
            appendAnthropicMessage(messages, message);
        }
        if (messages.isEmpty()) {
            throw new ResponseStatusException(HttpStatus.BAD_REQUEST, "messages 不能为空");
        }
        if (!systemParts.isEmpty()) upstream.put("system", String.join("\n\n", systemParts));
        upstream.set("messages", messages);

        ArrayNode tools = anthropicTools(body.path("tools"));
        if (!tools.isEmpty()) {
            upstream.set("tools", tools);
            upstream.set("tool_choice", objectMapper.createObjectNode().put("type", "auto"));
        }
        String effort = text(body, "effort");
        if (!blank(effort)) {
            upstream.set("output_config", objectMapper.createObjectNode().put("effort", effort.trim()));
        }
        return upstream;
    }

    private void appendAnthropicMessage(ArrayNode target, JsonNode message) {
        String role = text(message, "role");
        String toolCallId = text(message, "toolCallId");
        if ("tool".equalsIgnoreCase(role) || !blank(toolCallId)) {
            ObjectNode result = objectMapper.createObjectNode();
            result.put("type", "tool_result");
            result.put("tool_use_id", blank(toolCallId) ? "" : toolCallId);
            result.put("content", textOrEmpty(message, "content"));
            appendToolResultBlock(target, result);
            return;
        }

        ObjectNode converted = objectMapper.createObjectNode();
        converted.put("role", "assistant".equalsIgnoreCase(role) ? "assistant" : "user");
        ArrayNode blocks = objectMapper.createArrayNode();
        String content = textOrEmpty(message, "content");
        if (!content.isEmpty()) blocks.add(objectMapper.createObjectNode()
                .put("type", "text").put("text", content));
        JsonNode calls = message.path("toolCalls");
        if (calls.isArray()) {
            for (JsonNode call : calls) {
                String id = textOrEmpty(call, "id");
                String name = text(call.path("function"), "name");
                JsonNode rawArguments = call.path("function").path("arguments");
                JsonNode input = parseObject(rawArguments);
                blocks.add(objectMapper.createObjectNode()
                        .put("type", "tool_use")
                        .put("id", id)
                        .put("name", name == null ? "" : name)
                        .set("input", input));
            }
        }
        if (blocks.isEmpty()) blocks.add(objectMapper.createObjectNode()
                .put("type", "text").put("text", ""));
        converted.set("content", blocks);
        target.add(converted);
    }

    /** Anthropic 要求连续 tool_result 位于同一个 user content 数组。 */
    private void appendToolResultBlock(ArrayNode target, ObjectNode result) {
        if (!target.isEmpty()) {
            JsonNode last = target.get(target.size() - 1);
            if ("user".equals(text(last, "role")) && last.path("content").isArray()) {
                ((ArrayNode) last.path("content")).add(result);
                return;
            }
        }
        target.add(objectMapper.createObjectNode().put("role", "user")
                .set("content", objectMapper.createArrayNode().add(result)));
    }

    private ArrayNode anthropicTools(JsonNode source) {
        ArrayNode result = objectMapper.createArrayNode();
        if (!source.isArray()) return result;
        for (JsonNode tool : source) {
            JsonNode function = tool.path("function");
            if (!function.isObject()) continue;
            ObjectNode converted = objectMapper.createObjectNode()
                    .put("name", textOrEmpty(function, "name"))
                    .put("description", textOrEmpty(function, "description"));
            ObjectNode schema = (ObjectNode) parseObject(function.path("parameters"));
            if (!schema.has("type")) schema.put("type", "object");
            if (!schema.has("properties")) schema.set("properties", objectMapper.createObjectNode());
            converted.set("input_schema", schema);
            if (function.path("defer_loading").asBoolean(false)) converted.put("defer_loading", true);
            if (function.path("strict").asBoolean(false)) converted.put("strict", true);
            result.add(converted);
        }
        return result;
    }

    private ArrayNode requireMessages(JsonNode body) {
        JsonNode value = body.path("messages");
        if (!value.isArray() || value.isEmpty()) {
            throw new ResponseStatusException(HttpStatus.BAD_REQUEST, "messages 不能为空");
        }
        return (ArrayNode) value;
    }

    /**
     * 把内部 camelCase 消息翻译成 OpenAI snake_case wire 格式。
     *
     * <p>前端 agent 层的 Message 用 camelCase（reasoningContent / toolCalls /
     * toolCallId），而 DeepSeek 等上游只认 snake_case（reasoning_content /
     * tool_calls / tool_call_id）。此前直接透传，tool_call_id 缺失被上游判 400
     * （"missing field tool_call_id"），thinking 模型还因缺 reasoning_content 判
     * 400（"must be passed back"）——第二轮续写因此拿到空响应。对照
     * AIGateway DeepSeekProvider.BuildMessages 的字段映射。</p>
     */
    private ArrayNode normalizeOpenAiMessages(ArrayNode source) {
        ArrayNode result = objectMapper.createArrayNode();
        for (JsonNode message : source) {
            ObjectNode converted = objectMapper.createObjectNode();
            String role = text(message, "role");
            converted.put("role", role == null ? "user" : role);
            converted.put("content", textOrEmpty(message, "content"));

            String reasoning = text(message, "reasoningContent");
            if (blank(reasoning)) reasoning = text(message, "reasoning_content");
            if (!blank(reasoning)) converted.put("reasoning_content", reasoning);

            JsonNode calls = message.path("toolCalls");
            if (!calls.isArray()) calls = message.path("tool_calls");
            if (calls.isArray() && !calls.isEmpty()) converted.set("tool_calls", calls);

            String toolCallId = text(message, "toolCallId");
            if (blank(toolCallId)) toolCallId = text(message, "tool_call_id");
            if (!blank(toolCallId)) converted.put("tool_call_id", toolCallId);

            result.add(converted);
        }
        return result;
    }

    private ArrayNode withSystemPrompt(JsonNode body, ArrayNode messages) {
        String system = text(body, "systemPrompt");
        if (blank(system)) return messages;
        ArrayNode result = objectMapper.createArrayNode();
        result.add(objectMapper.createObjectNode().put("role", "system").put("content", system));
        result.addAll(messages);
        return result;
    }

    /** 将 Anthropic SSE 事件投影为前端统一 StreamChunk。 */
    private Flux<ServerSentEvent<String>> normalizeAnthropicStream(Flux<ServerSentEvent<String>> source) {
        AnthropicStreamState state = new AnthropicStreamState();
        return source.concatMap(event -> {
            String data = event.data();
            if (data == null || data.isBlank()) return Flux.empty();
            if ("[DONE]".equals(data.trim())) {
                return Flux.just(chunkEvent("done", objectMapper.createObjectNode().put("type", "done")));
            }
            try {
                JsonNode root = objectMapper.readTree(data);
                List<ObjectNode> chunks = normalizeAnthropicEvent(root, state);
                return Flux.fromIterable(chunks).map(chunk -> chunkEvent(null, chunk));
            } catch (Exception ignored) {
                return Flux.empty();
            }
        });
    }

    private List<ObjectNode> normalizeAnthropicEvent(JsonNode event, AnthropicStreamState state) {
        List<ObjectNode> result = new ArrayList<>();
        String type = text(event, "type");
        if ("message_start".equals(type)) {
            JsonNode usage = event.path("message").path("usage");
            ObjectNode chunk = usageChunk(usage);
            if (chunk != null) result.add(chunk);
        } else if ("content_block_start".equals(type)) {
            JsonNode block = event.path("content_block");
            int index = event.path("index").asInt(0);
            if ("tool_use".equals(text(block, "type"))) {
                String id = textOrEmpty(block, "id");
                state.indexToId.put(index, id);
                // Anthropic uses an empty object as the block-start placeholder;
                // the actual input arrives in input_json_delta events. Do not
                // expose `{}` as a complete call or the frontend may execute
                // before the first real argument delta arrives.
                String initialInput = jsonText(block.path("input"));
                if ("{}".equals(initialInput.trim())) initialInput = "";
                ObjectNode call = toolCall(id, textOrEmpty(block, "name"), initialInput);
                result.add(objectMapper.createObjectNode().put("type", "tool_call")
                        .set("toolCalls", objectMapper.createArrayNode().add(call)));
            } else if ("text".equals(text(block, "type")) && !textOrEmpty(block, "text").isEmpty()) {
                result.add(objectMapper.createObjectNode().put("type", "content").put("content", textOrEmpty(block, "text")));
            } else if ("thinking".equals(text(block, "type")) && !textOrEmpty(block, "thinking").isEmpty()) {
                result.add(objectMapper.createObjectNode().put("type", "reasoning").put("reasoning", textOrEmpty(block, "thinking")));
            }
        } else if ("content_block_delta".equals(type)) {
            JsonNode delta = event.path("delta");
            if (delta.has("text")) {
                result.add(objectMapper.createObjectNode().put("type", "content").put("content", textOrEmpty(delta, "text")));
            } else if (delta.has("thinking")) {
                result.add(objectMapper.createObjectNode().put("type", "reasoning").put("reasoning", textOrEmpty(delta, "thinking")));
            } else if (delta.has("partial_json")) {
                String id = state.indexToId.getOrDefault(event.path("index").asInt(0), "");
                result.add(objectMapper.createObjectNode().put("type", "tool_call")
                        .set("toolCalls", objectMapper.createArrayNode().add(toolCall(id, "", textOrEmpty(delta, "partial_json")))));
            }
        } else if ("message_delta".equals(type)) {
            ObjectNode usage = usageChunk(event.path("usage"));
            String stopReason = text(event.path("delta"), "stop_reason");
            if (usage != null) {
                if (!blank(stopReason)) usage.put("stopReason", stopReason);
                result.add(usage);
            } else if (!blank(stopReason)) {
                result.add(objectMapper.createObjectNode().put("type", "done").put("stopReason", stopReason));
            }
        } else if ("message_stop".equals(type)) {
            result.add(objectMapper.createObjectNode().put("type", "done"));
        }
        return result;
    }

    private ObjectNode usageChunk(JsonNode usage) {
        if (usage == null || !usage.isObject()) return null;
        ObjectNode value = objectMapper.createObjectNode().put("type", "usage");
        ObjectNode normalized = objectMapper.createObjectNode();
        copyNumber(usage, normalized, "input_tokens", "tokensIn");
        copyNumber(usage, normalized, "output_tokens", "tokensOut");
        copyNumber(usage, normalized, "cache_read_input_tokens", "cacheReadTokens");
        copyNumber(usage, normalized, "cache_creation_input_tokens", "cacheCreationTokens");
        if (normalized.isEmpty()) return null;
        value.set("usage", normalized);
        return value;
    }

    private ObjectNode toolCall(String id, String name, String arguments) {
        ObjectNode function = objectMapper.createObjectNode().put("name", name == null ? "" : name)
                .put("arguments", arguments == null ? "" : arguments);
        return objectMapper.createObjectNode().put("id", id == null ? "" : id)
                .put("type", "function").set("function", function);
    }

    private Flux<ServerSentEvent<String>> errorStream(String message) {
        ObjectNode error = objectMapper.createObjectNode().put("type", "error")
                .put("content", message == null || message.isBlank() ? "模型服务请求失败" : message);
        return Flux.just(chunkEvent("error", error));
    }

    private ServerSentEvent<String> chunkEvent(String event, ObjectNode data) {
        ServerSentEvent.Builder<String> builder = ServerSentEvent.builder(writeJson(data));
        return event == null ? builder.build() : builder.event(event).build();
    }

    private String writeJson(JsonNode value) {
        try {
            return objectMapper.writeValueAsString(value);
        } catch (Exception ignored) {
            return "{\"type\":\"error\",\"content\":\"无法序列化模型响应\"}";
        }
    }

    private static boolean isAnthropic(JsonNode body, String provider) {
        String format = text(body, "apiFormat");
        if ("anthropic".equalsIgnoreCase(format)) return true;
        if ("openai".equalsIgnoreCase(format)) return false;
        return provider != null && Set.of("anthropic", "claude", "kimi-code").contains(provider.toLowerCase(Locale.ROOT));
    }

    private static boolean isAnthropicKind(String kind) {
        if (kind == null) return false;
        String value = kind.toLowerCase(Locale.ROOT);
        return value.contains("anthropic") || value.contains("messages");
    }

    private static String defaultEndpoint(String baseUrl, boolean anthropic) {
        String path = URI.create(baseUrl).getPath();
        boolean hasV1 = path != null && (path.equals("/v1") || path.endsWith("/v1"));
        if (anthropic) return hasV1 ? "/messages" : "/v1/messages";
        return hasV1 ? "/chat/completions" : "/v1/chat/completions";
    }

    private static String normalizePath(String path) {
        if (path == null || path.isBlank()) return "/";
        return path.startsWith("/") ? path : "/" + path;
    }

    private static String stripTrailingSlash(String url) {
        String value = url == null ? "" : url.trim();
        while (value.endsWith("/") && value.length() > 1) value = value.substring(0, value.length() - 1);
        return value;
    }

    private String model(JsonNode body, ProxyTarget target) {
        String requested = text(body, "model");
        if (!blank(requested)) return requested;
        return target.profile() == null ? "" : target.profile().getModelId();
    }

    private static void copyArrayIfPresent(JsonNode source, ObjectNode target, String field) {
        if (source.path(field).isArray() && !source.path(field).isEmpty()) target.set(field, source.path(field));
    }

    private static void copyIfPresent(JsonNode source, ObjectNode target, String field) {
        if (source.has(field)) target.set(field, source.path(field));
    }

    private static void copyIfNumber(JsonNode source, ObjectNode target, String field) {
        if (source.path(field).isNumber()) target.set(field, source.path(field));
    }

    private static void copyNumber(JsonNode source, ObjectNode target, String from, String to) {
        if (source.path(from).isNumber()) target.set(to, source.path(from));
    }

    private JsonNode parseObject(JsonNode value) {
        if (value != null && value.isObject()) return value.deepCopy();
        if (value != null && value.isTextual()) {
            try {
                JsonNode parsed = objectMapper.readTree(value.asText());
                if (parsed != null && parsed.isObject()) return parsed;
            } catch (Exception ignored) { }
        }
        return objectMapper.createObjectNode();
    }

    private String jsonText(JsonNode value) {
        return value == null || value.isNull() ? "" : value.isTextual() ? value.asText() : value.toString();
    }

    private static String text(JsonNode node, String field) {
        if (node == null) return null;
        JsonNode value = node.path(field);
        return value.isTextual() ? value.asText() : null;
    }

    private static String textOrEmpty(JsonNode node, String field) {
        String value = text(node, field);
        return value == null ? "" : value;
    }

    private static int number(JsonNode node, String field, int fallback) {
        return node.path(field).isNumber() ? node.path(field).asInt() : fallback;
    }

    private static boolean blank(String value) { return value == null || value.isBlank(); }

    private static String messageOf(Throwable error) {
        if (error instanceof ProviderProxyException provider && !provider.getMessage().isBlank()) {
            return provider.getMessage();
        }
        if (error instanceof ResponseStatusException response && response.getReason() != null) {
            return response.getReason();
        }
        String value = error.getMessage();
        return value == null || value.isBlank() ? "模型服务请求失败" : value;
    }

    private static boolean isCancellation(Throwable error) {
        return error instanceof java.util.concurrent.CancellationException
                || error instanceof java.io.EOFException
                || error.getCause() instanceof java.util.concurrent.CancellationException;
    }

    private static String safeProviderError(String body) {
        if (body == null || body.isBlank()) return "模型服务拒绝了请求";
        String value = body.replaceAll("[\\p{Cntrl}&&[^\\r\\n\\t]]", "").trim();
        try {
            JsonNode json = new ObjectMapper().readTree(value);
            String message = json.path("error").path("message").asText(null);
            if (message == null || message.isBlank()) message = json.path("message").asText(null);
            if (message != null && !message.isBlank()) value = message;
        } catch (Exception ignored) { }
        return value.length() <= 1200 ? value : value.substring(0, 1200) + "…";
    }

    private record ProxyTarget(
            String baseUrl,
            String endpointPath,
            String apiKey,
            boolean anthropic,
            com.iris.gateway.model.ModelGatewayProperties.Profile profile
    ) { }

    private static final class ProviderProxyException extends RuntimeException {
        private ProviderProxyException(int status, String message) {
            super("Provider " + status + ": " + message);
        }
    }

    private static final class AnthropicStreamState {
        private final Map<Integer, String> indexToId = new HashMap<>();
    }
}
