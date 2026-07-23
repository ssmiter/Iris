package com.weave.tools.core;

import org.springframework.stereotype.Component;

import java.util.Collection;
import java.util.LinkedHashMap;
import java.util.Map;
import java.util.Optional;

/**
 * 工具注册表（docs/03 §3）。
 * - 双索引：按 name 的 Map 保证 snake_case 调用 O(1) 命中（不允许 O(N) 遍历兜底）；
 * - 注册即校验：name 冲突直接启动失败（fail-fast，问题留在开发期）。
 */
@Component
public class ToolRegistry {

    private final Map<String, Tool> byName = new LinkedHashMap<>();

    public synchronized void register(Tool tool) {
        Tool prev = byName.putIfAbsent(tool.name(), tool);
        if (prev != null) {
            throw new IllegalStateException(
                    "工具名冲突: " + tool.name() + " (" + prev.getClass().getName()
                            + " vs " + tool.getClass().getName() + ")");
        }
    }

    public Optional<Tool> find(String name) {
        return Optional.ofNullable(byName.get(name));
    }

    public Collection<Tool> all() {
        return byName.values();
    }

    public int size() {
        return byName.size();
    }
}
