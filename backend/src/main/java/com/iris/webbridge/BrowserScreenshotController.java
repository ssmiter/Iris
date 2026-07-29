package com.iris.webbridge;

import com.iris.webbridge.BrowserScreenshotService.ScreenshotContent;
import org.springframework.http.CacheControl;
import org.springframework.http.MediaType;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RestController;
import reactor.core.publisher.Mono;
import reactor.core.scheduler.Schedulers;

import java.time.Duration;

@RestController
@RequestMapping("/api/v1")
public class BrowserScreenshotController {

    private final BrowserScreenshotService screenshots;

    public BrowserScreenshotController(
            BrowserScreenshotService screenshots
    ) {
        this.screenshots = screenshots;
    }

    @GetMapping(
            value = "/conversations/{conversationId}"
                    + "/tool-executions/{executionId}/browser-screenshot",
            produces = {"image/jpeg", "image/png"}
    )
    public Mono<ResponseEntity<byte[]>> screenshot(
            @PathVariable String conversationId,
            @PathVariable String executionId
    ) {
        return Mono.fromCallable(() -> screenshots.read(
                        conversationId,
                        executionId
                ))
                .subscribeOn(Schedulers.boundedElastic())
                .map(this::response);
    }

    private ResponseEntity<byte[]> response(ScreenshotContent content) {
        return ResponseEntity.ok()
                .contentType(MediaType.parseMediaType(
                        content.metadata().mediaType()
                ))
                .contentLength(content.metadata().byteCount())
                .cacheControl(CacheControl
                        .maxAge(Duration.ofDays(365))
                        .cachePublic()
                        .immutable())
                .eTag("\"" + content.metadata().contentHash() + "\"")
                .header("X-Content-Type-Options", "nosniff")
                .body(content.bytes());
    }
}
