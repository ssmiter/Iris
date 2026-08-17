package com.iris.extension;

import com.fasterxml.jackson.databind.ObjectMapper;
import com.iris.execution.WorkspaceProcessRunner;
import com.iris.mcp.McpServerService;
import com.iris.tools.core.Tool;
import com.iris.tools.core.ToolRegistry;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.beans.factory.DisposableBean;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.boot.ApplicationArguments;
import org.springframework.boot.ApplicationRunner;
import org.springframework.core.Ordered;
import org.springframework.stereotype.Service;

import java.io.IOException;
import java.io.UncheckedIOException;
import java.nio.file.ClosedWatchServiceException;
import java.nio.file.FileSystems;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.StandardWatchEventKinds;
import java.nio.file.WatchEvent;
import java.nio.file.WatchKey;
import java.nio.file.WatchService;
import java.util.ArrayList;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.CopyOnWriteArrayList;
import java.util.concurrent.Executors;
import java.util.concurrent.ScheduledExecutorService;
import java.util.concurrent.ScheduledFuture;
import java.util.concurrent.TimeUnit;
import java.util.stream.Stream;

/**
 * 拓展来源服务（docs/31 §6）：扫描拓展根，把合法插件经
 * {@link ToolRegistry#replaceExternal} 原子换入注册表；
 * 文件变化防抖重扫；根被删除即整体卸载。
 *
 * <p>作为 ApplicationRunner 以最高优先级运行，保证启动快照
 * （CapabilityDefinitionPersistence）能覆盖首批拓展定义；
 * 运行期热装的定义随下一次启动固化（与 MCP 现状一致）。</p>
 */
@Service
public class ExtensionProviderService
        implements ApplicationRunner, Ordered, DisposableBean {

    private static final Logger log =
            LoggerFactory.getLogger(ExtensionProviderService.class);

    private final ExtensionProperties properties;
    private final ExtensionScanner scanner;
    private final ExtensionDirectoryRegistry directoryRegistry;
    private final ToolRegistry toolRegistry;
    private final WorkspaceProcessRunner processRunner;
    private final McpServerService mcpServers;
    private final ObjectMapper objectMapper;
    private final String workspaceDir;

    private final List<Path> watchedRootPaths = new CopyOnWriteArrayList<>();
    private final Set<Path> registeredDirectories =
            ConcurrentHashMap.newKeySet();
    private final ConcurrentHashMap<Path, ScheduledFuture<?>> pendingRescans =
            new ConcurrentHashMap<>();
    /** 每根当前注册的常驻工具；换入成功即回收旧快照（docs/31 §6）。 */
    private final ConcurrentHashMap<Path, List<ResidentProcessTool>>
            residentToolsByRoot = new ConcurrentHashMap<>();
    private WatchService watchService;
    private Thread watchThread;
    private ScheduledExecutorService scheduler;

    public ExtensionProviderService(
            ExtensionProperties properties,
            ExtensionScanner scanner,
            ExtensionDirectoryRegistry directoryRegistry,
            ToolRegistry toolRegistry,
            WorkspaceProcessRunner processRunner,
            McpServerService mcpServers,
            ObjectMapper objectMapper,
            @Value("${iris.workspace:~/Iris/workspace}") String workspaceDir
    ) {
        this.properties = properties;
        this.scanner = scanner;
        this.directoryRegistry = directoryRegistry;
        this.toolRegistry = toolRegistry;
        this.processRunner = processRunner;
        this.mcpServers = mcpServers;
        this.objectMapper = objectMapper;
        this.workspaceDir = workspaceDir;
    }

    @Override
    public int getOrder() {
        return 0;
    }

    @Override
    public void run(ApplicationArguments args) {
        if (!properties.isEnabled()) {
            log.info("extension scanning disabled");
            return;
        }
        List<Path> roots = resolveRoots();
        for (Path root : roots) {
            if (Files.isDirectory(root)) {
                scanAndRegister(root);
            }
        }
        startWatcher(roots);
    }

    /**
     * 根解析：内建根（rank 50）永远最先扫描；roots 为空时补默认五层
     * （rank 升序 = 优先级降序，docs/31 §5.2）：工作区自有 → 工作区
     * 社区惯例 → 机器级自有 → 机器级社区全局。不存在的根跳过。
     */
    private List<Path> resolveRoots() {
        List<Path> roots = new ArrayList<>();
        if (properties.getBundledRoot() != null) {
            roots.add(properties.getBundledRoot()
                    .toAbsolutePath().normalize());
        }
        if (!properties.getRoots().isEmpty()) {
            properties.getRoots().stream()
                    .map(Path::toAbsolutePath)
                    .map(Path::normalize)
                    .forEach(roots::add);
            return roots;
        }
        Path workspace = Path.of(workspaceDir).toAbsolutePath().normalize();
        Path home = Path.of(System.getProperty("user.home"))
                .toAbsolutePath().normalize();
        roots.add(workspace.resolve(".iris/extensions"));   // rank 100
        roots.add(workspace.resolve(".agents/skills"));     // rank 200
        roots.add(workspace.resolve(".dsh/skills"));        // rank 200
        roots.add(home.resolve(".iris/extensions"));        // rank 300
        roots.add(home.resolve(".dsh/skills"));             // rank 400
        roots.add(home.resolve(".agents/skills"));          // rank 400
        return roots;
    }

    /** 扫描一个根并原子换入注册表；扫描问题 fail-closed 记录但不影响其他根。 */
    void scanAndRegister(Path root) {
        ExtensionScanner.ScanResult result = scanner.scan(root);
        for (String problem : result.problems()) {
            log.warn("extension rejected: {}", problem);
        }
        directoryRegistry.replaceRoot(root, result.directories());
        registerMcpDeclarations(root, result.mcpServers());

        List<ToolRegistry.ExternalToolRegistration> registrations =
                new ArrayList<>();
        List<ResidentProcessTool> residentTools = new ArrayList<>();
        // §3.2：同目录的 process 清单共享一个常驻进程；entry/env 必须逐字一致
        Map<Path, List<ExtensionScanner.ScannedTool>> processByDir =
                new java.util.LinkedHashMap<>();
        for (ExtensionScanner.ScannedTool scanned : result.tools()) {
            if ("process".equals(scanned.definition().kind())) {
                processByDir.computeIfAbsent(
                        scanned.pluginDir(), key -> new ArrayList<>()
                ).add(scanned);
                continue;
            }
            Tool tool = new TemplateProcessTool(
                    scanned.definition(),
                    scanned.pluginDir(),
                    scanned.contentVersion(),
                    processRunner,
                    objectMapper
            );
            registrations.add(new ToolRegistry.ExternalToolRegistration(
                    scanned.capabilityPath(),
                    tool
            ));
        }
        for (var entry : processByDir.entrySet()) {
            Path pluginDir = entry.getKey();
            List<ExtensionScanner.ScannedTool> group = entry.getValue();
            ResidentPluginProcess shared = sharedProcess(pluginDir, group);
            if (shared == null) {
                continue; // 签名不一致：fail-closed 整目录拒绝，已告警
            }
            for (ExtensionScanner.ScannedTool scanned : group) {
                ResidentProcessTool resident = new ResidentProcessTool(
                        scanned.definition(),
                        scanned.contentVersion(),
                        shared,
                        objectMapper
                );
                residentTools.add(resident);
                registrations.add(new ToolRegistry.ExternalToolRegistration(
                        scanned.capabilityPath(),
                        resident
                ));
            }
        }
        for (ExtensionScanner.ScannedKnowledge doc : result.knowledge()) {
            registrations.add(new ToolRegistry.ExternalToolRegistration(
                    doc.capabilityPath(),
                    new KnowledgeDocumentTool(
                            doc.file(),
                            doc.name(),
                            doc.title(),
                            doc.capabilityPath(),
                            doc.contentVersion(),
                            objectMapper
                    )
            ));
        }
        for (ExtensionScanner.ScannedSkill skill : result.skills()) {
            if (skill.definition().disabledForModel()) {
                // disable-model-invocation：遵循作者声明，不暴露给模型（§5.1）
                log.info(
                        "extension skill {} skipped (disable-model-invocation)",
                        skill.file()
                );
                continue;
            }
            registrations.add(new ToolRegistry.ExternalToolRegistration(
                    skill.capabilityPath(),
                    new SkillTool(
                            skill.file(),
                            skill.bundleDir(),
                            skill.name(),
                            skill.definition(),
                            skill.capabilityPath(),
                            skill.contentVersion(),
                            objectMapper
                    )
            ));
        }
        try {
            toolRegistry.replaceExternal(
                    providerKey(root),
                    registrations,
                    objectMapper
            );
            List<ResidentProcessTool> previous =
                    residentToolsByRoot.put(root, residentTools);
            retireAll(previous);
            log.info(
                    "extension root {} registered: {} tools, {} directories",
                    root,
                    registrations.size(),
                    result.directories().size()
            );
        } catch (RuntimeException exception) {
            // 与内核或其他根冲突：整根拒绝（fail-closed），已有绑定保持。
            retireAll(residentTools);
            log.error(
                    "extension root {} rejected as a whole: {}",
                    root,
                    exception.getMessage()
            );
        }
    }

    /**
     * 为一个插件目录构建共享常驻进程（docs/31 §3.2）：同目录所有 process
     * 清单的 entry/env 必须逐字一致，否则整目录拒绝（fail-closed）。
     */
    private ResidentPluginProcess sharedProcess(
            Path pluginDir,
            List<ExtensionScanner.ScannedTool> group
    ) {
        ProcessToolDefinition first = group.getFirst().definition();
        for (ExtensionScanner.ScannedTool scanned : group) {
            ProcessToolDefinition other = scanned.definition();
            if (!first.runtime().entry().equals(other.runtime().entry())
                    || !java.util.Objects.equals(
                            first.runtime().env(), other.runtime().env())) {
                log.error(
                        "extension plugin dir {} rejected: process manifests "
                                + "in one directory must share identical "
                                + "runtime.entry/env ({} vs {})",
                        pluginDir, first.name(), other.name()
                );
                return null;
            }
        }
        return new ResidentPluginProcess(
                TemplateProcessTool.renderSpawnArgv(
                        first.runtime().entry(), pluginDir),
                pluginDir,
                declaredEnv(first),
                objectMapper
        );
    }

    private Map<String, String> declaredEnv(ProcessToolDefinition definition) {
        if (definition.runtime().env() == null
                || definition.runtime().env().isEmpty()) {
            return Map.of();
        }
        Map<String, String> names = new java.util.LinkedHashMap<>();
        for (String name : definition.runtime().env()) {
            String value = System.getenv(name);
            if (value != null) {
                names.put(name, value);
            }
        }
        return names;
    }

    void unregisterRoot(Path root) {
        directoryRegistry.removeRoot(root);
        toolRegistry.unregisterExternal(providerKey(root));
        retireAll(residentToolsByRoot.remove(root));
        mcpServers.disableDeclaredByRoot(originKey(root));
        log.info("extension root {} unregistered", root);
    }

    /**
     * MCP 声明落库（docs/31 §5.3）：声明与手工连接器冲突时 McpServerService
     * 保留既有连接器并返回告警——声明级 fail-closed，不牵连同根其他插件。
     */
    private void registerMcpDeclarations(
            Path root,
            List<ExtensionScanner.ScannedMcpServer> servers
    ) {
        for (ExtensionScanner.ScannedMcpServer server : servers) {
            try {
                String warning = mcpServers.upsertDeclared(
                        server.declaration(),
                        originKey(root),
                        server.declarationFile().toString()
                );
                if (warning != null) {
                    log.warn("extension mcp declaration rejected: {}", warning);
                }
            } catch (RuntimeException exception) {
                log.error(
                        "extension mcp declaration {} failed: {}",
                        server.declarationFile(),
                        exception.getMessage()
                );
            }
        }
    }

    private String originKey(Path root) {
        return root.toAbsolutePath().normalize().toString();
    }

    private void retireAll(List<ResidentProcessTool> tools) {
        if (tools != null) {
            tools.forEach(ResidentProcessTool::retire);
        }
    }

    private String providerKey(Path root) {
        return "extension:" + root.toAbsolutePath().normalize();
    }

    private void startWatcher(List<Path> roots) {
        List<Path> existing = roots.stream()
                .filter(Files::isDirectory)
                .toList();
        if (existing.isEmpty()) {
            return;
        }
        try {
            watchService = FileSystems.getDefault().newWatchService();
        } catch (IOException exception) {
            log.warn(
                    "extension watch unavailable; changes need restart: {}",
                    exception.getMessage()
            );
            return;
        }
        scheduler = Executors.newSingleThreadScheduledExecutor(runnable -> {
            Thread thread = new Thread(runnable, "extension-rescan");
            thread.setDaemon(true);
            return thread;
        });
        watchedRootPaths.addAll(existing);
        for (Path root : existing) {
            registerTree(root);
        }
        watchThread = Thread.ofVirtual()
                .name("extension-watch")
                .start(this::watchLoop);
    }

    private void watchLoop() {
        while (!Thread.currentThread().isInterrupted()) {
            WatchKey key;
            try {
                key = watchService.take();
            } catch (InterruptedException exception) {
                Thread.currentThread().interrupt();
                return;
            } catch (ClosedWatchServiceException closed) {
                return;
            }
            Path directory = (Path) key.watchable();
            for (WatchEvent<?> event : key.pollEvents()) {
                if (event.kind() == StandardWatchEventKinds.OVERFLOW) {
                    continue;
                }
                if (event.kind() == StandardWatchEventKinds.ENTRY_CREATE) {
                    Path created = directory.resolve((Path) event.context());
                    if (Files.isDirectory(created)) {
                        registerTree(created);
                    }
                }
            }
            boolean valid = key.reset();
            if (!valid) {
                registeredDirectories.remove(directory);
            }
            Path root = rootOf(directory);
            if (root == null) {
                continue;
            }
            if (directory.equals(root) && (!valid || !Files.isDirectory(root))) {
                scheduleRemoval(root);
            } else {
                scheduleRescan(root);
            }
        }
    }

    private Path rootOf(Path directory) {
        for (Path root : watchedRootPaths) {
            if (directory.startsWith(root)) {
                return root;
            }
        }
        return null;
    }

    private void registerTree(Path root) {
        if (watchService == null) {
            return;
        }
        List<Path> directories;
        try (Stream<Path> walk = Files.walk(root)) {
            directories = walk.filter(Files::isDirectory).toList();
        } catch (IOException | UncheckedIOException exception) {
            log.warn("cannot walk {}: {}", root, exception.getMessage());
            return;
        }
        for (Path directory : directories) {
            if (!registeredDirectories.add(directory)) {
                continue;
            }
            try {
                directory.register(
                        watchService,
                        StandardWatchEventKinds.ENTRY_CREATE,
                        StandardWatchEventKinds.ENTRY_MODIFY,
                        StandardWatchEventKinds.ENTRY_DELETE
                );
            } catch (IOException exception) {
                registeredDirectories.remove(directory);
                log.warn(
                        "cannot watch {}: {}",
                        directory,
                        exception.getMessage()
                );
            }
        }
    }

    private void scheduleRescan(Path root) {
        ScheduledFuture<?> previous = pendingRescans.remove(root);
        if (previous != null) {
            previous.cancel(false);
        }
        pendingRescans.put(root, scheduler.schedule(
                () -> {
                    pendingRescans.remove(root);
                    scanAndRegister(root);
                },
                properties.getScanDebounceMs(),
                TimeUnit.MILLISECONDS
        ));
    }

    private void scheduleRemoval(Path root) {
        ScheduledFuture<?> previous = pendingRescans.remove(root);
        if (previous != null) {
            previous.cancel(false);
        }
        pendingRescans.put(root, scheduler.schedule(
                () -> {
                    pendingRescans.remove(root);
                    watchedRootPaths.remove(root);
                    unregisterRoot(root);
                },
                properties.getScanDebounceMs(),
                TimeUnit.MILLISECONDS
        ));
    }

    @Override
    public void destroy() {
        residentToolsByRoot.values().forEach(this::retireAll);
        residentToolsByRoot.clear();
        if (watchThread != null) {
            watchThread.interrupt();
        }
        if (watchService != null) {
            try {
                watchService.close();
            } catch (IOException ignored) {
            }
        }
        if (scheduler != null) {
            scheduler.shutdownNow();
        }
    }
}
