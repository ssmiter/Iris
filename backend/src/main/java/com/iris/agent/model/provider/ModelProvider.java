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

    Duration timeout();

    Flux<ModelStreamEvent> stream(ModelRequest request);
}
