package com.iris.skill;

import com.iris.skill.SkillService.SkillDraft;
import com.iris.skill.SkillService.SkillView;
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
@RequestMapping("/api/v1/skills")
public class SkillController {
    private final SkillService skills;

    public SkillController(SkillService skills) {
        this.skills = skills;
    }

    @GetMapping
    public Mono<List<SkillView>> list() {
        return Mono.fromCallable(skills::list)
                .subscribeOn(Schedulers.boundedElastic());
    }

    @GetMapping("/{skillId}")
    public Mono<SkillView> read(@PathVariable String skillId) {
        return Mono.fromCallable(() -> skills.require(skillId))
                .subscribeOn(Schedulers.boundedElastic());
    }

    @PostMapping
    public Mono<ResponseEntity<SkillView>> create(
            @RequestBody SkillDraft draft
    ) {
        return Mono.fromCallable(() -> skills.create(draft))
                .subscribeOn(Schedulers.boundedElastic())
                .map(skill -> ResponseEntity
                        .status(HttpStatus.CREATED)
                        .body(skill));
    }

    @PutMapping("/{skillId}")
    public Mono<SkillView> update(
            @PathVariable String skillId,
            @RequestBody UpdateSkillRequest request
    ) {
        return Mono.fromCallable(() -> skills.update(
                        skillId,
                        request.expectedHeadVersion(),
                        request.definition()
                ))
                .subscribeOn(Schedulers.boundedElastic());
    }

    @PatchMapping("/{skillId}/enabled")
    public Mono<SkillView> setEnabled(
            @PathVariable String skillId,
            @RequestBody SetSkillEnabledRequest request
    ) {
        return Mono.fromCallable(() -> skills.setEnabled(
                        skillId,
                        request.expectedHeadVersion(),
                        request.enabled()
                ))
                .subscribeOn(Schedulers.boundedElastic());
    }

    public record UpdateSkillRequest(
            int expectedHeadVersion,
            SkillDraft definition
    ) { }

    public record SetSkillEnabledRequest(
            int expectedHeadVersion,
            boolean enabled
    ) { }
}
