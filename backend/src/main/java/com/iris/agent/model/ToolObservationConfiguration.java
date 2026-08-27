package com.iris.agent.model;

import org.springframework.boot.context.properties.EnableConfigurationProperties;
import org.springframework.context.annotation.Configuration;

/**
 * 启用 {@link ToolObservationMicroCompactProperties} 配置绑定。
 */
@Configuration
@EnableConfigurationProperties(ToolObservationMicroCompactProperties.class)
public class ToolObservationConfiguration {
}
