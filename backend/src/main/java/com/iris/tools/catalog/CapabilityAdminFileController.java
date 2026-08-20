package com.iris.tools.catalog;

import org.springframework.http.HttpStatus;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.PutMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RestController;
import reactor.core.publisher.Mono;
import reactor.core.scheduler.Schedulers;

import java.time.Instant;
import java.util.List;

/**
 * 能力管理面写接口（docs/37 §2.3 / §2.4）：拓展根内文件操作 + 收藏 pins。
 * 与模型发现原语完全分离；操作主体是界面上用户本人，不经模型。
 */
@RestController
@RequestMapping("/api/v1/capability-admin")
public class CapabilityAdminFileController {

    private final CapabilityAdminFileService fileService;
    private final CapabilityPinRepository pins;

    public CapabilityAdminFileController(
            CapabilityAdminFileService fileService,
            CapabilityPinRepository pins
    ) {
        this.fileService = fileService;
        this.pins = pins;
    }

    @PostMapping("/files/move")
    public Mono<OperationResponse> move(@RequestBody MoveRequest request) {
        return Mono.fromCallable(() -> toResponse(
                        fileService.move(request.sourcePath(), request.targetDir())
                ))
                .subscribeOn(Schedulers.boundedElastic());
    }

    @PostMapping("/files/rename")
    public Mono<OperationResponse> rename(@RequestBody RenameRequest request) {
        return Mono.fromCallable(() -> toResponse(
                        fileService.rename(request.path(), request.newName())
                ))
                .subscribeOn(Schedulers.boundedElastic());
    }

    @PostMapping("/files/copy")
    public Mono<OperationResponse> copy(@RequestBody CopyRequest request) {
        return Mono.fromCallable(() -> toResponse(
                        fileService.copy(request.sourcePath(), request.targetDir())
                ))
                .subscribeOn(Schedulers.boundedElastic());
    }

    @PostMapping("/files/delete")
    public Mono<OperationResponse> delete(@RequestBody DeleteRequest request) {
        return Mono.fromCallable(() -> toResponse(
                        fileService.delete(request.path())
                ))
                .subscribeOn(Schedulers.boundedElastic());
    }

    @GetMapping("/pins")
    public Mono<PinsResponse> listPins() {
        return Mono.fromCallable(() -> new PinsResponse(pins.list()))
                .subscribeOn(Schedulers.boundedElastic());
    }

    @PutMapping("/pins")
    public Mono<PinsResponse> replacePins(
            @RequestBody ReplacePinsRequest request
    ) {
        return Mono.fromCallable(() -> {
                    pins.replaceAll(
                            request.paths() == null ? List.of() : request.paths(),
                            Instant.now()
                    );
                    return new PinsResponse(pins.list());
                })
                .subscribeOn(Schedulers.boundedElastic());
    }

    private OperationResponse toResponse(
            CapabilityAdminFileService.OperationResult result
    ) {
        return new OperationResponse(
                result.operation(),
                result.sourcePath(),
                result.targetDir(),
                result.affectedPaths(),
                HttpStatus.OK.value()
        );
    }

    public record OperationResponse(
            String operation,
            String sourcePath,
            String targetDir,
            List<String> affectedPaths,
            int status
    ) {
    }

    public record PinsResponse(List<CapabilityPinRepository.Pin> pins) {
    }

    public record MoveRequest(String sourcePath, String targetDir) {
    }

    public record RenameRequest(String path, String newName) {
    }

    public record CopyRequest(String sourcePath, String targetDir) {
    }

    public record DeleteRequest(String path) {
    }

    public record ReplacePinsRequest(List<String> paths) {
    }
}
