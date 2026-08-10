package com.iris.task;

import com.fasterxml.jackson.databind.node.ObjectNode;
import com.iris.conversation.domain.ApiProblemException;
import org.springframework.http.HttpStatus;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RequestParam;
import org.springframework.web.bind.annotation.RestController;
import reactor.core.publisher.Mono;
import reactor.core.scheduler.Schedulers;

import java.util.List;

/** Read-only task blackboard API. Mutations remain Tool Runtime operations. */
@RestController
@RequestMapping("/api/v1")
public final class TaskController {
    private final TaskLedgerService tasks;

    public TaskController(TaskLedgerService tasks) {
        this.tasks = tasks;
    }

    @GetMapping("/conversations/{conversationId}/tasks")
    public Mono<TaskPage> list(
            @PathVariable String conversationId,
            @RequestParam String branchId,
            @RequestParam(required = false) String phase,
            @RequestParam(defaultValue = "30") int limit
    ) {
        return Mono.fromCallable(() -> new TaskPage(
                        conversationId,
                        branchId,
                        tasks.list(conversationId, branchId, phase, limit)
                                .stream()
                                .map(tasks::toJson)
                                .toList()
                ))
                .subscribeOn(Schedulers.boundedElastic());
    }

    @GetMapping("/conversations/{conversationId}/tasks/{taskId}")
    public Mono<ObjectNode> detail(
            @PathVariable String conversationId,
            @PathVariable String taskId,
            @RequestParam String branchId
    ) {
        return Mono.fromCallable(() -> tasks.findView(
                                taskId,
                                conversationId,
                                branchId
                        )
                        .map(tasks::toHandoffJson)
                        .orElseThrow(() -> new ApiProblemException(
                                HttpStatus.NOT_FOUND,
                                "task_not_found",
                                "not_found",
                                "当前对话分支中找不到这个任务。"
                        )))
                .subscribeOn(Schedulers.boundedElastic());
    }

    public record TaskPage(
            String conversationId,
            String branchId,
            List<ObjectNode> items
    ) {
    }
}
