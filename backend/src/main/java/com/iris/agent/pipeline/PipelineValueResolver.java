package com.iris.agent.pipeline;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import org.springframework.stereotype.Service;

/** Resolves explicit initial-input or earlier-step selectors. */
@Service
public class PipelineValueResolver {
    private final PipelineRunRepository runs;
    private final ObjectMapper objectMapper;

    public PipelineValueResolver(
            PipelineRunRepository runs,
            ObjectMapper objectMapper
    ) {
        this.runs = runs;
        this.objectMapper = objectMapper;
    }

    /** Recursively resolves selector-valued leaves while preserving literals. */
    public JsonNode resolveTemplate(
            PipelineRunRepository.PipelineRun run,
            PipelineRunRepository.StepRun currentStep,
            JsonNode template
    ) {
        if (template.isTextual()) {
            String value = template.asText();
            if (value.startsWith("input:") || value.startsWith("step:")) {
                return resolve(run, currentStep, value).deepCopy();
            }
            return template.deepCopy();
        }
        if (template.isObject()) {
            var result = objectMapper.createObjectNode();
            template.fields().forEachRemaining(entry -> result.set(
                    entry.getKey(),
                    resolveTemplate(run, currentStep, entry.getValue())
            ));
            return result;
        }
        if (template.isArray()) {
            var result = objectMapper.createArrayNode();
            template.forEach(item -> result.add(
                    resolveTemplate(run, currentStep, item)
            ));
            return result;
        }
        return template.deepCopy();
    }

    public JsonNode resolve(
            PipelineRunRepository.PipelineRun run,
            PipelineRunRepository.StepRun currentStep,
            String selector
    ) {
        if (selector == null || selector.isBlank()) {
            throw new IllegalArgumentException(
                    "Pipeline value selector is required"
            );
        }
        if (selector.startsWith("input:")) {
            return at(run.input(), selector.substring("input:".length()));
        }
        if (selector.startsWith("step:")) {
            return resolveEarlierStep(run, currentStep, selector);
        }
        throw new IllegalArgumentException(
                "Pipeline selector must start with input: or step:"
        );
    }

    private JsonNode resolveEarlierStep(
            PipelineRunRepository.PipelineRun run,
            PipelineRunRepository.StepRun currentStep,
            String selector
    ) {
        int separator = selector.indexOf(':', "step:".length());
        if (separator < 0) {
            throw new IllegalArgumentException(
                    "Step selector must be step:<stepId>:<jsonPointer>"
            );
        }
        String stepId = selector.substring("step:".length(), separator);
        String pointer = selector.substring(separator + 1);
        PipelineRunRepository.StepRun source = runs.steps(run.runId()).stream()
                .filter(step -> step.stepId().equals(stepId))
                .findFirst()
                .orElseThrow(() -> new IllegalArgumentException(
                        "Pipeline source step not found: " + stepId
                ));
        if (source.stepIndex() >= currentStep.stepIndex()
                || !"succeeded".equals(source.phase())
                || source.output() == null) {
            throw new IllegalStateException(
                    "Pipeline step may read only a succeeded earlier step"
            );
        }
        return at(source.output(), pointer);
    }

    private JsonNode at(JsonNode source, String pointer) {
        if (pointer == null || pointer.isBlank()) {
            return source;
        }
        if (!pointer.startsWith("/")) {
            throw new IllegalArgumentException(
                    "Pipeline JSON pointer must be empty or start with /"
            );
        }
        JsonNode value = source.at(pointer);
        if (value.isMissingNode()) {
            throw new IllegalArgumentException(
                    "Pipeline selector did not resolve a value"
            );
        }
        return value;
    }
}
