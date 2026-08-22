package com.iris.agent.model.provider;

import com.iris.agent.model.provider.ModelProfileCatalog.ProfileSummary;
import com.iris.agent.model.provider.ModelProfileCatalog.UnknownModelProfileException;
import jakarta.validation.Valid;
import jakarta.validation.constraints.NotBlank;
import org.springframework.http.HttpStatus;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RestController;
import org.springframework.web.server.ResponseStatusException;
import reactor.core.publisher.Mono;
import reactor.core.scheduler.Schedulers;

import java.util.List;

/**
 * 模型 profile 的查看与切换（docs/21 §7.1）。低频管理操作，走普通 REST；
 * 投影只进前端顶栏，不进模型上下文。profile 秘密（api-key/base-url）
 * 不出现在任何响应里。
 */
@RestController
@RequestMapping("/api/v1/model-profiles")
public class ModelProfileController {

    private final ModelProfileCatalog catalog;

    public ModelProfileController(ModelProfileCatalog catalog) {
        this.catalog = catalog;
    }

    @GetMapping
    public Mono<ModelProfilesView> profiles() {
        return Mono.fromCallable(() -> new ModelProfilesView(
                        catalog.activeProfile(),
                        catalog.profiles()
                ))
                .subscribeOn(Schedulers.boundedElastic());
    }

    @PostMapping("/active")
    public Mono<ModelProfilesView> switchActive(
            @Valid @RequestBody SwitchActiveRequest request
    ) {
        return Mono.fromCallable(() -> {
                    try {
                        catalog.switchTo(request.profile());
                    } catch (UnknownModelProfileException unknown) {
                        throw new ResponseStatusException(
                                HttpStatus.NOT_FOUND,
                                unknown.getMessage()
                        );
                    }
                    return new ModelProfilesView(
                            catalog.activeProfile(),
                            catalog.profiles()
                    );
                })
                .subscribeOn(Schedulers.boundedElastic());
    }

    public record SwitchActiveRequest(@NotBlank String profile) {
    }

    public record ModelProfilesView(
            String active,
            List<ProfileSummary> profiles
    ) {
    }
}
