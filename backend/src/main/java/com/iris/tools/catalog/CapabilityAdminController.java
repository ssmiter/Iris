package com.iris.tools.catalog;

import org.springframework.http.HttpStatus;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RequestParam;
import org.springframework.web.bind.annotation.RestController;
import org.springframework.web.server.ResponseStatusException;
import reactor.core.publisher.Mono;
import reactor.core.scheduler.Schedulers;

import java.util.List;

/**
 * 统一能力管理页的只读查询 API（docs/32 §4）。与模型发现原语
 * （/system/capabilities 工具）完全分离：这里的投影进前端管理页，
 * 不进模型上下文。
 */
@RestController
@RequestMapping("/api/v1/capability-admin")
public class CapabilityAdminController {

    private final CapabilityAdminService admin;

    public CapabilityAdminController(CapabilityAdminService admin) {
        this.admin = admin;
    }

    @GetMapping("/tree")
    public Mono<CapabilityAdminService.AdminTreeNode> tree() {
        return Mono.fromCallable(admin::tree)
                .subscribeOn(Schedulers.boundedElastic());
    }

    @GetMapping("/items")
    public Mono<CapabilityAdminService.AdminListing> items(
            @RequestParam(defaultValue = "/") String path,
            @RequestParam(required = false) String kind,
            @RequestParam(required = false) String query
    ) {
        return Mono.fromCallable(() -> admin.items(path, kind, query))
                .subscribeOn(Schedulers.boundedElastic());
    }

    @GetMapping("/items/detail")
    public Mono<CapabilityAdminService.AdminDetail> detail(
            @RequestParam String path
    ) {
        return Mono.fromCallable(() -> admin.detail(path)
                        .orElseThrow(() -> new ResponseStatusException(
                                HttpStatus.NOT_FOUND,
                                "能力不存在或已不可用: " + path
                        )))
                .subscribeOn(Schedulers.boundedElastic());
    }

    @GetMapping("/problems")
    public Mono<List<CapabilityAdminService.AdminProblem>> problems() {
        return Mono.fromCallable(admin::problems)
                .subscribeOn(Schedulers.boundedElastic());
    }
}
