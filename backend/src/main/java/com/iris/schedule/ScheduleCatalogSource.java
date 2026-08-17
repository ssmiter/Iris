package com.iris.schedule;

import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.node.ObjectNode;
import com.iris.tools.catalog.CapabilityCatalogSource;
import org.springframework.stereotype.Component;

import java.security.MessageDigest;
import java.security.NoSuchAlgorithmException;
import java.nio.charset.StandardCharsets;
import java.util.HexFormat;
import java.util.List;

/**
 * 定时任务的能力树投影（docs/33 §3）：启用的任务作为 kind=schedule
 * 叶子出现在 /system/schedule 下，与工具、MCP、skill 经同一棵树被发现。
 * 停用的任务不进模型视野（发现纪律：不会触发的东西不该占用探索注意力），
 * 管理页经 /api/v1/schedules 看到全部——树投影与管理真相各看各的口径。
 */
@Component
public class ScheduleCatalogSource implements CapabilityCatalogSource {

    public static final String DIRECTORY = "/system/schedule";

    private final CronScheduleService schedules;
    private final ObjectMapper objectMapper;

    public ScheduleCatalogSource(
            CronScheduleService schedules,
            ObjectMapper objectMapper
    ) {
        this.schedules = schedules;
        this.objectMapper = objectMapper;
    }

    @Override
    public List<Definition> definitions() {
        return schedules.list().stream()
                .filter(CronScheduleService.ScheduleView::enabled)
                .map(this::catalogDefinition)
                .toList();
    }

    private Definition catalogDefinition(
            CronScheduleService.ScheduleView task
    ) {
        ObjectNode manifest = objectMapper.createObjectNode();
        manifest.put("id", task.taskId());
        manifest.put("version", Long.toString(task.version()));
        manifest.put("kind", "schedule");
        manifest.put("name", task.name());
        manifest.put("title", task.name());
        manifest.put("capabilityPath", pathOf(task.taskId()));
        manifest.put("expression", task.expression());
        manifest.put("prompt", task.prompt());
        manifest.put("enabled", true);
        manifest.put("nextFireAt", task.nextFireAt() == null
                ? null : task.nextFireAt().toString());
        manifest.put("lastFireAt", task.lastFireAt() == null
                ? null : task.lastFireAt().toString());
        manifest.put("fireCount", task.fireCount());
        manifest.put("createdBy", task.createdBy());
        // 叶子无入参（触发走调度或 run_schedule_now），空 schema 保持契约完整
        ObjectNode inputSchema = manifest.putObject("inputSchema");
        inputSchema.put("type", "object");
        inputSchema.putObject("properties");
        String manifestHash = hash(manifest.toString());
        return new Definition(
                task.taskId(),
                Long.toString(task.version()),
                "schedule",
                task.name(),
                pathOf(task.taskId()),
                "定时任务（" + task.expression()
                        + "）：到点以其 prompt 自动开启新会话执行",
                "standard",
                "available",
                "已启用，下次触发 " + task.nextFireAt(),
                manifestHash,
                manifest
        );
    }

    private String pathOf(String taskId) {
        return DIRECTORY + "/" + taskId;
    }

    private String hash(String value) {
        try {
            return HexFormat.of().formatHex(
                    MessageDigest.getInstance("SHA-256").digest(
                            value.getBytes(StandardCharsets.UTF_8)
                    )
            );
        } catch (NoSuchAlgorithmException exception) {
            throw new IllegalStateException("SHA-256 unavailable", exception);
        }
    }
}
