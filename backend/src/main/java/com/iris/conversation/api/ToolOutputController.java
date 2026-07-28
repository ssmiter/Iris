package com.iris.conversation.api;

import com.iris.conversation.application.ToolOutputQueryService;
import com.iris.conversation.application.ToolOutputQueryService.ToolOutputWindow;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RequestParam;
import org.springframework.web.bind.annotation.RestController;
import reactor.core.publisher.Mono;
import reactor.core.scheduler.Schedulers;

@RestController
@RequestMapping("/api/v1")
public class ToolOutputController {

    private final ToolOutputQueryService outputs;

    public ToolOutputController(ToolOutputQueryService outputs) {
        this.outputs = outputs;
    }

    @GetMapping(
            "/conversations/{conversationId}"
                    + "/tool-executions/{executionId}/output"
    )
    public Mono<ToolOutputWindow> output(
            @PathVariable String conversationId,
            @PathVariable String executionId,
            @RequestParam(defaultValue = "0") int startCharacter,
            @RequestParam(required = false) Integer characterCount
    ) {
        return Mono.fromCallable(() -> outputs.read(
                        conversationId,
                        executionId,
                        startCharacter,
                        characterCount
                ))
                .subscribeOn(Schedulers.boundedElastic());
    }
}
