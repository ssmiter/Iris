package com.iris.mcp;

import com.iris.mcp.McpServerService.ServerDraft;
import com.iris.mcp.McpServerService.ServerView;
import com.iris.mcp.McpServerService.ToolView;
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
@RequestMapping("/api/v1/mcp/servers")
public class McpServerController {
    private final McpServerService servers;

    public McpServerController(McpServerService servers) {
        this.servers = servers;
    }

    @GetMapping
    public Mono<List<ServerView>> list() {
        return Mono.fromCallable(servers::list)
                .subscribeOn(Schedulers.boundedElastic());
    }

    @GetMapping("/{serverId}")
    public Mono<ServerView> read(@PathVariable String serverId) {
        return Mono.fromCallable(() -> servers.require(serverId))
                .subscribeOn(Schedulers.boundedElastic());
    }

    @GetMapping("/{serverId}/tools")
    public Mono<List<ToolView>> tools(@PathVariable String serverId) {
        return Mono.fromCallable(() -> servers.tools(serverId))
                .subscribeOn(Schedulers.boundedElastic());
    }

    @PostMapping
    public Mono<ResponseEntity<ServerView>> create(
            @RequestBody ServerDraft draft
    ) {
        return Mono.fromCallable(() -> servers.create(draft))
                .subscribeOn(Schedulers.boundedElastic())
                .map(server -> ResponseEntity
                        .status(HttpStatus.CREATED)
                        .body(server));
    }

    @PutMapping("/{serverId}")
    public Mono<ServerView> update(
            @PathVariable String serverId,
            @RequestBody UpdateServerRequest request
    ) {
        return Mono.fromCallable(() -> servers.update(
                        serverId,
                        request.expectedVersion(),
                        request.definition()
                ))
                .subscribeOn(Schedulers.boundedElastic());
    }

    @PatchMapping("/{serverId}/enabled")
    public Mono<ServerView> setEnabled(
            @PathVariable String serverId,
            @RequestBody SetEnabledRequest request
    ) {
        return Mono.fromCallable(() -> servers.setEnabled(
                        serverId,
                        request.expectedVersion(),
                        request.enabled()
                ))
                .subscribeOn(Schedulers.boundedElastic());
    }

    @PostMapping("/{serverId}/refresh")
    public Mono<ServerView> refresh(@PathVariable String serverId) {
        return Mono.fromCallable(() -> servers.refresh(serverId))
                .subscribeOn(Schedulers.boundedElastic());
    }

    public record UpdateServerRequest(
            int expectedVersion,
            ServerDraft definition
    ) { }

    public record SetEnabledRequest(
            int expectedVersion,
            boolean enabled
    ) { }
}
