package com.iris.tools.catalog;

import com.fasterxml.jackson.databind.JsonNode;

import java.util.Collection;
import java.util.Optional;

/** Dynamic, non-Tool definitions projected into the shared capability tree. */
public interface CapabilityCatalogSource {
    Collection<Definition> definitions();

    default Optional<Definition> findByPath(String path) {
        return definitions().stream()
                .filter(definition -> definition.path().equals(path))
                .findFirst();
    }

    record Definition(
            String id,
            String version,
            String kind,
            String name,
            String path,
            String description,
            String riskLevel,
            String availability,
            String availabilityReason,
            String manifestHash,
            JsonNode manifest
    ) {
        public Definition {
            manifest = manifest.deepCopy();
        }
    }
}
