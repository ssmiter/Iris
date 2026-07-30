package com.iris.artifact;

import com.fasterxml.jackson.databind.JsonNode;
import com.iris.artifact.ArtifactService.ArtifactContent;
import org.springframework.http.ContentDisposition;
import org.springframework.http.HttpHeaders;
import org.springframework.http.MediaType;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RestController;

import java.nio.charset.StandardCharsets;

@RestController
@RequestMapping("/api/v1/artifacts")
public class ArtifactController {
    private final ArtifactService artifacts;

    public ArtifactController(ArtifactService artifacts) {
        this.artifacts = artifacts;
    }

    @GetMapping("/{artifactId}/versions/{version}")
    public JsonNode metadata(
            @PathVariable String artifactId,
            @PathVariable int version
    ) {
        return artifacts.toJson(
                artifacts.requireById(artifactId, version)
        );
    }

    @GetMapping("/{artifactId}/versions/{version}/preview")
    public JsonNode preview(
            @PathVariable String artifactId,
            @PathVariable int version
    ) {
        return artifacts.previewToJson(
                artifacts.preview(artifactId, version)
        );
    }

    @GetMapping("/{artifactId}/versions/{version}/preview-content")
    public ResponseEntity<byte[]> previewContent(
            @PathVariable String artifactId,
            @PathVariable int version
    ) {
        ArtifactContent content = artifacts.previewImageContent(
                artifactId,
                version
        );
        return ResponseEntity.ok()
                .contentType(safeMediaType(content.mediaType()))
                .header("X-Content-Type-Options", "nosniff")
                .header(
                        HttpHeaders.CACHE_CONTROL,
                        "private, max-age=31536000, immutable"
                )
                .body(content.bytes());
    }

    @GetMapping("/{artifactId}/versions/{version}/content")
    public ResponseEntity<byte[]> content(
            @PathVariable String artifactId,
            @PathVariable int version
    ) {
        ArtifactContent content = artifacts.content(artifactId, version);
        ContentDisposition disposition = ContentDisposition.attachment()
                .filename(content.name(), StandardCharsets.UTF_8)
                .build();
        return ResponseEntity.ok()
                .contentType(safeMediaType(content.mediaType()))
                .header(
                        HttpHeaders.CONTENT_DISPOSITION,
                        disposition.toString()
                )
                .header("X-Content-Type-Options", "nosniff")
                .body(content.bytes());
    }

    private MediaType safeMediaType(String value) {
        try {
            return MediaType.parseMediaType(value);
        } catch (IllegalArgumentException exception) {
            return MediaType.APPLICATION_OCTET_STREAM;
        }
    }
}
