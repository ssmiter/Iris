package com.iris.gateway.model;

import org.springframework.boot.context.properties.EnableConfigurationProperties;
import org.springframework.context.annotation.Configuration;

@Configuration
@EnableConfigurationProperties(ModelGatewayProperties.class)
public class ModelGatewayConfiguration {
}
