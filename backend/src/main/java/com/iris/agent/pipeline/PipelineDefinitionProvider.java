package com.iris.agent.pipeline;

/** Spring extension point for versioned, code-defined Pipelines. */
public interface PipelineDefinitionProvider {
    PipelineDefinition definition();
}
