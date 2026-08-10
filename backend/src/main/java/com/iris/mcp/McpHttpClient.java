package com.iris.mcp;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.node.ObjectNode;
import org.springframework.stereotype.Component;

import java.io.IOException;
import java.net.URI;
import java.net.http.HttpClient;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;
import java.time.Duration;
import java.util.ArrayList;
import java.util.List;
import java.util.Locale;
import java.util.Optional;
import java.util.concurrent.atomic.AtomicLong;

/** Minimal, stateful MCP Streamable HTTP client owned by the Iris runtime. */
@Component
public class McpHttpClient {
    private static final String PROTOCOL_VERSION = "2025-06-18";
    private static final int MAX_TOOL_PAGES = 20;

    private final ObjectMapper objectMapper;
    private final HttpClient http;
    private final AtomicLong requestIds = new AtomicLong();

    public McpHttpClient(ObjectMapper objectMapper) {
        this.objectMapper = objectMapper;
        this.http = HttpClient.newBuilder()
                .connectTimeout(Duration.ofSeconds(10))
                .followRedirects(HttpClient.Redirect.NEVER)
                .build();
    }

    public Discovery connect(String endpoint, String bearerToken)
            throws IOException, InterruptedException {
        URI uri = endpoint(endpoint);
        ObjectNode params = objectMapper.createObjectNode();
        params.put("protocolVersion", PROTOCOL_VERSION);
        params.set("capabilities", objectMapper.createObjectNode());
        ObjectNode clientInfo = params.putObject("clientInfo");
        clientInfo.put("name", "Iris");
        clientInfo.put("version", "0.1.0");

        RpcResponse initialize = request(
                uri, bearerToken, null, "initialize", params
        );
        JsonNode initialized = initialize.result();
        String negotiated = initialized.path("protocolVersion")
                .asText(PROTOCOL_VERSION);
        String sessionId = initialize.sessionId().orElse(null);
        notifyInitialized(uri, bearerToken, sessionId);

        List<JsonNode> tools = new ArrayList<>();
        String cursor = null;
        for (int page = 0; page < MAX_TOOL_PAGES; page++) {
            ObjectNode listParams = objectMapper.createObjectNode();
            if (cursor != null && !cursor.isBlank()) {
                listParams.put("cursor", cursor);
            }
            RpcResponse response = request(
                    uri, bearerToken, sessionId, "tools/list", listParams
            );
            response.result().path("tools").forEach(tools::add);
            cursor = response.result().path("nextCursor").asText(null);
            if (cursor == null || cursor.isBlank()) {
                break;
            }
        }
        JsonNode serverInfo = initialized.path("serverInfo");
        return new Discovery(
                negotiated,
                serverInfo.path("name").asText(null),
                serverInfo.path("version").asText(null),
                initialized.path("instructions").asText(null),
                sessionId,
                List.copyOf(tools)
        );
    }

    public JsonNode call(
            String endpoint,
            String bearerToken,
            String sessionId,
            String remoteToolName,
            JsonNode arguments
    ) throws IOException, InterruptedException {
        ObjectNode params = objectMapper.createObjectNode();
        params.put("name", remoteToolName);
        params.set(
                "arguments",
                arguments == null || arguments.isNull()
                        ? objectMapper.createObjectNode()
                        : arguments
        );
        return request(
                endpoint(endpoint), bearerToken, sessionId,
                "tools/call", params
        ).result();
    }

    private RpcResponse request(
            URI endpoint,
            String bearerToken,
            String sessionId,
            String method,
            JsonNode params
    ) throws IOException, InterruptedException {
        long id = requestIds.incrementAndGet();
        ObjectNode body = objectMapper.createObjectNode();
        body.put("jsonrpc", "2.0");
        body.put("id", id);
        body.put("method", method);
        body.set("params", params);
        HttpResponse<String> response = send(
                endpoint, bearerToken, sessionId, body
        );
        JsonNode envelope = parseEnvelope(response.body());
        if (envelope.has("error")) {
            JsonNode error = envelope.path("error");
            throw new McpProtocolException(
                    error.path("code").asText("mcp_error"),
                    error.path("message").asText("MCP request failed")
            );
        }
        if (!envelope.has("result")) {
            throw new McpProtocolException(
                    "invalid_response", "MCP response has no result"
            );
        }
        return new RpcResponse(
                envelope.path("result"),
                response.headers().firstValue("Mcp-Session-Id")
        );
    }

    private void notifyInitialized(
            URI endpoint,
            String bearerToken,
            String sessionId
    ) throws IOException, InterruptedException {
        ObjectNode body = objectMapper.createObjectNode();
        body.put("jsonrpc", "2.0");
        body.put("method", "notifications/initialized");
        body.set("params", objectMapper.createObjectNode());
        send(endpoint, bearerToken, sessionId, body);
    }

    private HttpResponse<String> send(
            URI endpoint,
            String bearerToken,
            String sessionId,
            JsonNode body
    ) throws IOException, InterruptedException {
        HttpRequest.Builder builder = HttpRequest.newBuilder(endpoint)
                .timeout(Duration.ofSeconds(45))
                .header("Content-Type", "application/json")
                .header("Accept", "application/json, text/event-stream")
                .POST(HttpRequest.BodyPublishers.ofString(
                        objectMapper.writeValueAsString(body)
                ));
        if (bearerToken != null && !bearerToken.isBlank()) {
            builder.header("Authorization", "Bearer " + bearerToken);
        }
        if (sessionId != null && !sessionId.isBlank()) {
            builder.header("Mcp-Session-Id", sessionId);
        }
        HttpResponse<String> response = http.send(
                builder.build(), HttpResponse.BodyHandlers.ofString()
        );
        if (response.statusCode() < 200 || response.statusCode() >= 300) {
            throw new McpProtocolException(
                    "http_" + response.statusCode(),
                    "MCP endpoint returned HTTP " + response.statusCode()
            );
        }
        return response;
    }

    private JsonNode parseEnvelope(String body) throws IOException {
        if (body == null || body.isBlank()) {
            throw new McpProtocolException(
                    "empty_response", "MCP endpoint returned an empty response"
            );
        }
        String trimmed = body.trim();
        if (!trimmed.startsWith("data:")
                && !trimmed.contains("\ndata:")) {
            return objectMapper.readTree(trimmed);
        }
        String candidate = null;
        for (String line : trimmed.split("\\R")) {
            if (line.startsWith("data:")) {
                String value = line.substring(5).trim();
                if (!value.isBlank()) {
                    candidate = value;
                }
            }
        }
        if (candidate == null) {
            throw new McpProtocolException(
                    "empty_sse", "MCP event stream contained no JSON data"
            );
        }
        return objectMapper.readTree(candidate);
    }

    private URI endpoint(String value) {
        try {
            URI uri = URI.create(value);
            String scheme = uri.getScheme() == null
                    ? "" : uri.getScheme().toLowerCase(Locale.ROOT);
            if (!("http".equals(scheme) || "https".equals(scheme))
                    || uri.getHost() == null || uri.getUserInfo() != null) {
                throw new IllegalArgumentException(
                        "MCP endpoint must be an http(s) URL without user info"
                );
            }
            return uri;
        } catch (IllegalArgumentException exception) {
            throw new IllegalArgumentException(
                    "Invalid MCP endpoint", exception
            );
        }
    }

    private record RpcResponse(
            JsonNode result,
            Optional<String> sessionId
    ) { }

    public record Discovery(
            String protocolVersion,
            String serverName,
            String serverVersion,
            String instructions,
            String sessionId,
            List<JsonNode> tools
    ) { }

    public static class McpProtocolException extends IOException {
        private final String code;

        public McpProtocolException(String code, String message) {
            super(message);
            this.code = code;
        }

        public String code() {
            return code;
        }
    }
}
