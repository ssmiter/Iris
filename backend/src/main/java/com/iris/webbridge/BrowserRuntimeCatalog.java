package com.iris.webbridge;

import com.iris.tools.core.ToolRuntimeException;
import org.springframework.stereotype.Component;

import java.net.URI;
import java.util.Comparator;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Optional;
import java.util.regex.Pattern;

/**
 * 稳定 Runtime Definition 到本机 Connector binding 的目录。
 */
@Component
public class BrowserRuntimeCatalog {

    private static final Pattern ID =
            Pattern.compile("[a-z][a-z0-9]*(?:[_-][a-z0-9]+)*");

    private final Map<String, Binding> bindings;

    public BrowserRuntimeCatalog(IrisWebBridgeProperties properties) {
        Map<String, Binding> accepted = new LinkedHashMap<>();
        properties.getRuntimes().entrySet().stream()
                .sorted(Map.Entry.comparingByKey())
                .forEach(entry -> {
                    String id = entry.getKey();
                    IrisWebBridgeProperties.RuntimeSettings settings =
                            entry.getValue();
                    Binding binding = requireValid(id, settings);
                    accepted.put(id, binding);
                });
        this.bindings = Map.copyOf(accepted);
    }

    public List<Definition> definitions() {
        return bindings.values().stream()
                .map(Binding::definition)
                .sorted(Comparator.comparing(Definition::id))
                .toList();
    }

    public Optional<Binding> find(String runtimeId) {
        return Optional.ofNullable(bindings.get(runtimeId));
    }

    public Binding require(String runtimeId) {
        return find(runtimeId).orElseThrow(() ->
                new ToolRuntimeException(
                        "browser_runtime_not_found",
                        "找不到 Browser Runtime " + runtimeId
                                + "；先调用 list_browser_runtimes 查看可用对象"
                ));
    }

    private Binding requireValid(
            String id,
            IrisWebBridgeProperties.RuntimeSettings settings
    ) {
        if (id == null || !ID.matcher(id).matches()
                || settings == null
                || blank(settings.getTitle())
                || blank(settings.getDescription())
                || blank(settings.getBaseUrl())
                || blank(settings.getToken())
                || settings.getProtocolVersion() < 1) {
            throw new IllegalStateException(
                    "Browser Runtime binding is incomplete: " + id
            );
        }
        URI endpoint = URI.create(settings.getBaseUrl());
        if (!"http".equalsIgnoreCase(endpoint.getScheme())
                || endpoint.getHost() == null
                || !endpoint.getHost().equals("127.0.0.1")
                || endpoint.getUserInfo() != null
                || endpoint.getQuery() != null
                || endpoint.getFragment() != null) {
            throw new IllegalStateException(
                    "Browser Runtime must use a clean http://127.0.0.1 endpoint: "
                            + id
            );
        }
        String normalized = endpoint.toString().replaceAll("/+$", "");
        return new Binding(
                new Definition(
                        id,
                        settings.getTitle().trim(),
                        settings.getDescription().trim(),
                        settings.getProtocolVersion()
                ),
                URI.create(normalized),
                settings.getToken()
        );
    }

    private boolean blank(String value) {
        return value == null || value.isBlank();
    }

    public record Definition(
            String id,
            String title,
            String description,
            int protocolVersion
    ) {
    }

    public record Binding(
            Definition definition,
            URI endpoint,
            String token
    ) {
    }
}
