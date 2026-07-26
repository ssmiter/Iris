package com.iris.conversation.api;

import com.iris.conversation.application.ApprovalCommandService;
import com.iris.conversation.domain.ApprovalCommands.ApprovalDecisionResponse;
import com.iris.conversation.domain.ApprovalCommands.DecideApprovalRequest;
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
@RequestMapping("/api/v1/approvals")
public class ApprovalController {
    private final ApprovalCommandService approvals;

    public ApprovalController(ApprovalCommandService approvals) {
        this.approvals = approvals;
    }

    @PostMapping("/{approvalId}/decision")
    public Mono<ApprovalDecisionResponse> decide(
            @PathVariable String approvalId,
            @RequestHeader("Idempotency-Key") String idempotencyKey,
            @Valid @RequestBody DecideApprovalRequest request
    ) {
        return Mono.fromCallable(() -> approvals.decide(
                        approvalId,
                        idempotencyKey,
                        request
                ))
                .subscribeOn(Schedulers.boundedElastic());
    }
}
