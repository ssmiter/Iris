package com.iris.agent.model;

import com.iris.agent.model.provider.ModelProfileCatalog;
import com.iris.agent.model.provider.ModelProviderRegistry;
import com.iris.conversation.application.CompactionEventEmitter;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.boot.ApplicationArguments;
import org.springframework.boot.ApplicationRunner;
import org.springframework.core.annotation.Order;
import org.springframework.stereotype.Service;

import java.util.Set;
import java.util.concurrent.ConcurrentHashMap;

@Service
@Order(50)
public final class CompactionLauncher implements ApplicationRunner {
    private static final Logger log =
            LoggerFactory.getLogger(CompactionLauncher.class);

    private final CompactionCoordinator coordinator;
    private final CompactionRepository repository;
    private final CompactionEventEmitter events;
    private final ModelProviderRegistry providers;
    private final ModelProfileCatalog modelProfiles;
    private final Set<String> active = ConcurrentHashMap.newKeySet();

    public CompactionLauncher(
            CompactionCoordinator coordinator,
            CompactionRepository repository,
            CompactionEventEmitter events,
            ModelProviderRegistry providers,
            ModelProfileCatalog modelProfiles
    ) {
        this.coordinator = coordinator;
        this.repository = repository;
        this.events = events;
        this.providers = providers;
        this.modelProfiles = modelProfiles;
    }

    public boolean launch(String runId) {
        var row = repository.find(runId).orElse(null);
        if (!providers.configured(modelProfiles.activeProfile())
                || row == null
                || (!"accepted".equals(row.phase())
                    && !"running".equals(row.phase()))
                || !active.add(runId)) {
            return false;
        }
        coordinator.advance(runId, modelProfiles.activeProfile())
                .doFinally(signal -> active.remove(runId))
                .subscribe(
                        boundary -> events.completed(runId, boundary),
                        error -> {
                            events.failed(runId);
                            log.error(
                                    "Compaction Run {} failed",
                                    runId,
                                    error
                            );
                        }
                );
        return true;
    }

    @Override
    public void run(ApplicationArguments args) {
        if (!providers.configured(modelProfiles.activeProfile())) {
            return;
        }
        repository.resumableRunIds().forEach(this::launch);
    }
}
