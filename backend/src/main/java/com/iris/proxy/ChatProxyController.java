package com.iris.proxy;

import com.fasterxml.jackson.databind.JsonNode;
import org.springframework.http.MediaType;
import org.springframework.http.codec.ServerSentEvent;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RestController;
import reactor.core.publisher.Flux;

/**
 * 模型代理（docs/08 §1）：前端 → 本端点 → 上游模型 API（OpenAI 兼容/Anthropic 系）。
 *
 * 职责：
 * - 密钥只存服务端配置，绝不出现在响应里；
 * - 上游协议差异在此归一化，前端只见 delta/thinking/tool_call/usage/done 五种事件；
 * - 上游断流指数退避重试 ≤3 次，对前端透明。
 *
 * TODO(M0)：接一家 OpenAI 兼容上游，把 stream 转发为 SSE。
 */
@RestController
@RequestMapping("/api/chat")
public class ChatProxyController {

    public record ChatRequest(
            String provider,
            String model,
            String baseUrl,
            JsonNode messages,
            JsonNode tools,
            boolean stream
    ) {}

    @PostMapping(value = "/proxy", produces = MediaType.TEXT_EVENT_STREAM_VALUE)
    public Flux<ServerSentEvent<String>> proxy(@RequestBody ChatRequest request) {
        // 骨架：返回一段占位流，证明 SSE 链路通；M0 替换为真实上游转发。
        return Flux.just(
                ServerSentEvent.<String>builder().event("delta").data("{\"text\":\"Iris 后端已连通，").build(),
                ServerSentEvent.<String>builder().event("delta").data("{\"text\":\"等待接入真实模型上游。\"}").build(),
                ServerSentEvent.<String>builder().event("done").data("{\"finishReason\":\"stop\"}").build()
        );
    }
}
