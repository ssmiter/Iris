package com.iris.agent.model.provider;

import com.iris.agent.model.ModelRequest;
import com.iris.agent.model.ModelStreamEvent;
import reactor.core.publisher.Flux;

import java.time.Duration;

/**
 * One backend-configured provider profile. Credentials stay inside the adapter.
 */
public interface ModelProvider {
    String profileId();

    String providerKind();

    String modelId();

    /** 推理强度档位（low/medium/high），随 profile 冻结，供目录投影展示。 */
    String effort();

    /** 输出上限，随 profile 冻结；docs/42 §5.2 的请求快照把它纳入归因。 */
    int maxOutputTokens();

    Duration timeout();

    Flux<ModelStreamEvent> stream(ModelRequest request);
}
