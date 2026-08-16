package com.iris.extension;

import com.fasterxml.jackson.databind.ObjectMapper;
import com.iris.execution.WorkspaceProcessRunner;
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
            ObjectMapper objectMapper,
            @Value("${iris.workspace:~/Iris/workspace}") String workspaceDir
    ) {
        this.properties = properties;
        this.scanner = scanner;
        this.directoryRegistry = directoryRegistry;
        this.toolRegistry = toolRegistry;
        this.processRunner = processRunner;
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
     * 根解析：内建根（rank 50）永远最先扫描；roots 为空时补默认自有两层
     * （工作区级 → 机器级，docs/31 §5.2）。
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
        roots.add(Path.of(workspaceDir)
                .resolve(".iris/extensions").toAbsolutePath().normalize());
        roots.add(Path.of(System.getProperty("user.home"))
                .resolve(".iris/extensions").toAbsolutePath().normalize());
        return roots;
    }

    /** 扫描一个根并原子换入注册表；扫描问题 fail-closed 记录但不影响其他根。 */
    void scanAndRegister(Path root) {
        ExtensionScanner.ScanResult result = scanner.scan(root);
        for (String problem : result.problems()) {
            log.warn("extension rejected: {}", problem);
        }
        directoryRegistry.replaceRoot(root, result.directories());

        List<ToolRegistry.ExternalToolRegistration> registrations =
                new ArrayList<>();
        List<ResidentProcessTool> residentTools = new ArrayList<>();
        for (ExtensionScanner.ScannedTool scanned : result.tools()) {
            Tool tool;
            if ("process".equals(scanned.definition().kind())) {
                ResidentProcessTool resident = new ResidentProcessTool(
                        scanned.definition(),
                        scanned.pluginDir(),
                        scanned.contentVersion(),
                        objectMapper
                );
                residentTools.add(resident);
                tool = resident;
            } else {
                tool = new TemplateProcessTool(
                        scanned.definition(),
                        scanned.pluginDir(),
                        scanned.contentVersion(),
                        processRunner,
                        objectMapper
                );
            }
            registrations.add(new ToolRegistry.ExternalToolRegistration(
                    scanned.capabilityPath(),
                    tool
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

    void unregisterRoot(Path root) {
        directoryRegistry.removeRoot(root);
        toolRegistry.unregisterExternal(providerKey(root));
        retireAll(residentToolsByRoot.remove(root));
        log.info("extension root {} unregistered", root);
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
