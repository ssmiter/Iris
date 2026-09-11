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

import java.time.Duration;
import java.net.URI;

/**
 * 模型流透明代理（WonWork 契约 /api/chat/proxy，docs/46）。
 *
 * <p>纯转发，不编排：接收前端 Runtime 已组装好的 OpenAI 风格请求
 * （messages/tools/systemPrompt/maxTokens），翻译为上游 chat/completions
 * 调用，SSE 原样回灌。不做工具执行、不决定续轮、不改写消息语义。</p>
 *
 * <p>凭证：请求可携带 apiKey/baseUrl（前端持有的 provider 配置）；
 * 缺省时回落到激活的 model-gateway profile。</p>
 */
@RestController
@RequestMapping("/api/chat")
public class ChatProxyController {

    private static final Duration TIMEOUT = Duration.ofSeconds(180);

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
        ProxyTarget target;
        try {
            target = resolveTarget(body);
        } catch (IllegalStateException unconfigured) {
            return Flux.error(new ResponseStatusException(
                    HttpStatus.SERVICE_UNAVAILABLE, unconfigured.getMessage()));
        }

        ObjectNode upstream = buildUpstreamRequest(body, target);

        return clients.baseUrl(target.baseUrl())
                .defaultHeader(HttpHeaders.AUTHORIZATION, "Bearer " + target.apiKey())
                .build()
                .post()
                .uri(target.endpointPath())
                .contentType(MediaType.APPLICATION_JSON)
                .accept(MediaType.TEXT_EVENT_STREAM)
                .bodyValue(upstream)
                .retrieve()
                .onStatus(
                        status -> status.isError(),
                        response -> response.bodyToMono(String.class)
                                .defaultIfEmpty("")
                                .map(errorBody -> new ResponseStatusException(
                                        response.statusCode(), safeProviderError(errorBody)))
                )
                .bodyToFlux(new org.springframework.core.ParameterizedTypeReference<ServerSentEvent<String>>() { })
                .timeout(TIMEOUT);
    }

    /** 凭证来源：请求自带 apiKey/baseUrl 优先；否则用激活 profile。 */
    private ProxyTarget resolveTarget(JsonNode body) {
        String reqApiKey = text(body, "apiKey");
        String reqBaseUrl = text(body, "baseUrl");
        if (reqApiKey != null && !reqApiKey.isBlank() && reqBaseUrl != null && !reqBaseUrl.isBlank()) {
            // endpointPath 由请求可配（前端 provider 定义）。多数预设把 baseUrl
            // 写成服务根地址，少数把 /v1 写进 baseUrl，因此按路径补齐一次。
            String reqEndpoint = text(body, "endpointPath");
            String basePath = URI.create(reqBaseUrl).getPath();
            boolean baseIncludesV1 = basePath != null
                    && (basePath.equals("/v1") || basePath.endsWith("/v1"));
            String endpointPath = (reqEndpoint != null && !reqEndpoint.isBlank())
                    ? reqEndpoint
                    : (baseIncludesV1 ? "/chat/completions" : "/v1/chat/completions");
            return new ProxyTarget(stripTrailingSlash(reqBaseUrl), endpointPath, reqApiKey, null);
        }
        var profile = catalog.activeProfile(); // 未配置时抛 IllegalStateException
        return new ProxyTarget(profile.getBaseUrl(), profile.getEndpointPath(), profile.getApiKey(), profile);
    }

    /** 把 WonWork ChatRequest 翻译为上游 OpenAI 风格请求体。 */
    private ObjectNode buildUpstreamRequest(JsonNode body, ProxyTarget target) {
        ObjectNode upstream = objectMapper.createObjectNode();

        String model = text(body, "model");
        if (model == null || model.isBlank()) {
            model = target.profile() != null ? target.profile().getModelId() : "";
        }
        upstream.put("model", model);
        upstream.put("stream", true);

        // messages：前端已组装；systemPrompt prepend 为 system 消息（对齐 WonWork ChatProxyService 语义）。
        ArrayNode messages = objectMapper.createArrayNode();
        String systemPrompt = text(body, "systemPrompt");
        if (systemPrompt != null && !systemPrompt.isBlank()) {
            ObjectNode sys = objectMapper.createObjectNode();
            sys.put("role", "system");
            sys.put("content", systemPrompt);
            messages.add(sys);
        }
        JsonNode reqMessages = body.path("messages");
        if (!reqMessages.isArray() || reqMessages.isEmpty()) {
            throw new ResponseStatusException(HttpStatus.BAD_REQUEST, "messages 不能为空");
        }
        reqMessages.forEach(messages::add);
        upstream.set("messages", messages);

        // tools 透传（前端 Runtime 下放的工具定义）。
        if (body.path("tools").isArray() && !body.path("tools").isEmpty()) {
            upstream.set("tools", body.path("tools"));
        }

        int maxTokens = body.path("maxTokens").isInt()
                ? body.path("maxTokens").asInt()
                : (target.profile() != null ? target.profile().getMaxOutputTokens() : 8192);
        upstream.put("max_tokens", maxTokens);

        return upstream;
    }

    private String safeProviderError(String body) {
        if (body == null || body.isBlank()) return "模型服务拒绝了请求";
        return body.replaceAll("[\\p{Cntrl}&&[^\\r\\n\\t]]", "").trim();
    }

    private String text(JsonNode node, String field) {
        JsonNode v = node.path(field);
        return v.isTextual() ? v.asText() : null;
    }

    private String stripTrailingSlash(String url) {
        return url.endsWith("/") ? url.substring(0, url.length() - 1) : url;
    }

    private record ProxyTarget(
            String baseUrl,
            String endpointPath,
            String apiKey,
            com.iris.gateway.model.ModelGatewayProperties.Profile profile
    ) { }
}
