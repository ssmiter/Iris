package com.iris.memory;

import com.iris.memory.PersonalMemoryService.MemoryDraft;
import com.iris.memory.PersonalMemoryService.MemorySummary;
import com.iris.memory.PersonalMemoryService.MemoryView;
import org.springframework.http.HttpStatus;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PatchMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.PutMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RestController;
import reactor.core.publisher.Mono;
import reactor.core.scheduler.Schedulers;

import java.util.List;

@RestController
@RequestMapping("/api/v1/memories")
public class PersonalMemoryController {
    private final PersonalMemoryService memories;

    public PersonalMemoryController(PersonalMemoryService memories) {
        this.memories = memories;
    }

    @GetMapping
    public Mono<List<MemorySummary>> list() {
        return Mono.fromCallable(memories::list)
                .subscribeOn(Schedulers.boundedElastic());
    }

    @GetMapping("/{memoryId}")
    public Mono<MemoryView> read(@PathVariable String memoryId) {
        return Mono.fromCallable(() -> memories.require(memoryId))
                .subscribeOn(Schedulers.boundedElastic());
    }

    @PostMapping
    public Mono<ResponseEntity<MemoryView>> create(
            @RequestBody MemoryDraft draft
    ) {
        return Mono.fromCallable(() -> memories.create(draft))
                .subscribeOn(Schedulers.boundedElastic())
                .map(memory -> ResponseEntity
                        .status(HttpStatus.CREATED)
                        .body(memory));
    }

    @PutMapping("/{memoryId}")
    public Mono<MemoryView> update(
            @PathVariable String memoryId,
            @RequestBody UpdateMemoryRequest request
    ) {
        return Mono.fromCallable(() -> memories.update(
                        memoryId,
                        request.expectedHeadVersion(),
                        request.definition()
                ))
                .subscribeOn(Schedulers.boundedElastic());
    }

    @PatchMapping("/{memoryId}/enabled")
    public Mono<MemoryView> setEnabled(
            @PathVariable String memoryId,
            @RequestBody SetEnabledRequest request
    ) {
        return Mono.fromCallable(() -> memories.setEnabled(
                        memoryId,
                        request.expectedHeadVersion(),
                        request.enabled()
                ))
                .subscribeOn(Schedulers.boundedElastic());
    }

    public record UpdateMemoryRequest(
            int expectedHeadVersion,
            MemoryDraft definition
    ) { }

    public record SetEnabledRequest(
            int expectedHeadVersion,
            boolean enabled
    ) { }
}
