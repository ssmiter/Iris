package com.iris.artifact;

import com.fasterxml.jackson.databind.JsonNode;
import org.springframework.http.HttpStatus;
import org.springframework.http.MediaType;
import org.springframework.http.ResponseEntity;
import org.springframework.http.codec.multipart.FilePart;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RequestPart;
import org.springframework.web.bind.annotation.RestController;
import reactor.core.publisher.Mono;
import reactor.core.scheduler.Schedulers;

import java.io.IOException;
import java.nio.file.Files;
import java.nio.file.Path;

/**
 * Conversation-scoped ingress for user-owned immutable inputs.
 */
@RestController
@RequestMapping("/api/v1/conversations")
public class UserArtifactIngressController {
    private final ArtifactService artifacts;

    public UserArtifactIngressController(ArtifactService artifacts) {
        this.artifacts = artifacts;
    }

    @PostMapping(
            value = "/{conversationId}/branches/{branchId}/artifacts",
            consumes = MediaType.MULTIPART_FORM_DATA_VALUE
    )
    public Mono<ResponseEntity<JsonNode>> upload(
            @PathVariable String conversationId,
            @PathVariable String branchId,
            @RequestPart("file") FilePart file
    ) {
        final Path staged;
        try {
            staged = Files.createTempFile("iris-upload-", ".part");
        } catch (IOException exception) {
            return Mono.error(new IllegalStateException(
                    "Cannot allocate upload staging file",
                    exception
            ));
        }
        String mediaType = file.headers().getContentType() == null
                ? null
                : file.headers().getContentType().toString();
        return file.transferTo(staged)
                .then(Mono.fromCallable(() -> artifacts.registerUserUpload(
                                conversationId,
                                branchId,
                                file.filename(),
                                mediaType,
                                staged
                        ))
                        .subscribeOn(Schedulers.boundedElastic()))
                .map(snapshot -> ResponseEntity
                        .status(HttpStatus.CREATED)
                        .body((JsonNode) artifacts.toJson(snapshot)))
                .doFinally(ignored -> {
                    try {
                        Files.deleteIfExists(staged);
                    } catch (IOException ignoredDeleteFailure) {
                        // The immutable object has already been committed.
                    }
                });
    }
}
