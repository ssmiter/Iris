package com.iris.agent.model.provider;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.node.ArrayNode;
import com.fasterxml.jackson.databind.node.ObjectNode;
import com.iris.agent.model.ModelRequest;
import com.iris.agent.model.ModelProtocolException;
import com.iris.agent.model.ModelStreamEvent;
import com.iris.agent.model.ModelStreamEvent.FragmentMode;
import com.iris.agent.model.provider.ProviderMessageCompiler.CompiledConversation;
import com.iris.agent.model.provider.ProviderMessageCompiler.ProviderMessage;
import com.iris.agent.model.provider.ProviderMessageCompiler.ProviderStatePart;
import com.iris.agent.model.provider.ProviderMessageCompiler.TextPart;
import com.iris.agent.model.provider.ProviderMessageCompiler.ToolCallPart;
import com.iris.agent.model.provider.ProviderMessageCompiler.ToolResultPart;
import com.iris.agent.model.provider.IrisModelProperties.Profile;
import org.springframework.core.ParameterizedTypeReference;
import org.springframework.http.HttpHeaders;
import org.springframework.http.HttpStatusCode;
import org.springframework.http.MediaType;
import org.springframework.http.codec.ServerSentEvent;
import org.springframework.web.reactive.function.client.WebClient;
import org.springframework.web.reactive.function.client.WebClientRequestException;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import reactor.core.publisher.Flux;
import reactor.core.publisher.Mono;

import java.net.URI;
import java.time.Duration;
import java.time.Instant;
import java.time.ZonedDateTime;
import java.time.format.DateTimeFormatter;
import java.time.format.DateTimeParseException;
import java.util.ArrayList;
import java.util.List;

/**
 * 一个 profile 一个实例，由 {@link ModelProviderConfiguration} 按
 * {@code iris.model.profiles} 逐个构造并登记进 {@link ModelProviderRegistry}。
 */
public class OpenAiCompatibleModelProvider implements ModelProvider {
    private static final Logger LOGGER = LoggerFactory.getLogger(
            OpenAiCompatibleModelProvider.class
    );
    private static final int MAX_PROVIDER_ERROR_CHARACTERS = 2_000;
    private static final ParameterizedTypeReference<ServerSentEvent<String>>
            SSE_TYPE = new ParameterizedTypeReference<>() {
            };

    private final String profileId;
    private final Profile profile;
    private final ProviderMessageCompiler compiler;
    private final ObjectMapper objectMapper;
    private final WebClient client;

    public OpenAiCompatibleModelProvider(
            String profileId,
            Profile profile,
            ProviderMessageCompiler compiler,
            ObjectMapper objectMapper,
            WebClient.Builder webClient
    ) {
        validate(profileId, profile);
        this.profileId = profileId;
        this.profile = profile;
        this.compiler = compiler;
        this.objectMapper = objectMapper;
        this.client = webClient
                .baseUrl(profile.getBaseUrl())
                .defaultHeader(
                        HttpHeaders.AUTHORIZATION,
                        "Bearer " + profile.getApiKey()
                )
                .build();
    }

    @Override
    public String profileId() {
        return profileId;
    }

    @Override
    public String providerKind() {
        return "openai-compatible";
    }

    @Override
    public String modelId() {
        return profile.getModelId();
    }

    @Override
    public String effort() {
        return profile.effectiveEffort();
    }

    @Override
    public int maxOutputTokens() {
        return profile.getMaxOutputTokens();
    }

    @Override
    public Duration timeout() {
        return Duration.ofSeconds(profile.getTimeoutSeconds());
    }

    @Override
    public Flux<ModelStreamEvent> stream(ModelRequest request) {
        if (!request.modelId().equals(modelId())) {
            return Flux.error(new ModelProviderException(
                    "model_profile_mismatch",
                    false,
                    "Model request does not match the configured profile"
            ));
        }
        return Flux.defer(() -> {
            OpenAiCompatibleStreamMapper mapper =
                    new OpenAiCompatibleStreamMapper(
                            profile.isCumulativeToolArguments()
                                    ? FragmentMode.CUMULATIVE
                                    : FragmentMode.APPEND
                    );
            ObjectNode body = requestBody(compiler.compile(request));
            return client.post()
                    .uri(profile.getEndpointPath())
                    .contentType(MediaType.APPLICATION_JSON)
                    .accept(MediaType.TEXT_EVENT_STREAM)
                    .bodyValue(body)
                    .retrieve()
                    .onStatus(
                            HttpStatusCode::isError,
                            response -> {
                                String retryAfter = response.headers()
                                        .asHttpHeaders()
                                        .getFirst(HttpHeaders.RETRY_AFTER);
                                return response.bodyToMono(String.class)
                                    .defaultIfEmpty("")
                                    .onErrorReturn("")
                                    .map(responseBody -> providerHttpError(
                                            response.statusCode(),
                                            responseBody,
                                            retryAfter
                                    ));
                            }
                    )
                    .bodyToFlux(SSE_TYPE)
                    .flatMapIterable(event -> mapEvent(mapper, event.data()))
                    .onErrorMap(this::normalizeStreamError);
        });
    }

    private Throwable normalizeStreamError(Throwable error) {
        if (error instanceof ModelProviderException
                || error instanceof ModelProtocolException) {
            return error;
        }
        if (error instanceof WebClientRequestException) {
            return new ModelProviderException(
                    "provider_unavailable",
                    true,
                    "Model provider connection failed"
            );
        }
        return new ModelProviderException(
                "provider_stream_failed",
                false,
                "Model provider stream could not be decoded"
        );
    }

    private List<ModelStreamEvent> mapEvent(
            OpenAiCompatibleStreamMapper mapper,
            String data
    ) {
        if (data == null || data.isBlank()) {
            return List.of();
        }
        if ("[DONE]".equals(data.trim())) {
            return mapper.finish();
        }
        try {
            return mapper.map(objectMapper.readTree(data));
        } catch (ModelProtocolException exception) {
            throw exception;
        } catch (ModelProviderException exception) {
            throw exception;
        } catch (Exception exception) {
            throw new ModelProviderException(
                    "provider_payload_invalid",
                    false,
                    "Model provider returned an invalid stream event"
            );
        }
    }

    private ObjectNode requestBody(CompiledConversation conversation) {
        ObjectNode body = objectMapper.createObjectNode();
        body.put("model", modelId());
        body.put("stream", true);
        body.put("max_tokens", profile.getMaxOutputTokens());
        body.putObject("stream_options").put("include_usage", true);
        // 显式设档才带 reasoning_effort：缺省（等同 medium）时请求体与
        // 引入 effort 前一致。effort 是请求标量，变更即 provider 前缀缓存
        // 分叉——docs/42 §5.2 的请求快照落地时必须把它纳入归因。
        String effort = profile.getEffort();
        if (effort != null && !effort.isBlank()) {
            body.put("reasoning_effort", profile.effectiveEffort());
        }
        ArrayNode messages = body.putArray("messages");
        for (ProviderMessage message : conversation.messages()) {
            messages.add(serializeMessage(message));
        }
        if (!conversation.tools().isEmpty()) {
            ArrayNode tools = body.putArray("tools");
            for (ModelRequest.ToolDefinition definition
                    : conversation.tools()) {
                ObjectNode function = tools.addObject()
                        .put("type", "function")
                        .putObject("function");
                function.put("name", definition.name());
                function.put("description", definition.description());
                function.set("parameters", definition.inputSchema());
            }
        }
        return body;
    }

    private ObjectNode serializeMessage(ProviderMessage message) {
        ObjectNode serialized = objectMapper.createObjectNode();
        serialized.put("role", switch (message.role()) {
            case SYSTEM -> "system";
            case USER -> "user";
            case ASSISTANT -> "assistant";
            case TOOL -> "tool";
        });
        List<String> texts = new ArrayList<>();
        ArrayNode toolCalls = objectMapper.createArrayNode();
        ToolResultPart result = null;
        ProviderStatePart providerState = null;
        for (ProviderMessageCompiler.MessagePart part : message.parts()) {
            if (part instanceof TextPart text) {
                texts.add(text.text());
            } else if (part instanceof ProviderStatePart state) {
                if (providerState != null
                        && !providerState.equals(state)) {
                    throw new ModelProtocolException(
                            "provider_state_conflict",
                            "Assistant message contains conflicting provider state"
                    );
                }
                providerState = state;
            } else if (part instanceof ToolCallPart call) {
                ObjectNode item = toolCalls.addObject();
                item.put("id", call.providerCallId());
                item.put("type", "function");
                ObjectNode function = item.putObject("function");
                function.put("name", call.name());
                function.put("arguments", call.arguments().toString());
            } else if (part instanceof ToolResultPart toolResult) {
                result = toolResult;
            }
        }
        if (result != null) {
            serialized.put("tool_call_id", result.providerCallId());
            serialized.put("content", result.content().toString());
            return serialized;
        }
        serialized.put("content", String.join("\n", texts));
        if (!toolCalls.isEmpty()) {
            serialized.set("tool_calls", toolCalls);
            if (providerState != null) {
                if (!"reasoning_content".equals(
                        providerState.stateKey()
                )) {
                    throw new ModelProtocolException(
                            "openai_provider_state_unsupported",
                            "OpenAI-compatible provider state is unsupported"
                    );
                }
                serialized.put(
                        "reasoning_content",
                        providerState.content()
                );
            }
        }
        return serialized;
    }

    private ModelProviderException providerHttpError(
            HttpStatusCode status,
            String responseBody,
            String retryAfterHeader
    ) {
        int code = status.value();
        String category = switch (code) {
            case 401, 403 -> "provider_auth_failed";
            case 408 -> "provider_timeout";
            case 429 -> "provider_rate_limited";
            case 413 -> "prompt_too_large";
            default -> code >= 500
                    ? "provider_unavailable"
                    : "provider_request_rejected";
        };
        boolean retryable = code == 408 || code == 429 || code >= 500;
        ProviderErrorDetail detail = providerErrorDetail(responseBody);
        LOGGER.warn(
                "Model provider rejected request: status={}, category={}, "
                        + "providerCode={}, providerType={}, detail={}",
                code,
                category,
                detail.code(),
                detail.type(),
                detail.message()
        );
        return new ModelProviderException(
                category,
                retryable,
                "Model provider request failed with HTTP " + code,
                code,
                detail.code(),
                detail.type(),
                detail.message(),
                retryAfter(retryAfterHeader)
        );
    }

    private Duration retryAfter(String header) {
        if (header == null || header.isBlank()) {
            return null;
        }
        String value = header.trim();
        try {
            long seconds = Long.parseLong(value);
            return seconds < 0 ? null : Duration.ofSeconds(seconds);
        } catch (NumberFormatException ignored) {
            try {
                Instant retryAt = ZonedDateTime.parse(
                        value,
                        DateTimeFormatter.RFC_1123_DATE_TIME
                ).toInstant();
                Duration wait = Duration.between(Instant.now(), retryAt);
                return wait.isNegative() ? Duration.ZERO : wait;
            } catch (DateTimeParseException invalidDate) {
                return null;
            }
        }
    }

    private ProviderErrorDetail providerErrorDetail(String responseBody) {
        if (responseBody == null || responseBody.isBlank()) {
            return new ProviderErrorDetail(null, null, null);
        }
        try {
            JsonNode root = objectMapper.readTree(responseBody);
            JsonNode error = root.path("error");
            if (!error.isObject()) {
                return new ProviderErrorDetail(
                        scalar(root.get("code")),
                        scalar(root.get("type")),
                        bounded(scalar(root.get("message")))
                );
            }
            return new ProviderErrorDetail(
                    scalar(error.get("code")),
                    scalar(error.get("type")),
                    bounded(scalar(error.get("message")))
            );
        } catch (Exception ignored) {
            return new ProviderErrorDetail(
                    null,
                    null,
                    "Provider returned a non-JSON error body"
            );
        }
    }

    private String scalar(JsonNode value) {
        if (value == null || value.isNull() || value.isContainerNode()) {
            return null;
        }
        return bounded(value.asText());
    }

    private String bounded(String value) {
        if (value == null) {
            return null;
        }
        String sanitized = value.replaceAll("[\\p{Cntrl}&&[^\\r\\n\\t]]", "")
                .trim();
        return sanitized.length() <= MAX_PROVIDER_ERROR_CHARACTERS
                ? sanitized
                : sanitized.substring(0, MAX_PROVIDER_ERROR_CHARACTERS);
    }

    private void validate(String profileId, Profile profile) {
        if (blank(profileId)
                || blank(profile.getModelId())
                || blank(profile.getBaseUrl())
                || blank(profile.getApiKey())
                || profile.getTimeoutSeconds() < 1
                || profile.getTimeoutSeconds() > 1800
                || profile.getMaxOutputTokens() < 1) {
            throw new IllegalStateException(
                    "OpenAI-compatible provider profile is incomplete: "
                            + profileId
            );
        }
        URI uri = URI.create(profile.getBaseUrl());
        boolean localHttp = "http".equalsIgnoreCase(uri.getScheme())
                && ("localhost".equalsIgnoreCase(uri.getHost())
                || "127.0.0.1".equals(uri.getHost()));
        if (!"https".equalsIgnoreCase(uri.getScheme()) && !localHttp) {
            throw new IllegalStateException(
                    "Model provider base URL must use HTTPS or local HTTP"
            );
        }
        if (!profile.getEndpointPath().startsWith("/")
                || profile.getEndpointPath().contains("..")) {
            throw new IllegalStateException(
                    "Model provider endpoint path is invalid"
            );
        }
    }

    private boolean blank(String value) {
        return value == null || value.isBlank();
    }

    private record ProviderErrorDetail(
            String code,
            String type,
            String message
    ) {
    }
}
