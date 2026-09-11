package com.iris.gateway.model;

import com.fasterxml.jackson.databind.JsonNode;
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

/**
 * A credential/CORS transport, not an Agent service. The request body is authored by the
 * Frontend Runtime and provider SSE data is relayed without semantic projection.
 */
@RestController
@RequestMapping("/api/v1")
public class ModelGatewayController {
    private final ModelGatewayProfileCatalog catalog;
    private final WebClient.Builder clients;

    public ModelGatewayController(ModelGatewayProfileCatalog catalog, WebClient.Builder clients) {
        this.catalog = catalog;
        this.clients = clients;
    }

    @PostMapping(value = "/model-gateway/chat/completions", produces = MediaType.TEXT_EVENT_STREAM_VALUE)
    public Flux<ServerSentEvent<String>> stream(@RequestBody ObjectNode request) {
        ModelGatewayProperties.Profile profile;
        try {
            profile = catalog.activeProfile();
        } catch (IllegalStateException unconfigured) {
            return Flux.error(new ResponseStatusException(
                    HttpStatus.SERVICE_UNAVAILABLE, unconfigured.getMessage()));
        }
        requireFrontendOwnedRequest(request, profile);
        return clients.baseUrl(profile.getBaseUrl())
                .defaultHeader(HttpHeaders.AUTHORIZATION, "Bearer " + profile.getApiKey())
                .build()
                .post()
                .uri(profile.getEndpointPath())
                .contentType(MediaType.APPLICATION_JSON)
                .accept(MediaType.TEXT_EVENT_STREAM)
                .bodyValue(request)
                .retrieve()
                .onStatus(
                        status -> status.isError(),
                        response -> response.bodyToMono(String.class)
                                .defaultIfEmpty("")
                                .map(body -> new ResponseStatusException(
                                        response.statusCode(), safeProviderError(body)))
                )
                .bodyToFlux(new org.springframework.core.ParameterizedTypeReference<ServerSentEvent<String>>() { })
                .timeout(Duration.ofSeconds(profile.getTimeoutSeconds()));
    }

    private void requireFrontendOwnedRequest(ObjectNode request, ModelGatewayProperties.Profile profile) {
        if (!request.path("messages").isArray() || request.path("messages").isEmpty()) {
            throw new ResponseStatusException(HttpStatus.BAD_REQUEST, "messages 不能为空");
        }
        request.put("model", profile.getModelId());
        request.put("stream", true);
        int requested = request.path("max_tokens").asInt(profile.getMaxOutputTokens());
        request.put("max_tokens", Math.min(Math.max(requested, 1), profile.getMaxOutputTokens()));
    }

    private String safeProviderError(String body) {
        if (body == null || body.isBlank()) return "模型服务拒绝了请求";
        String value = body.replaceAll("[\\p{Cntrl}&&[^\\r\\n\\t]]", "").trim();
        return value.length() <= 1000 ? value : value.substring(0, 1000);
    }

}
