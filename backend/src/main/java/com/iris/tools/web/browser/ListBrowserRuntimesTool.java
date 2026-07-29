package com.iris.tools.web.browser;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.node.ArrayNode;
import com.fasterxml.jackson.databind.node.ObjectNode;
import com.iris.tools.core.CommittedOperation;
import com.iris.tools.core.PreparedOperation;
import com.iris.tools.core.RiskLevel;
import com.iris.tools.core.Tool;
import com.iris.tools.core.ToolContext;
import com.iris.tools.core.ToolManifest;
import com.iris.tools.core.ToolOutcome;
import com.iris.tools.core.VerificationResult;
import com.iris.webbridge.BrowserRuntimeCatalog;
import com.iris.webbridge.BrowserRuntimeService;
import com.iris.webbridge.BrowserRuntimeService.RuntimeHealth;
import org.springframework.stereotype.Component;

import java.time.Instant;
import java.util.List;

@Component
public class ListBrowserRuntimesTool implements Tool {

    private final ObjectMapper objectMapper;
    private final BrowserRuntimeCatalog runtimes;
    private final BrowserRuntimeService runtimeService;
    private final ToolManifest manifest;

    public ListBrowserRuntimesTool(
            ObjectMapper objectMapper,
            BrowserRuntimeCatalog runtimes,
            BrowserRuntimeService runtimeService
    ) {
        this.objectMapper = objectMapper;
        this.runtimes = runtimes;
        this.runtimeService = runtimeService;
        this.manifest = new ToolManifest(
                "iris.web.browser.list_browser_runtimes",
                "1",
                "list_browser_runtimes",
                "列出 Iris 可连接的本机浏览器运行时及当前状态；需要开始网页操作或解释浏览器为何不可用时使用",
                inputSchema(),
                outputSchema(),
                RiskLevel.READ_ONLY,
                ToolManifest.SideEffect.NONE,
                12,
                12_000,
                ToolManifest.IdempotencySemantics.NON_IDEMPOTENT,
                ToolManifest.EvidencePolicy.SUMMARY,
                ToolManifest.ContextRetention.PINNED,
                ToolManifest.ConcurrencySemantics.PARALLEL_SAFE,
                ToolManifest.CancellationSemantics.COOPERATIVE
        );
    }

    @Override
    public ToolManifest manifest() {
        return manifest;
    }

    @Override
    public PreparedOperation prepare(JsonNode input, ToolContext context) {
        return new PreparedOperation(
                objectMapper.createObjectNode(),
                "读取 Browser Runtime Catalog 与短缓存健康状态，不启动浏览器或改变页面",
                List.of(),
                Instant.now().plusSeconds(30)
        );
    }

    @Override
    public ToolOutcome execute(
            CommittedOperation operation,
            ToolContext context
    ) {
        ArrayNode items = objectMapper.createArrayNode();
        for (BrowserRuntimeCatalog.Definition definition
                : runtimes.definitions()) {
            if (context.cancelled()) {
                break;
            }
            RuntimeHealth health = runtimeService.health(definition.id());
            ObjectNode item = items.addObject();
            item.put("runtimeId", definition.id());
            item.put("title", definition.title());
            item.put("description", definition.description());
            item.put("available", health.available());
            item.put("browserReady", health.browserReady());
            item.put("reason", health.reason());
            item.put("checkedAt", health.checkedAt().toString());
            if (health.protocolVersion() != null) {
                item.put("protocolVersion", health.protocolVersion());
            }
        }
        ObjectNode output = objectMapper.createObjectNode();
        output.set("runtimes", items);
        output.put("count", items.size());
        output.put(
                "guidance",
                items.isEmpty()
                        ? "当前没有配置 Browser Runtime；需要先在本机私有配置中绑定 daemon"
                        : "选择 available=true 的 runtimeId；创建会话前无需知道 daemon 地址或凭据"
        );
        return ToolOutcome.succeeded(output);
    }

    @Override
    public VerificationResult verify(
            ToolOutcome outcome,
            CommittedOperation operation,
            ToolContext context
    ) {
        return VerificationResult.confirmed(List.of(
                new VerificationResult.Evidence(
                        "browser_runtime_catalog",
                        "local-bindings",
                        "已读取安全 Runtime Definition 与短缓存健康状态"
                )
        ));
    }

    private JsonNode inputSchema() {
        return BrowserToolSupport.objectSchema(objectMapper);
    }

    private JsonNode outputSchema() {
        ObjectNode schema = BrowserToolSupport.objectSchema(objectMapper);
        ObjectNode properties = (ObjectNode) schema.path("properties");
        properties.putObject("runtimes")
                .put("type", "array")
                .put("description", "安全 Runtime metadata 与可用性，不含物理地址或 token");
        properties.putObject("count").put("type", "integer")
                .put("description", "已配置 Browser Runtime 数量");
        properties.putObject("guidance").put("type", "string")
                .put("description", "选择与使用 Runtime 的简短提示");
        schema.putArray("required")
                .add("runtimes").add("count").add("guidance");
        return schema;
    }
}
