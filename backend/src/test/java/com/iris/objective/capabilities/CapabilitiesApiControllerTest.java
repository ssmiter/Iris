package com.iris.objective.capabilities;

import com.fasterxml.jackson.databind.node.JsonNodeFactory;
import com.iris.tools.catalog.CapabilityService;
import com.iris.tools.catalog.CapabilityService.CapabilityNode;
import com.iris.tools.core.RiskLevel;
import com.iris.tools.core.Tool;
import com.iris.tools.core.ToolManifest;
import com.iris.tools.core.ToolRegistry.ToolBinding;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.params.ParameterizedTest;
import org.junit.jupiter.params.provider.NullAndEmptySource;
import org.junit.jupiter.params.provider.ValueSource;
import org.springframework.test.web.reactive.server.WebTestClient;

import java.util.List;
import java.util.Optional;

import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.when;

class CapabilitiesApiControllerTest {

    private static final String PATH = "/sample/sample_read";

    @Test
    void exposesOnlyPublicPromptInSchemaAndInitialCatalog() {
        WebTestClient client = client("  Read the smallest relevant range first.  ");
        String prompt = "Read the smallest relevant range first.";
        var fields = java.util.Set.of(
                "description", "loadStrategy", "name", "parameters", "path", "prompt", "riskLevel", "tier"
        );

        client.get().uri("/api/capabilities/schema?path=" + PATH)
                .exchange().expectStatus().isOk().expectBody()
                .jsonPath("$.prompt").isEqualTo(prompt)
                .jsonPath("$.parameters.type").isEqualTo("object")
                .jsonPath("$").value(value -> org.junit.jupiter.api.Assertions.assertEquals(
                        fields, ((java.util.Map<?, ?>) value).keySet()));

        client.get().uri("/api/capabilities")
                .exchange().expectStatus().isOk().expectBody()
                .jsonPath("$.tools[0].prompt").isEqualTo(prompt)
                .jsonPath("$.tools[0].tool").doesNotExist()
                .jsonPath("$.tools[0].manifestHash").doesNotExist()
                .jsonPath("$.tools[0].directoryPath").doesNotExist();
        client.get().uri("/api/capabilities/all")
                .exchange().expectStatus().isOk().expectBody()
                .jsonPath("$[0].prompt").isEqualTo(prompt);
    }

    @ParameterizedTest
    @NullAndEmptySource
    @ValueSource(strings = {"   "})
    void omitsUndeclaredOrBlankPrompt(String prompt) {
        WebTestClient client = client(prompt);
        client.get().uri("/api/capabilities/schema?path=" + PATH)
                .exchange().expectStatus().isOk().expectBody()
                .jsonPath("$.prompt").doesNotExist();
        client.get().uri("/api/capabilities")
                .exchange().expectStatus().isOk().expectBody()
                .jsonPath("$.tools[0].prompt").doesNotExist();
    }

    private WebTestClient client(String prompt) {
        CapabilityService capabilities = mock(CapabilityService.class);
        ToolManifest manifest = new ToolManifest(
                "sample.read", "1", "sample_read", "Read a sample",
                JsonNodeFactory.instance.objectNode().put("type", "object"), null,
                RiskLevel.READ_ONLY, ToolManifest.SideEffect.NONE, 30, 1000,
                ToolManifest.IdempotencySemantics.IDEMPOTENT,
                ToolManifest.EvidencePolicy.NONE, "sample", prompt
        );
        ToolBinding binding = new ToolBinding(
                manifest, "internal-executor-directory", PATH, "internal-hash", mock(Tool.class)
        );
        when(capabilities.normalizePath(PATH)).thenReturn(PATH);
        when(capabilities.read(PATH, "local")).thenReturn(Optional.of(binding));
        when(capabilities.tree("local")).thenReturn(new CapabilityNode(
                "", "", 1, List.of(new CapabilityNode(PATH, "sample_read", 1, List.of()))
        ));
        return WebTestClient.bindToController(new CapabilitiesApiController(capabilities)).build();
    }
}
