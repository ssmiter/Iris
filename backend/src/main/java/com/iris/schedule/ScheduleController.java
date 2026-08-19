package com.iris.schedule;

import org.springframework.http.HttpStatus;
import org.springframework.http.ProblemDetail;
import org.springframework.web.bind.annotation.DeleteMapping;
import org.springframework.web.bind.annotation.ExceptionHandler;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PatchMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RequestParam;
import org.springframework.web.bind.annotation.RestController;
import reactor.core.publisher.Mono;
import reactor.core.scheduler.Schedulers;

import java.net.URI;
import java.util.List;

/**
 * 定时任务管理 API（docs/33 §3）。人（管理页）与模型的写路径共用
 * {@link CronScheduleService}；模型侧另有 /system/schedule 工具，
 * 走标准 Tool Runtime 审批。
 */
@RestController
@RequestMapping("/api/v1/schedules")
public class ScheduleController {

    private final CronScheduleService schedules;
    private final CronFireService fires;

    public ScheduleController(
            CronScheduleService schedules,
            CronFireService fires
    ) {
        this.schedules = schedules;
        this.fires = fires;
    }

    @GetMapping
    public Mono<List<CronScheduleService.ScheduleView>> list() {
        return Mono.fromCallable(schedules::list)
                .subscribeOn(Schedulers.boundedElastic());
    }

    @PostMapping
    public Mono<CronScheduleService.ScheduleView> create(
            @RequestBody CreateScheduleRequest request
    ) {
        return Mono.fromCallable(() -> schedules.create(
                        request.name(),
                        request.expression(),
                        request.prompt(),
                        request.enabled() == null || request.enabled(),
                        request.once() != null && request.once(),
                        "user"
                ))
                .subscribeOn(Schedulers.boundedElastic());
    }

    @PatchMapping("/{taskId}")
    public Mono<CronScheduleService.ScheduleView> update(
            @PathVariable String taskId,
            @RequestBody UpdateScheduleRequest request
    ) {
        return Mono.fromCallable(() -> {
                    CronScheduleService.ScheduleView updated = schedules.update(
                            taskId,
                            request.expectedVersion(),
                            request.name(),
                            request.expression(),
                            request.prompt(),
                            request.once()
                    );
                    if (request.enabled() != null
                            && request.enabled() != updated.enabled()) {
                        return schedules.setEnabled(
                                taskId,
                                updated.version(),
                                request.enabled()
                        );
                    }
                    return updated;
                })
                .subscribeOn(Schedulers.boundedElastic());
    }

    @DeleteMapping("/{taskId}")
    public Mono<Void> delete(
            @PathVariable String taskId,
            @RequestParam long expectedVersion
    ) {
        return Mono.<Void>fromRunnable(() ->
                        schedules.delete(taskId, expectedVersion))
                .subscribeOn(Schedulers.boundedElastic());
    }

    @PostMapping("/{taskId}/run")
    public Mono<CronScheduleService.ExecutionView> runNow(
            @PathVariable String taskId
    ) {
        return Mono.fromCallable(() -> fires.fireNow(taskId))
                .subscribeOn(Schedulers.boundedElastic());
    }

    @GetMapping("/{taskId}/executions")
    public Mono<List<CronScheduleService.ExecutionView>> executions(
            @PathVariable String taskId,
            @RequestParam(defaultValue = "20") int limit
    ) {
        return Mono.fromCallable(() -> schedules.executions(taskId, limit))
                .subscribeOn(Schedulers.boundedElastic());
    }

    @ExceptionHandler(IllegalArgumentException.class)
    public ProblemDetail handleInvalid(IllegalArgumentException exception) {
        ProblemDetail problem = ProblemDetail.forStatusAndDetail(
                HttpStatus.UNPROCESSABLE_ENTITY,
                exception.getMessage()
        );
        problem.setType(URI.create(
                "https://iris.local/problems/invalid-schedule"
        ));
        problem.setProperty("code", "invalid_schedule");
        problem.setProperty("category", "validation");
        return problem;
    }

    @ExceptionHandler(IllegalStateException.class)
    public ProblemDetail handleConflict(IllegalStateException exception) {
        ProblemDetail problem = ProblemDetail.forStatusAndDetail(
                HttpStatus.CONFLICT,
                exception.getMessage()
        );
        problem.setType(URI.create(
                "https://iris.local/problems/stale-schedule"
        ));
        problem.setProperty("code", "stale_version");
        problem.setProperty("category", "conflict");
        return problem;
    }

    public record CreateScheduleRequest(
            String name,
            String expression,
            String prompt,
            Boolean enabled,
            Boolean once
    ) { }

    public record UpdateScheduleRequest(
            long expectedVersion,
            String name,
            String expression,
            String prompt,
            Boolean enabled,
            Boolean once
    ) { }
}
