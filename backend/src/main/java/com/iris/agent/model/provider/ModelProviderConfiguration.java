package com.iris.agent.model.provider;

import org.springframework.boot.context.properties.EnableConfigurationProperties;
import org.springframework.context.annotation.Configuration;

@Configuration
@EnableConfigurationProperties(IrisModelProperties.class)
public class ModelProviderConfiguration {
}
