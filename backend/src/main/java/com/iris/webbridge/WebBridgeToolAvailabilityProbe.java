package com.iris.webbridge;

import com.iris.tools.core.CapabilityAvailability.Status;
import com.iris.tools.core.ToolAvailabilityProbe;
import com.iris.tools.core.ToolRegistry.ToolBinding;
import org.springframework.stereotype.Component;

import java.util.Optional;
import java.util.Set;

@Component
public class WebBridgeToolAvailabilityProbe
        implements ToolAvailabilityProbe {

    private static final Set<String> REQUIRES_RUNTIME = Set.of(
            "list_browser_sessions",
            "open_browser_session",
            "observe_browser_page",
            "wait_browser_page",
            "navigate_browser_page",
            "click_browser_element",
            "fill_browser_field",
            "select_browser_option",
            "capture_browser_screenshot",
            "inspect_browser_action",
            "close_browser_session"
    );

    private final BrowserRuntimeService runtimes;

    public WebBridgeToolAvailabilityProbe(
            BrowserRuntimeService runtimes
    ) {
        this.runtimes = runtimes;
    }

    @Override
    public Optional<Assessment> assess(ToolBinding binding) {
        String name = binding.manifest().name();
        if ("list_browser_runtimes".equals(name)) {
            return Optional.of(new Assessment(
                    Status.AVAILABLE,
                    "Browser Runtime Catalog 可以读取"
            ));
        }
        if (!REQUIRES_RUNTIME.contains(name)) {
            return Optional.empty();
        }
        if (!runtimes.hasConfiguredRuntime()) {
            return Optional.of(new Assessment(
                    Status.UNAVAILABLE,
                    "当前没有配置 Browser Runtime 对象"
            ));
        }
        if (!runtimes.hasAvailableRuntime()) {
            return Optional.of(new Assessment(
                    Status.UNAVAILABLE,
                    "已配置的 Browser Runtime 当前均不可达或协议不兼容"
            ));
        }
        return Optional.of(new Assessment(
                Status.AVAILABLE,
                "至少一个 Browser Runtime 可以承接调用"
        ));
    }
}
