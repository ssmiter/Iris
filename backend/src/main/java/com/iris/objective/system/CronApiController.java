package com.iris.objective.system;

import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.node.ObjectNode;
import com.iris.schedule.CronScheduleService;
import org.springframework.http.HttpStatus;
import org.springframework.http.ResponseEntity;
import org.springframework.jdbc.core.simple.JdbcClient;
import org.springframework.web.bind.annotation.DeleteMapping;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.PutMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RequestParam;
import org.springframework.web.bind.annotation.RestController;
import org.springframework.web.server.ResponseStatusException;

import java.time.Instant;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

/**
 * 定时任务 API（WonWork 契约形状 /api/cron/*，对照 CronController.cs + CronJobService）。
 *
 * <p>形状对齐 WonWork CronJobDto：{id,name,description,cronExpression,executionMode,
 * payload,isEnabled,status,createdAt,updatedAt,lastRunAt,nextRunAt,runCount,
 * staleAfterDays,stalePolicy}，列表包 {tasks:[]}。前端是调度状态唯一计算者
 * （nextRunAt 由前端 cron-parser 预算上报）；executionMode=llm_prompt 时
 * payload.prompt 承载提示词，到点由 CronScheduleLauncher 建会话执行。</p>
 *
 * <p>数据源：cron_schedule_config(task_id, dto_json) 为契约读面权威（前端拥有
 * description/executionMode/payload/stale 字段）；cron_task 保留为执行真相
 * （CronScheduleLauncher 到点触发读 prompt）。写操作双写两表。</p>
 */
@RestController
@RequestMapping("/api/cron")
public class CronApiController {

    private final CronScheduleService schedules;
    private final JdbcClient jdbc;
    private final ObjectMapper om = new ObjectMapper();

    public CronApiController(CronScheduleService schedules, JdbcClient jdbc) {
        this.schedules = schedules;
        this.jdbc = jdbc;
    }

    /** GET /api/cron —— 任务列表，包 {tasks:[CronJobDto]}。 */
    @GetMapping
    public Map<String, Object> list() {
        List<Map<String, Object>> tasks = new ArrayList<>();
        for (CronScheduleService.ScheduleView v : schedules.list()) {
            tasks.add(toDto(v));
        }
        return Map.of("tasks", tasks);
    }

    /** GET /api/cron/{id} —— 单条（WonWork GetById）。 */
    @GetMapping("/{taskId}")
    public Map<String, Object> getById(@PathVariable String taskId) {
        return toDto(requireView(taskId));
    }

    /** POST /api/cron —— 新建（nextRunAt 前端预算优先）。 */
    @PostMapping
    public Map<String, Object> create(@RequestBody CronCreateRequest request) {
        if (request == null) {
            throw new ResponseStatusException(HttpStatus.BAD_REQUEST, "请求体不能为空");
        }
        String prompt = extractPrompt(request.payload(), request.description(), request.name());
        boolean enabled = request.isEnabled() == null || request.isEnabled();
        CronScheduleService.ScheduleView created = schedules.create(
                request.name(),
                request.cronExpression(),
                prompt,
                enabled,
                false,
                "user");
        // 契约读面落 cron_schedule_config（含前端拥有的 description/payload/stale 字段）
        ObjectNode dto = baseDto(created);
        if (request.description() != null) dto.put("description", request.description());
        if (request.executionMode() != null) dto.put("executionMode", request.executionMode());
        if (request.payload() != null) dto.set("payload", om.valueToTree(request.payload()));
        dto.put("isEnabled", enabled);
        if (request.nextRunAt() != null && enabled) {
            dto.put("nextRunAt", request.nextRunAt());
        }
        saveConfig(created.taskId(), dto);
        return toDto(requireView(created.taskId()));
    }

    /** PUT /api/cron/{id} —— 更新（字段 null 保留旧值）。 */
    @PutMapping("/{taskId}")
    public Map<String, Object> update(
            @PathVariable String taskId,
            @RequestBody CronUpdateRequest request
    ) {
        CronScheduleService.ScheduleView current = requireView(taskId);
        String prompt = request.payload() != null
                ? extractPrompt(request.payload(), request.description(), request.name())
                : null;
        CronScheduleService.ScheduleView updated = schedules.update(
                taskId,
                current.version(),
                request.name(),
                request.cronExpression(),
                prompt,
                null);
        if (request.isEnabled() != null && request.isEnabled() != updated.enabled()) {
            updated = schedules.setEnabled(taskId, updated.version(), request.isEnabled());
        }
        ObjectNode dto = baseDto(updated);
        if (request.description() != null) dto.put("description", request.description());
        if (request.executionMode() != null) dto.put("executionMode", request.executionMode());
        if (request.payload() != null) dto.set("payload", om.valueToTree(request.payload()));
        if (request.nextRunAt() != null) dto.put("nextRunAt", request.nextRunAt());
        if (request.isEnabled() != null) dto.put("isEnabled", request.isEnabled());
        saveConfig(taskId, dto);
        return toDto(requireView(taskId));
    }

    /** DELETE /api/cron/{id} —— 删除（对齐 WonWork 204）。 */
    @DeleteMapping("/{taskId}")
    public ResponseEntity<Void> delete(@PathVariable String taskId) {
        CronScheduleService.ScheduleView current = requireView(taskId);
        jdbc.sql("DELETE FROM cron_schedule_config WHERE task_id = :taskId")
                .param("taskId", taskId).update();
        schedules.delete(taskId, current.version());
        return ResponseEntity.noContent().build();
    }

    /** POST /api/cron/{id}/toggle —— 翻转启用态；启用时 nextRunAt 前端预算覆盖。 */
    @PostMapping("/{taskId}/toggle")
    public Map<String, Object> toggle(
            @PathVariable String taskId,
            @RequestBody(required = false) CronToggleRequest request
    ) {
        CronScheduleService.ScheduleView current = requireView(taskId);
        boolean target = !current.enabled();
        schedules.setEnabled(taskId, current.version(), target);
        ObjectNode dto = baseDto(requireView(taskId));
        if (target && request != null && request.nextRunAt() != null) {
            dto.put("nextRunAt", request.nextRunAt());
        }
        if (!target) {
            dto.putNull("nextRunAt");
        }
        dto.put("isEnabled", target);
        saveConfig(taskId, dto);
        return toDto(requireView(taskId));
    }

    /** POST /api/cron/{id}/run —— 手动触发一次（记执行历史，推进调度状态）。 */
    @PostMapping("/{taskId}/run")
    public Map<String, Object> run(@PathVariable String taskId) {
        requireView(taskId);
        Instant now = Instant.now();
        // WonWork：立即执行（同步）。Iris 后端不直接跑 LLM——记一条 running，
        // 由 Launcher/前端 Runtime 承接真实执行并回报。这里对齐形状先记 execution。
        recordExecution(taskId, now, "running", null, null, null);
        // 推进执行真相调度状态（recordManualFire 包私有，这里内联等价 SQL）
        jdbc.sql("""
                UPDATE cron_task
                SET last_fire_at = :now, fire_count = fire_count + 1,
                    version = version + 1, updated_at = :now
                WHERE task_id = :taskId
                """)
                .param("now", now.toString())
                .param("taskId", taskId)
                .update();
        ObjectNode dto = baseDto(requireView(taskId));
        dto.put("lastRunAt", now.toString());
        saveConfig(taskId, dto);
        Map<String, Object> exec = new LinkedHashMap<>();
        exec.put("taskId", taskId);
        exec.put("triggeredAt", now.toString());
        exec.put("status", "running");
        exec.put("coalescedCount", 0);
        exec.put("stale", false);
        return exec;
    }

    /**
     * POST /api/cron/{id}/execution-report —— 前端本地执行完成后的回报。
     * 前端是调度状态唯一计算者：下次执行时间由本地 cron-parser 算好一并上报，
     * 后端据此回写 next_run_at/last_run_at/run_count 并记一条 executions 历史。
     * 单次任务：nextRunAt=null + disableAfterReport=true（执行后自动停用）。
     */
    @PostMapping("/{taskId}/execution-report")
    public Map<String, Object> executionReport(
            @PathVariable String taskId,
            @RequestBody CronExecutionReportRequest request
    ) {
        CronScheduleService.ScheduleView current = requireView(taskId);
        Instant now = Instant.now();
        Instant triggeredAt = request.triggeredAt() != null
                ? Instant.parse(request.triggeredAt()) : now;
        String status = request.status() == null ? "completed" : request.status();
        recordExecution(taskId, triggeredAt, status,
                request.output(), request.errorMessage(), request.executionTimeMs());

        ObjectNode dto = baseDto(requireView(taskId));
        dto.put("lastRunAt", triggeredAt.toString());
        dto.put("status", status);
        boolean disableAfter = request.disableAfterReport() != null && request.disableAfterReport();
        if (disableAfter) {
            dto.putNull("nextRunAt");
            dto.put("isEnabled", false);
        } else if (request.nextRunAt() != null) {
            dto.put("nextRunAt", request.nextRunAt());
        }
        saveConfig(taskId, dto);
        // 同步执行真相表启用态（单次任务执行后停用）
        if (disableAfter && current.enabled()) {
            schedules.setEnabled(taskId, requireView(taskId).version(), false);
        }
        return toDto(requireView(taskId));
    }

    /** GET /api/cron/{id}/executions?limit —— 执行历史（对齐 WonWork CronJobResultDto）。 */
    @GetMapping("/{taskId}/executions")
    public List<Map<String, Object>> executions(
            @PathVariable String taskId,
            @RequestParam(defaultValue = "20") int limit
    ) {
        int bounded = Math.min(Math.max(limit, 1), 100);
        List<Map<String, Object>> out = new ArrayList<>();
        for (CronScheduleService.ExecutionView e : schedules.executions(taskId, bounded)) {
            Map<String, Object> m = new LinkedHashMap<>();
            m.put("taskId", e.taskId());
            m.put("triggeredAt", e.firedAt().toString());
            m.put("status", e.status());
            m.put("coalescedCount", 0);
            m.put("stale", false);
            // WonWork 读面 output/errorMessage/executionTimeMs 由 cron_execution 补列承载；
            // 既有 ExecutionView 未扩，先回 null（形状对齐，数据列已建待 ExecutionView 扩充）。
            m.put("output", null);
            m.put("errorMessage", e.error());
            m.put("executionTimeMs", null);
            out.add(m);
        }
        return out;
    }

    // ---------- 契约读面 cron_schedule_config ----------

    private void saveConfig(String taskId, ObjectNode dto) {
        dto.put("updatedAt", Instant.now().toString());
        jdbc.sql("""
                INSERT INTO cron_schedule_config(task_id, dto_json, updated_at)
                VALUES (:taskId, :dtoJson, :now)
                ON CONFLICT(task_id) DO UPDATE SET
                    dto_json = excluded.dto_json, updated_at = excluded.updated_at
                """)
                .param("taskId", taskId)
                .param("dtoJson", dto.toString())
                .param("now", Instant.now().toString())
                .update();
    }

    private void recordExecution(
            String taskId, Instant firedAt, String status,
            String output, String errorMessage, Long executionTimeMs) {
        String executionId = "cronex_" + java.util.UUID.randomUUID().toString().replace("-", "");
        jdbc.sql("""
                INSERT INTO cron_execution(
                    execution_id, task_id, trigger_kind, fired_at,
                    conversation_id, run_id, status, error, output, error_message, execution_time_ms
                ) VALUES (
                    :executionId, :taskId, :triggerKind, :firedAt,
                    NULL, NULL, :status, :error, :output, :errorMessage, :executionTimeMs
                )
                """)
                .param("executionId", executionId)
                .param("taskId", taskId)
                .param("triggerKind", "manual")
                .param("firedAt", firedAt.toString())
                .param("status", status)
                .param("error", errorMessage)
                .param("output", output)
                .param("errorMessage", errorMessage)
                .param("executionTimeMs", executionTimeMs)
                .update();
    }

    /** 从执行真相组装基础 DTO（cron_task 列）。 */
    private ObjectNode baseDto(CronScheduleService.ScheduleView v) {
        ObjectNode n = om.createObjectNode();
        n.put("id", v.taskId());
        n.put("name", v.name());
        n.put("cronExpression", v.expression());
        n.put("isEnabled", v.enabled());
        n.put("status", "pending");
        n.put("createdAt", v.createdAt().toString());
        n.put("updatedAt", v.updatedAt().toString());
        if (v.lastFireAt() != null) n.put("lastRunAt", v.lastFireAt().toString());
        if (v.nextFireAt() != null) n.put("nextRunAt", v.nextFireAt().toString());
        n.put("runCount", v.fireCount());
        n.put("staleAfterDays", 7);
        n.put("stalePolicy", "notify_and_delete");
        n.put("executionMode", "llm_prompt");
        n.set("payload", om.createObjectNode());
        return n;
    }

    /** 读 cron_schedule_config 契约 JSON 覆盖基础 DTO（前端拥有字段优先）。 */
    private Map<String, Object> toDto(CronScheduleService.ScheduleView v) {
        ObjectNode base = baseDto(v);
        String configJson = jdbc.sql(
                        "SELECT dto_json FROM cron_schedule_config WHERE task_id = :taskId")
                .param("taskId", v.taskId())
                .query(String.class)
                .optional()
                .orElse(null);
        if (configJson != null) {
            try {
                ObjectNode config = (ObjectNode) om.readTree(configJson);
                // 前端拥有字段：description/executionMode/payload/staleAfterDays/stalePolicy
                overlay(config, base, "description");
                overlay(config, base, "executionMode");
                overlay(config, base, "staleAfterDays");
                overlay(config, base, "stalePolicy");
                if (config.has("payload")) base.set("payload", config.get("payload"));
            } catch (Exception ignored) {
                // 契约 JSON 损坏回退执行真相
            }
        }
        return om.convertValue(base, Map.class);
    }

    private static void overlay(ObjectNode from, ObjectNode to, String field) {
        if (from.has(field)) to.set(field, from.get(field));
    }

    /** payload.prompt 承载提示词；无则退化为 description/name（对齐 WonWork 语义）。 */
    private static String extractPrompt(
            Map<String, Object> payload, String description, String name) {
        if (payload != null && payload.get("prompt") instanceof String p && !p.isBlank()) {
            return p.trim();
        }
        if (description != null && !description.isBlank()) return description.trim();
        return name == null ? "" : name.trim();
    }

    private CronScheduleService.ScheduleView requireView(String taskId) {
        try {
            return schedules.require(taskId);
        } catch (IllegalArgumentException ex) {
            throw new ResponseStatusException(HttpStatus.NOT_FOUND, ex.getMessage());
        }
    }

    // ---------- 请求 DTO ----------

    public record CronCreateRequest(
            String name,
            String description,
            String cronExpression,
            String executionMode,
            Map<String, Object> payload,
            Boolean isEnabled,
            String nextRunAt
    ) { }

    public record CronUpdateRequest(
            String name,
            String description,
            String cronExpression,
            String executionMode,
            Map<String, Object> payload,
            Boolean isEnabled,
            String nextRunAt
    ) { }

    public record CronToggleRequest(String nextRunAt) { }

    public record CronExecutionReportRequest(
            String status,
            String output,
            String errorMessage,
            Long executionTimeMs,
            String triggeredAt,
            String nextRunAt,
            Boolean disableAfterReport
    ) { }
}
