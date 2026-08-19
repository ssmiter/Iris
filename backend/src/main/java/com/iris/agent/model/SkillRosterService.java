package com.iris.agent.model;

import com.iris.extension.SkillTool;
import com.iris.tools.catalog.CapabilityCatalogSource;
import com.iris.tools.catalog.DomainCatalog;
import com.iris.tools.core.CapabilityAvailability;
import com.iris.tools.core.CapabilityAvailabilityService;
import com.iris.tools.core.ToolRegistry;
import org.springframework.stereotype.Component;

import java.util.ArrayList;
import java.util.Comparator;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

/**
 * Builds a bounded, one-level roster of currently available kind=skill
 * capabilities for model context injection.
 *
 * <p>Skills come from both the kernel skill store
 * ({@link com.iris.skill.SkillService}) and SKILL.md file projections
 * ({@link SkillTool}). The roster is sorted by capability path, truncated
 * per-entry and in total, and omitted entirely when no skill is available.</p>
 */
@Component
public class SkillRosterService {

    private static final String DEFAULT_SYSTEM_CODE = "personal";
    private static final int MAX_ENTRY_CHARACTERS = 250;
    private static final int MAX_TOTAL_CHARACTERS = 4_000;
    private static final int MAX_ENTRIES = 64;
    private static final String HEADER = "可用技能薄（kind=skill）：\n";
    private static final String OVERFLOW_NOTE =
            "（还有更多技能，用 search_files(namespace=capabilities) 或"
                    + " list_capabilities 检索。）\n";

    private final ToolRegistry registry;
    private final CapabilityAvailabilityService availability;
    private final List<CapabilityCatalogSource> catalogSources;

    public SkillRosterService(
            ToolRegistry registry,
            CapabilityAvailabilityService availability,
            List<CapabilityCatalogSource> catalogSources
    ) {
        this.registry = registry;
        this.availability = availability;
        this.catalogSources = List.copyOf(catalogSources);
    }

    public ModelInputItem.SkillDirectoryRoster build() {
        return build(DEFAULT_SYSTEM_CODE);
    }

    public ModelInputItem.SkillDirectoryRoster build(String systemCode) {
        List<SkillEntry> candidates = collectCandidates(systemCode);
        if (candidates.isEmpty()) {
            return null;
        }
        candidates.sort(Comparator.comparing(SkillEntry::path));
        String content = render(candidates);
        return new ModelInputItem.SkillDirectoryRoster(content);
    }

    private List<SkillEntry> collectCandidates(String systemCode) {
        Map<String, SkillEntry> byPath = new LinkedHashMap<>();
        for (CapabilityCatalogSource source : catalogSources) {
            for (CapabilityCatalogSource.Definition definition
                    : source.definitions()) {
                if (!"skill".equals(definition.kind())) {
                    continue;
                }
                if (!DomainCatalog.visible(systemCode, definition.path())) {
                    continue;
                }
                if (!"available".equals(definition.availability())) {
                    continue;
                }
                byPath.putIfAbsent(
                        definition.path(),
                        new SkillEntry(
                                definition.path(),
                                definition.name(),
                                definition.description()
                        )
                );
            }
        }
        for (ToolRegistry.ToolBinding binding : registry.all()) {
            if (!(binding.tool() instanceof SkillTool)) {
                continue;
            }
            if (!DomainCatalog.visible(systemCode, binding.capabilityPath())) {
                continue;
            }
            CapabilityAvailability current = availability.current(binding);
            if (current.status()
                    != CapabilityAvailability.Status.AVAILABLE) {
                continue;
            }
            byPath.putIfAbsent(
                    binding.capabilityPath(),
                    new SkillEntry(
                            binding.capabilityPath(),
                            binding.manifest().name(),
                            binding.manifest().description()
                    )
            );
        }
        return new ArrayList<>(byPath.values());
    }

    private String render(List<SkillEntry> candidates) {
        StringBuilder builder = new StringBuilder(HEADER);
        int totalCharacters = builder.length();
        int included = 0;
        boolean truncated = false;
        for (SkillEntry entry : candidates) {
            if (included >= MAX_ENTRIES) {
                truncated = true;
                break;
            }
            String line = "- " + entry.path() + " / " + entry.name()
                    + "：" + entry.description();
            if (line.length() > MAX_ENTRY_CHARACTERS) {
                line = line.substring(0, MAX_ENTRY_CHARACTERS - 1) + "…";
            }
            if (totalCharacters + line.length() + 1 > MAX_TOTAL_CHARACTERS
                    && included > 0) {
                truncated = true;
                break;
            }
            builder.append(line).append('\n');
            totalCharacters = builder.length();
            included++;
        }
        if (truncated || included < candidates.size()) {
            builder.append(OVERFLOW_NOTE);
        }
        return builder.toString();
    }

    private record SkillEntry(String path, String name, String description) {
    }
}
