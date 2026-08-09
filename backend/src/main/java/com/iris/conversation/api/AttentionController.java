package com.iris.conversation.api;

import com.iris.conversation.application.AttentionCommandService;
import com.iris.conversation.domain.AttentionCommands.AttentionResponse;
import com.iris.conversation.domain.AttentionCommands.RespondAttentionRequest;
import jakarta.validation.Valid;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestHeader;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RestController;
import reactor.core.publisher.Mono;
import reactor.core.scheduler.Schedulers;

@RestController
@RequestMapping("/api/v1/attentions")
public class AttentionController {
    private final AttentionCommandService attentions;

    public AttentionController(AttentionCommandService attentions) {
        this.attentions = attentions;
    }

    @PostMapping("/{attentionId}/response")
    public Mono<AttentionResponse> respond(
            @PathVariable String attentionId,
            @RequestHeader("Idempotency-Key") String idempotencyKey,
            @Valid @RequestBody RespondAttentionRequest request
    ) {
        return Mono.fromCallable(() -> attentions.respond(
                        attentionId,
                        idempotencyKey,
                        request
                ))
                .subscribeOn(Schedulers.boundedElastic());
    }
}
