package com.iris.tools.web.browser;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.node.ObjectNode;
import com.iris.storage.ManagedObjectStore;
import com.iris.storage.ManagedObjectStore.StoredObject;
import com.iris.tools.core.CommittedOperation;
import com.iris.tools.core.PreparedOperation;
import com.iris.tools.core.PreparedOperation.ResourceClaim;
import com.iris.tools.core.RiskLevel;
import com.iris.tools.core.Tool;
import com.iris.tools.core.ToolContext;
import com.iris.tools.core.ToolManifest;
import com.iris.tools.core.ToolOutcome;
import com.iris.tools.core.ToolRuntimeException;
import com.iris.tools.core.VerificationResult;
import com.iris.webbridge.BrowserRuntimeService;
import com.iris.webbridge.WebBridgeClient;
import com.iris.webbridge.WebBridgeClient.ScreenshotPayload;
import org.springframework.stereotype.Component;

import java.io.IOException;
import java.time.Instant;
import java.util.List;

@Component
public class CaptureBrowserScreenshotTool implements Tool {

    private final ObjectMapper objectMapper;
    private final BrowserRuntimeService runtimeService;
    private final WebBridgeClient client;
    private final ManagedObjectStore objects;
    private final ToolManifest manifest;

    public CaptureBrowserScreenshotTool(
            ObjectMapper objectMapper,
            BrowserRuntimeService runtimeService,
            WebBridgeClient client,
            ManagedObjectStore objects
    ) {
        this.objectMapper = objectMapper;
        this.runtimeService = runtimeService;
        this.client = client;
        this.objects = objects;
        this.manifest = new ToolManifest(
                "iris.web.browser.capture_browser_screenshot",
                "2",
                "capture_browser_screenshot",
                "截取当前 BrowserPage 并保存为不可变图像对象，只返回对象引用和图像 metadata；需要视觉证据时使用",
                inputSchema(),
                outputSchema(),
                RiskLevel.READ_ONLY,
                ToolManifest.SideEffect.NONE,
                50,
                8_000,
                ToolManifest.IdempotencySemantics.NON_IDEMPOTENT,
                ToolManifest.EvidencePolicy.REQUIRED,
                ToolManifest.ContextRetention.PINNED,
                ToolManifest.ConcurrencySemantics.SERIAL,
                ToolManifest.CancellationSemantics.COOPERATIVE
        );
    }

    @Override
    public ToolManifest manifest() {
        return manifest;
    }

    @Override
    public PreparedOperation prepare(JsonNode input, ToolContext context) {
        String runtimeId = runtimeService.resolveAvailable(
                BrowserToolSupport.optionalId(input, "runtime_id")
        );
        String sessionId = BrowserToolSupport.requiredId(
                input,
                "session_id"
        );
        String pageId = BrowserToolSupport.requiredId(input, "page_id");
        String format = input.path("format").asText("jpeg")
                .toLowerCase(java.util.Locale.ROOT);
        if (!"jpeg".equals(format) && !"png".equals(format)) {
            throw new ToolRuntimeException(
                    "invalid_screenshot_format",
                    "format 只能是 jpeg 或 png"
            );
        }
        int quality = BrowserToolSupport.bounded(
                input,
                "quality",
                70,
                30,
                90
        );
        boolean fullPage = input.path("full_page").asBoolean(false);
        ObjectNode normalized = objectMapper.createObjectNode();
        normalized.put("runtime_id", runtimeId);
        normalized.put("session_id", sessionId);
        normalized.put("page_id", pageId);
        normalized.put("format", format);
        normalized.put("quality", quality);
        normalized.put("full_page", fullPage);
        return new PreparedOperation(
                normalized,
                "读取 BrowserPage " + pageId
                        + (fullPage ? " 的完整页面截图" : " 的当前视口截图")
                        + "并保存为 Iris 私有不可变图像对象，不改变页面",
                List.of(new ResourceClaim(
                        "browser_page",
                        runtimeId + "/" + sessionId + "/" + pageId,
                        null
                )),
                Instant.now().plusSeconds(45)
        );
    }

    @Override
    public ToolOutcome execute(
            CommittedOperation operation,
            ToolContext context
    ) throws IOException {
        if (context.cancelled()) {
            throw new ToolRuntimeException(
                    "tool_cancelled",
                    "截图读取已停止，没有创建图像对象"
            );
        }
        JsonNode input = operation.normalizedInput();
        ScreenshotPayload screenshot = client.captureScreenshot(
                input.path("runtime_id").asText(),
                input.path("session_id").asText(),
                input.path("page_id").asText(),
                input.path("format").asText(),
                input.path("quality").asInt(),
                input.path("full_page").asBoolean()
        );
        if (context.cancelled()) {
            throw new ToolRuntimeException(
                    "tool_cancelled",
                    "截图已从浏览器读取，但尚未写入对象仓"
            );
        }
        StoredObject stored = objects.put(screenshot.bytes());
        ObjectNode output = objectMapper.createObjectNode();
        output.put("objectRef", stored.objectRef());
        output.put("contentHash", stored.contentHash());
        output.put("byteCount", stored.byteCount());
        output.put("mediaType", screenshot.mediaType());
        output.put("pageId", screenshot.pageId());
        output.put("observationRef", screenshot.observationRef());
        output.put(
                "guidance",
                "图像字节未进入文本上下文；由支持 objectRef 的视觉或前端 renderer 按需读取"
        );
        return ToolOutcome.succeeded(output);
    }

    @Override
    public VerificationResult verify(
            ToolOutcome outcome,
            CommittedOperation operation,
            ToolContext context
    ) {
        JsonNode output = outcome.output();
        String hash = output.path("contentHash").asText();
        String objectRef = output.path("objectRef").asText();
        if (!objectRef.equals("object://sha256/" + hash)) {
            return new VerificationResult(
                    VerificationResult.Status.FAILED,
                    List.of(),
                    "截图对象引用与内容 hash 不一致"
            );
        }
        return VerificationResult.confirmed(List.of(
                new VerificationResult.Evidence(
                        "browser_screenshot",
                        objectRef,
                        "页面截图已作为 "
                                + output.path("mediaType").asText()
                                + " 不可变对象保存，共 "
                                + output.path("byteCount").asLong()
                                + " 字节"
                )
        ));
    }

    private JsonNode inputSchema() {
        ObjectNode schema = BrowserToolSupport.objectSchema(objectMapper);
        ObjectNode properties = (ObjectNode) schema.path("properties");
        properties.putObject("runtime_id").put("type", "string")
                .put("description", "可选定向 Runtime ID；默认 Runtime 会由 Backend 自动解析");
        properties.putObject("session_id").put("type", "string")
                .put("description", "当前短期 BrowserSession ID");
        properties.putObject("page_id").put("type", "string")
                .put("description", "当前 BrowserPage ID");
        properties.putObject("format").put("type", "string")
                .put("description", "图像格式，默认 jpeg")
                .putArray("enum").add("jpeg").add("png");
        properties.putObject("quality").put("type", "integer")
                .put("minimum", 30).put("maximum", 90)
                .put("description", "JPEG 质量，默认 70；PNG 忽略此值");
        properties.putObject("full_page").put("type", "boolean")
                .put("description", "false 截当前视口；true 尝试截完整页面");
        schema.putArray("required")
                .add("session_id").add("page_id");
        return schema;
    }

    private JsonNode outputSchema() {
        ObjectNode schema = BrowserToolSupport.objectSchema(objectMapper);
        ObjectNode properties = (ObjectNode) schema.path("properties");
        properties.putObject("objectRef").put("type", "string")
                .put("description", "托管对象仓中的不可变图像引用");
        properties.putObject("contentHash").put("type", "string")
                .put("description", "图像内容的 SHA-256 摘要");
        properties.putObject("byteCount").put("type", "integer")
                .put("description", "图像字节数");
        properties.putObject("mediaType").put("type", "string")
                .put("description", "图像 MIME 类型");
        properties.putObject("pageId").put("type", "string")
                .put("description", "截图对应的 BrowserPage ID");
        properties.putObject("observationRef").put("type", "string")
                .put("description", "截图时最近的页面观察 ref");
        properties.putObject("guidance").put("type", "string")
                .put("description", "如何按需读取图像对象的提示");
        schema.putArray("required")
                .add("objectRef").add("contentHash").add("byteCount")
                .add("mediaType").add("pageId")
                .add("observationRef").add("guidance");
        return schema;
    }
}
