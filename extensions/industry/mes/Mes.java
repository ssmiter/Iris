import java.io.BufferedReader;
import java.io.BufferedWriter;
import java.io.IOException;
import java.io.InputStreamReader;
import java.io.OutputStreamWriter;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.sql.Connection;
import java.sql.DriverManager;
import java.sql.PreparedStatement;
import java.sql.ResultSet;
import java.sql.ResultSetMetaData;
import java.sql.SQLException;
import java.sql.Statement;
import java.time.Instant;
import java.time.LocalDate;
import java.time.format.DateTimeParseException;
import java.util.ArrayList;
import java.util.Comparator;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Properties;
import java.util.Set;
import java.util.concurrent.ConcurrentHashMap;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

/**
 * /industry/mes 常驻插件（docs/31 §4 + §11 M3c）：脱敏轮胎 MES 样例域的
 * 固定只读视图与三个业务写能力。mes/ 下每个叶子目录的 process 清单各自
 * 惰性拉起一个本进程（§3.2 按清单目录共享），invoke 帧的 tool 字段决定原语。
 *
 * <p>数据网关从内核 IndustrialDemoRepository 移植：工具只选择固定视图并
 * 归一化参数，表、SQL、行预算与结果信封集中在 Repository。演示库是
 * {workspace}/industry/mes-demo.db（workspace 来自 invoke 帧 context），
 * 首次打开时以 BEGIN IMMEDIATE + seed_marker 双检执行插件自带 seed.sql；
 * 业务写（计划维护、异常处置、APS 发布）落在这个库上，乐观守护语义与内核一致。</p>
 */
public class Mes {

    private static final String DOMAIN = "mes";
    private static final int DEFAULT_LIMIT = 50;
    private static final int MAX_LIMIT = 200;

    private static final Map<String, CallTask> inFlight =
            new ConcurrentHashMap<>();
    private static BufferedWriter out;
    private static Path pluginDir;
    private static volatile List<String> seedStatements;

    public static void main(String[] args) throws Exception {
        BufferedReader in = new BufferedReader(new InputStreamReader(
                System.in, StandardCharsets.UTF_8));
        out = new BufferedWriter(new OutputStreamWriter(
                System.out, StandardCharsets.UTF_8));
        pluginDir = Path.of(Mes.class.getProtectionDomain()
                .getCodeSource().getLocation().toURI()).getParent();
        String line;
        while ((line = in.readLine()) != null) {
            if (line.isBlank()) {
                continue;
            }
            Object frame;
            try {
                frame = Json.parse(line);
            } catch (RuntimeException parseFailure) {
                continue;
            }
            if (!(frame instanceof Map<?, ?> message)) {
                continue;
            }
            String callId = message.get("callId") instanceof String text
                    ? text : null;
            if (callId == null) {
                continue;
            }
            if ("cancel".equals(message.get("type"))) {
                CallTask task = inFlight.get(callId);
                if (task != null) {
                    task.cancel();
                }
                continue;
            }
            if (!"invoke".equals(message.get("type"))) {
                continue;
            }
            CallTask task = new CallTask(callId, message);
            inFlight.put(callId, task);
            Thread.ofVirtual().name("mes-" + callId).start(task);
        }
        // stdin EOF = 内核退出：取消在途调用并等结果帧写出后再退出
        // （虚拟线程是 daemon，main 返回即 JVM 退出）。
        inFlight.values().forEach(CallTask::cancel);
        long deadline = System.currentTimeMillis() + 10_000;
        while (!inFlight.isEmpty()
                && System.currentTimeMillis() < deadline) {
            try {
                Thread.sleep(20);
            } catch (InterruptedException interrupted) {
                Thread.currentThread().interrupt();
                break;
            }
        }
    }

    /** 一次 invoke；结果帧恰好写一次。 */
    private static final class CallTask implements Runnable {
        private final Call call;
        private final Map<?, ?> message;

        CallTask(String callId, Map<?, ?> message) {
            this.call = new Call(callId);
            this.message = message;
        }

        void cancel() {
            call.cancel();
        }

        @Override
        public void run() {
            Map<String, Object> result = new LinkedHashMap<>();
            result.put("type", "result");
            result.put("callId", call.id);
            try {
                call.check();
                result.putAll(dispatch(call));
            } catch (Cancelled ignored) {
                result.clear();
                result.put("type", "result");
                result.put("callId", call.id);
                result.put("success", false);
                result.put("error", error(
                        "cancelled", "调用已取消，没有改变数据库状态"));
            } catch (Failure failure) {
                result.put("success", false);
                result.put("error", error(failure.code, failure.getMessage()));
            } catch (Exception unexpected) {
                result.put("success", false);
                result.put("error", error(
                        "mes_plugin_internal_error",
                        "插件内部错误: " + unexpected));
            } finally {
                inFlight.remove(call.id);
                writeFrame(result);
            }
        }

        private Map<String, Object> dispatch(Call call) throws Exception {
            String tool = message.get("tool") instanceof String text
                    ? text : "";
            Map<?, ?> input = message.get("input")
                    instanceof Map<?, ?> map ? map : Map.of();
            Map<?, ?> context = message.get("context")
                    instanceof Map<?, ?> map ? map : Map.of();
            return Actions.dispatch(call, tool, input, context);
        }
    }

    /** 调用级取消上下文：cancel 帧到达时中止在途 JDBC 语句。 */
    static final class Call {
        final String id;
        private volatile boolean cancelled;
        private volatile Statement pendingStatement;

        Call(String id) {
            this.id = id;
        }

        void cancel() {
            cancelled = true;
            Statement statement = pendingStatement;
            if (statement != null) {
                try {
                    statement.cancel();
                } catch (SQLException ignored) {
                    // 取消失败由 Runtime deadline 继续收敛。
                }
            }
        }

        void check() throws Cancelled {
            if (cancelled) {
                throw new Cancelled();
            }
        }

        void track(Statement statement) {
            pendingStatement = statement;
            if (cancelled) {
                try {
                    statement.cancel();
                } catch (SQLException ignored) {
                    // 同上。
                }
            }
        }

        void untrack(Statement statement) {
            if (pendingStatement == statement) {
                pendingStatement = null;
            }
        }
    }

    // ------------------------------------------------------------------
    // 原语实现：36 个只读视图 + 3 个业务写。
    // ------------------------------------------------------------------
    static final class Actions {
        private Actions() {
        }

        /** 工序记录查询（process_record 固定视图）。 */
        private record ProcessQuery(
                String process, String view, Set<String> recordTypes) {
        }

        /** 版本化业务对象查询（reference_object 固定视图）。 */
        private record ReferenceQuery(Set<String> objectTypes, String view) {
        }

        private static final Map<String, ProcessQuery> PROCESS_QUERIES =
                new LinkedHashMap<>();
        private static final Map<String, ReferenceQuery> REFERENCE_QUERIES =
                new LinkedHashMap<>();

        static {
            PROCESS_QUERIES.put("query_mes_raw_incoming_quality",
                    new ProcessQuery("raw", "raw_incoming_quality",
                            Set.of("inspection")));
            PROCESS_QUERIES.put("query_mes_mixing_consumption",
                    new ProcessQuery("mixing", "mixing_consumption",
                            Set.of("consumption")));
            PROCESS_QUERIES.put("query_mes_semifinished_production_inventory",
                    new ProcessQuery("semifinished",
                            "semifinished_production_inventory",
                            Set.of("production", "inventory")));
            PROCESS_QUERIES.put("query_mes_forming_plan_execution",
                    new ProcessQuery("forming", "forming_plan_execution",
                            Set.of("plan", "production")));
            PROCESS_QUERIES.put("query_mes_forming_wip",
                    new ProcessQuery("forming", "forming_wip",
                            Set.of("wip")));
            PROCESS_QUERIES.put("query_mes_curing_plan_execution",
                    new ProcessQuery("curing", "curing_plan_execution",
                            Set.of("plan", "production")));
            PROCESS_QUERIES.put("query_mes_finished_quality_records",
                    new ProcessQuery("quality", "finished_quality_records",
                            Set.of("inspection", "exception")));
            PROCESS_QUERIES.put("query_mes_finished_goods_inventory_movements",
                    new ProcessQuery("warehouse",
                            "finished_goods_inventory_movements",
                            Set.of("inventory", "movement")));
            PROCESS_QUERIES.put("query_mes_shipments",
                    new ProcessQuery("warehouse", "warehouse_shipments",
                            Set.of("shipment")));
            PROCESS_QUERIES.put("query_mes_equipment_maintenance",
                    new ProcessQuery("equipment", "equipment_maintenance",
                            Set.of("inspection", "maintenance")));
            PROCESS_QUERIES.put("query_mes_mould_changes",
                    new ProcessQuery("mould", "mould_changes",
                            Set.of("change_plan")));
            PROCESS_QUERIES.put("query_mes_personnel_output",
                    new ProcessQuery("personnel", "personnel_output",
                            Set.of("shift_output")));
            PROCESS_QUERIES.put("query_mes_aps_demand_schedule",
                    new ProcessQuery("aps", "aps_demand_schedule",
                            Set.of("demand", "schedule")));
            PROCESS_QUERIES.put("query_mes_aps_capacity_load",
                    new ProcessQuery("aps", "aps_capacity_load",
                            Set.of("capacity")));
            PROCESS_QUERIES.put("query_mes_aps_master_plan",
                    new ProcessQuery("aps", "aps_master_plan",
                            Set.of("master_plan")));

            REFERENCE_QUERIES.put("query_mes_process_recipes",
                    new ReferenceQuery(Set.of("recipe"), "process_recipes"));
            REFERENCE_QUERIES.put("query_mes_mould_status",
                    new ReferenceQuery(Set.of("mould"), "mould_status"));
            REFERENCE_QUERIES.put("query_mes_plan_calendars",
                    new ReferenceQuery(Set.of("calendar", "shift_template"),
                            "plan_calendars"));
            REFERENCE_QUERIES.put("query_mes_boms",
                    new ReferenceQuery(Set.of("bom"), "boms"));
            REFERENCE_QUERIES.put("query_mes_process_standards",
                    new ReferenceQuery(Set.of("process_standard"),
                            "process_standards"));
            REFERENCE_QUERIES.put("query_mes_shift_teams",
                    new ReferenceQuery(Set.of("team"), "shift_teams"));
            REFERENCE_QUERIES.put("query_mes_aps_rules",
                    new ReferenceQuery(Set.of("scheduling_rule"),
                            "aps_rules"));
        }

        private static final Set<String> MOVEMENT_TYPES =
                Set.of("receipt", "issue", "return");
        private static final Set<String> PLAN_STATUSES =
                Set.of("scheduled", "running", "completed", "paused");
        private static final Set<String> SEVERITIES =
                Set.of("info", "low", "medium", "high");
        private static final Set<String> JUDGE_RESULTS = Set.of("pass", "fail");
        private static final Set<String> QUALITY_STATES =
                Set.of("pending", "pass", "fail");
        private static final Set<String> EXCEPTION_STATUSES =
                Set.of("open", "disposed", "closed");
        private static final Set<String> DISPOSITIONS =
                Set.of("none", "rework", "concession", "scrap");
        private static final Set<String> REPORT_PROCESSES =
                Set.of("mixing", "forming", "curing");
        private static final Set<String> EVENT_PROCESSES =
                Set.of("mixing", "forming", "curing", "quality");
        private static final Set<String> EQUIPMENT_STATES = Set.of(
                "running", "idle", "warning", "maintenance", "offline");
        private static final Set<String> DEMAND_STATES = Set.of(
                "unscheduled", "scheduled", "released", "completed");
        private static final Set<String> DEMAND_PRIORITIES =
                Set.of("high", "normal");
        private static final Set<String> WRITE_ACTIONS =
                Set.of("start", "cancel", "set_priority");
        private static final Set<String> WRITE_PRIORITIES =
                Set.of("high", "normal");
        private static final Set<String> WRITE_DISPOSITIONS =
                Set.of("rework", "concession", "scrap");
        private static final Set<String> CONFLICT_POLICIES =
                Set.of("block", "append");
        private static final Set<String> PUBLISHABLE =
                Set.of("feasible", "accepted");
        private static final Set<String> LOCKED_STATUSES =
                Set.of("running", "completed");

        static Map<String, Object> dispatch(
                Call call,
                String tool,
                Map<?, ?> input,
                Map<?, ?> context
        ) throws Exception {
            ProcessQuery processQuery = PROCESS_QUERIES.get(tool);
            if (processQuery != null) {
                return processQuery(call, input, context, processQuery);
            }
            ReferenceQuery referenceQuery = REFERENCE_QUERIES.get(tool);
            if (referenceQuery != null) {
                return referenceQuery(call, input, context, referenceQuery);
            }
            return switch (tool) {
                case "query_mes_material_inventory" ->
                        materialInventory(call, input, context);
                case "query_mes_material_movements" ->
                        materialMovements(call, input, context);
                case "query_mes_mixing_plans" ->
                        mixingPlans(call, input, context);
                case "query_mes_mixing_equipment_events" ->
                        mixingEquipmentEvents(call, input, context);
                case "query_mes_mixing_quality" ->
                        mixingQuality(call, input, context);
                case "query_mes_mixing_batches" ->
                        mixingBatches(call, input, context);
                case "query_mes_quality_exceptions" ->
                        qualityExceptions(call, input, context);
                case "query_mes_batch_trace" ->
                        batchTrace(call, input, context);
                case "report_mes_plan_execution" ->
                        reportPlanExecution(call, input, context);
                case "report_mes_quality_summary" ->
                        reportQualitySummary(call, input, context);
                case "query_mes_plan_delays" ->
                        planDelays(call, input, context);
                case "query_mes_demand_orders" ->
                        demandOrders(call, input, context);
                case "query_mes_equipment_events" ->
                        equipmentEvents(call, input, context);
                case "query_mes_equipment_status" ->
                        equipmentStatus(call, input, context);
                case "update_mes_plan" ->
                        updatePlan(call, input, context);
                case "dispose_mes_quality_exception" ->
                        disposeQualityException(call, input, context);
                case "publish_mes_aps_schedule" ->
                        publishApsSchedule(call, input, context);
                default -> throw new Failure(
                        "unknown_mes_primitive",
                        "未知 MES 原语: " + tool);
            };
        }

        // ── 共享查询骨架 ────────────────────────────────────────────

        private static Map<String, Object> processQuery(
                Call call,
                Map<?, ?> input,
                Map<?, ?> context,
                ProcessQuery spec
        ) throws Exception {
            call.check();
            Map<String, Object> normalized = normalizedBase(input);
            copyEnum(input, normalized, "record_type", spec.recordTypes());
            copyDate(input, normalized, "start_date");
            copyDate(input, normalized, "end_date");
            requireDateOrder(normalized);
            copyText(input, normalized, "item", 80);
            copyText(input, normalized, "resource_code", 40);
            copyText(input, normalized, "status", 40);
            try (Connection connection = openDemo(context)) {
                Repository repository = new Repository(call, connection);
                Map<String, Object> envelope = repository.processRecords(
                        spec.process(), spec.view(), normalized);
                call.check();
                return readOk(spec.view(), envelope);
            }
        }

        private static Map<String, Object> referenceQuery(
                Call call,
                Map<?, ?> input,
                Map<?, ?> context,
                ReferenceQuery spec
        ) throws Exception {
            call.check();
            Map<String, Object> normalized = normalizedBase(input);
            copyText(input, normalized, "query", 80);
            copyText(input, normalized, "process_code", 40);
            copyText(input, normalized, "status", 40);
            try (Connection connection = openDemo(context)) {
                Repository repository = new Repository(call, connection);
                Map<String, Object> envelope = repository.referenceObjects(
                        spec.objectTypes(), spec.view(), normalized);
                call.check();
                return readOk(spec.view(), envelope);
            }
        }

        // ── 定制只读视图 ────────────────────────────────────────────

        private static Map<String, Object> materialInventory(
                Call call, Map<?, ?> input, Map<?, ?> context)
                throws Exception {
            call.check();
            Map<String, Object> normalized = normalizedBase(input);
            copyText(input, normalized, "material", 80);
            copyText(input, normalized, "warehouse_code", 40);
            normalized.put("below_safety_stock",
                    boolAt(input, "below_safety_stock", false));
            try (Connection connection = openDemo(context)) {
                Map<String, Object> envelope = new Repository(call, connection)
                        .materialInventory(normalized);
                call.check();
                return readOk("material_inventory", envelope);
            }
        }

        private static Map<String, Object> materialMovements(
                Call call, Map<?, ?> input, Map<?, ?> context)
                throws Exception {
            call.check();
            Map<String, Object> normalized = normalizedBase(input);
            copyDate(input, normalized, "start_date");
            copyDate(input, normalized, "end_date");
            requireDateOrder(normalized);
            copyText(input, normalized, "material", 40);
            copyEnum(input, normalized, "movement_type", MOVEMENT_TYPES);
            copyText(input, normalized, "warehouse_code", 40);
            copyText(input, normalized, "related_no", 60);
            try (Connection connection = openDemo(context)) {
                Map<String, Object> envelope = new Repository(call, connection)
                        .materialMovements(normalized);
                call.check();
                return readOk("material_movements", envelope);
            }
        }

        private static Map<String, Object> mixingPlans(
                Call call, Map<?, ?> input, Map<?, ?> context)
                throws Exception {
            call.check();
            Map<String, Object> normalized = normalizedBase(input);
            copyDate(input, normalized, "start_date");
            copyDate(input, normalized, "end_date");
            requireDateOrder(normalized);
            copyText(input, normalized, "equipment_code", 40);
            copyText(input, normalized, "material_code", 40);
            copyEnum(input, normalized, "status", PLAN_STATUSES);
            try (Connection connection = openDemo(context)) {
                Map<String, Object> envelope = new Repository(call, connection)
                        .productionPlans("mixing_plans", normalized);
                call.check();
                return readOk("mixing_plans", envelope);
            }
        }

        private static Map<String, Object> mixingEquipmentEvents(
                Call call, Map<?, ?> input, Map<?, ?> context)
                throws Exception {
            call.check();
            Map<String, Object> normalized = normalizedBase(input);
            copyDate(input, normalized, "start_date");
            copyDate(input, normalized, "end_date");
            requireDateOrder(normalized);
            copyText(input, normalized, "equipment_code", 40);
            copyEnum(input, normalized, "severity", SEVERITIES);
            normalized.put("unresolved_only",
                    boolAt(input, "unresolved_only", false));
            // 本工具只覆盖密炼工序；跨工序视角见 query_mes_equipment_events。
            normalized.put("process_code", "mixing");
            try (Connection connection = openDemo(context)) {
                Map<String, Object> envelope = new Repository(call, connection)
                        .equipmentEvents("mixing_equipment_events", normalized);
                call.check();
                return readOk("mixing_equipment_events", envelope);
            }
        }

        private static Map<String, Object> mixingQuality(
                Call call, Map<?, ?> input, Map<?, ?> context)
                throws Exception {
            call.check();
            Map<String, Object> normalized = normalizedBase(input);
            copyDate(input, normalized, "start_date");
            copyDate(input, normalized, "end_date");
            requireDateOrder(normalized);
            copyText(input, normalized, "material_code", 40);
            copyText(input, normalized, "equipment_code", 40);
            copyEnum(input, normalized, "judge_result", JUDGE_RESULTS);
            try (Connection connection = openDemo(context)) {
                Map<String, Object> envelope = new Repository(call, connection)
                        .qualityMeasurements(normalized);
                call.check();
                return readOk("mixing_quality", envelope);
            }
        }

        private static Map<String, Object> mixingBatches(
                Call call, Map<?, ?> input, Map<?, ?> context)
                throws Exception {
            call.check();
            Map<String, Object> normalized = normalizedBase(input);
            copyText(input, normalized, "batch", 60);
            copyText(input, normalized, "item", 80);
            copyText(input, normalized, "plan_no", 60);
            copyText(input, normalized, "equipment_code", 40);
            copyEnum(input, normalized, "quality_state", QUALITY_STATES);
            try (Connection connection = openDemo(context)) {
                Map<String, Object> envelope = new Repository(call, connection)
                        .batches(normalized);
                call.check();
                return readOk("mixing_batches", envelope);
            }
        }

        private static Map<String, Object> qualityExceptions(
                Call call, Map<?, ?> input, Map<?, ?> context)
                throws Exception {
            call.check();
            Map<String, Object> normalized = normalizedBase(input);
            copyText(input, normalized, "item", 80);
            copyEnum(input, normalized, "status", EXCEPTION_STATUSES);
            copyEnum(input, normalized, "disposition", DISPOSITIONS);
            try (Connection connection = openDemo(context)) {
                Map<String, Object> envelope = new Repository(call, connection)
                        .qualityExceptions(normalized);
                call.check();
                return readOk("quality_exceptions", envelope);
            }
        }

        private static Map<String, Object> batchTrace(
                Call call, Map<?, ?> input, Map<?, ?> context)
                throws Exception {
            call.check();
            Map<String, Object> normalized = normalizedBase(input);
            copyText(input, normalized, "batch_no", 60);
            copyText(input, normalized, "item", 80);
            if (text(normalized, "batch_no").isBlank()
                    && text(normalized, "item").isBlank()) {
                throw invalid("batch_no 与 item 至少提供一个");
            }
            try (Connection connection = openDemo(context)) {
                Map<String, Object> envelope = new Repository(call, connection)
                        .batchTrace(normalized);
                call.check();
                return readOk("batch_trace", envelope);
            }
        }

        private static Map<String, Object> reportPlanExecution(
                Call call, Map<?, ?> input, Map<?, ?> context)
                throws Exception {
            call.check();
            Map<String, Object> normalized = normalizedBase(input);
            copyDate(input, normalized, "start_date");
            copyDate(input, normalized, "end_date");
            requireDateOrder(normalized);
            copyEnum(input, normalized, "process_code", REPORT_PROCESSES);
            try (Connection connection = openDemo(context)) {
                Map<String, Object> envelope = new Repository(call, connection)
                        .reportPlanExecution(normalized);
                call.check();
                return readOk("report_plan_execution", envelope);
            }
        }

        private static Map<String, Object> reportQualitySummary(
                Call call, Map<?, ?> input, Map<?, ?> context)
                throws Exception {
            call.check();
            Map<String, Object> normalized = normalizedBase(input);
            copyDate(input, normalized, "start_date");
            copyDate(input, normalized, "end_date");
            requireDateOrder(normalized);
            try (Connection connection = openDemo(context)) {
                Map<String, Object> envelope = new Repository(call, connection)
                        .reportQualitySummary(normalized);
                call.check();
                return readOk("report_quality_summary", envelope);
            }
        }

        private static Map<String, Object> planDelays(
                Call call, Map<?, ?> input, Map<?, ?> context)
                throws Exception {
            call.check();
            Map<String, Object> normalized = normalizedBase(input);
            copyDate(input, normalized, "as_of_date");
            if (text(normalized, "as_of_date").isBlank()) {
                throw invalid("as_of_date 必填，格式 YYYY-MM-DD");
            }
            copyEnum(input, normalized, "process_code", REPORT_PROCESSES);
            copyText(input, normalized, "equipment_code", 40);
            try (Connection connection = openDemo(context)) {
                Map<String, Object> envelope = new Repository(call, connection)
                        .planDelays(normalized);
                call.check();
                return readOk("plan_delays", envelope);
            }
        }

        private static Map<String, Object> demandOrders(
                Call call, Map<?, ?> input, Map<?, ?> context)
                throws Exception {
            call.check();
            Map<String, Object> normalized = normalizedBase(input);
            copyDate(input, normalized, "start_date");
            copyDate(input, normalized, "end_date");
            requireDateOrder(normalized);
            copyText(input, normalized, "item", 80);
            copyEnum(input, normalized, "state", DEMAND_STATES);
            copyEnum(input, normalized, "priority", DEMAND_PRIORITIES);
            try (Connection connection = openDemo(context)) {
                Map<String, Object> envelope = new Repository(call, connection)
                        .demandOrders(normalized);
                call.check();
                return readOk("demand_orders", envelope);
            }
        }

        private static Map<String, Object> equipmentEvents(
                Call call, Map<?, ?> input, Map<?, ?> context)
                throws Exception {
            call.check();
            Map<String, Object> normalized = normalizedBase(input);
            copyDate(input, normalized, "start_date");
            copyDate(input, normalized, "end_date");
            requireDateOrder(normalized);
            copyText(input, normalized, "equipment_code", 40);
            copyEnum(input, normalized, "severity", SEVERITIES);
            copyEnum(input, normalized, "process_code", EVENT_PROCESSES);
            normalized.put("unresolved_only",
                    boolAt(input, "unresolved_only", false));
            try (Connection connection = openDemo(context)) {
                Map<String, Object> envelope = new Repository(call, connection)
                        .equipmentEvents("equipment_events", normalized);
                call.check();
                return readOk("equipment_events", envelope);
            }
        }

        private static Map<String, Object> equipmentStatus(
                Call call, Map<?, ?> input, Map<?, ?> context)
                throws Exception {
            call.check();
            Map<String, Object> normalized = normalizedBase(input);
            copyText(input, normalized, "process_code", 40);
            copyText(input, normalized, "equipment", 80);
            copyEnum(input, normalized, "state", EQUIPMENT_STATES);
            try (Connection connection = openDemo(context)) {
                Map<String, Object> envelope = new Repository(call, connection)
                        .equipmentStates(normalized);
                call.check();
                return readOk("equipment_status", envelope);
            }
        }

        // ── 业务写（乐观守护 + 写后重读确认） ───────────────────────

        private static Map<String, Object> updatePlan(
                Call call, Map<?, ?> input, Map<?, ?> context)
                throws Exception {
            String planNo = requireWriteText(input, "plan_no", 60);
            String action = requireWriteEnum(input, "action", WRITE_ACTIONS);
            try (Connection connection = openDemo(context)) {
                Repository repository = new Repository(call, connection);
                Map<String, Object> plan = repository.findPlan(planNo);
                if (plan == null) {
                    throw invalidWrite("计划不存在：" + planNo);
                }
                String status = text(plan, "status");
                double completed = numberAt(plan, "completedBatches");
                if (!"scheduled".equals(status)) {
                    throw invalidWrite(
                            "计划状态为 " + status
                                    + "，只有 scheduled 状态可以下达、取消或调整");
                }
                if (completed > 0) {
                    throw invalidWrite(
                            "计划已有完成量 " + completed
                                    + "，按锁定规则不可取消或调整");
                }
                String priority = text(plan, "priority");
                if ("set_priority".equals(action)) {
                    priority = requireWriteEnum(
                            input, "priority", WRITE_PRIORITIES);
                }
                String newStatus = switch (action) {
                    case "start" -> "running";
                    case "cancel" -> "cancelled";
                    default -> status;
                };
                call.check();
                int updated = repository.updatePlanState(
                        planNo, status, newStatus, priority, now());
                if (updated == 0) {
                    throw conflict(
                            "计划状态已变化或已有完成量，操作被锁定规则拒绝");
                }
                // 写后重读确认（内核 verify 阶段的插件内联）。
                Map<String, Object> after = repository.findPlan(planNo);
                if (after == null
                        || !newStatus.equals(text(after, "status"))
                        || !priority.equals(text(after, "priority"))) {
                    throw conflict("计划维护已返回，但最新状态无法确认");
                }
                Map<String, Object> output = new LinkedHashMap<>();
                output.put("planNo", planNo);
                output.put("action", action);
                output.put("previousStatus", status);
                output.put("newStatus", newStatus);
                output.put("priority", priority);
                return ok("计划 " + planNo + " 已执行 " + action
                        + "（" + status + "→" + newStatus + "）", output);
            }
        }

        private static Map<String, Object> disposeQualityException(
                Call call, Map<?, ?> input, Map<?, ?> context)
                throws Exception {
            String exceptionNo = requireWriteText(input, "exception_no", 60);
            String disposition = requireWriteEnum(
                    input, "disposition", WRITE_DISPOSITIONS);
            int expectedVersion = intAt(input, "expected_version", -1);
            if (expectedVersion < 0) {
                throw invalidWrite(
                        "expected_version 必须为非负整数，"
                                + "请先查询异常台账取当前 version");
            }
            try (Connection connection = openDemo(context)) {
                Repository repository = new Repository(call, connection);
                Map<String, Object> exception =
                        repository.findQualityException(exceptionNo);
                if (exception == null) {
                    throw invalidWrite("质量异常不存在：" + exceptionNo);
                }
                String status = text(exception, "status");
                if (!"open".equals(status)) {
                    throw invalidWrite(
                            "异常当前状态为 " + status + "，只有 open 可处置");
                }
                int currentVersion = (int) numberAt(exception, "version");
                if (currentVersion != expectedVersion) {
                    throw invalidWrite(
                            "版本不匹配：当前版本 " + currentVersion
                                    + "，请重新查询后再处置");
                }
                call.check();
                int updated = repository.disposeQualityException(
                        exceptionNo, disposition, expectedVersion, now());
                if (updated == 0) {
                    throw conflict("异常已被并发处置或版本已变化，请重新查询");
                }
                Map<String, Object> after =
                        repository.findQualityException(exceptionNo);
                if (after == null
                        || !"disposed".equals(text(after, "status"))
                        || !disposition.equals(text(after, "disposition"))
                        || (int) numberAt(after, "version")
                                != expectedVersion + 1) {
                    throw conflict("处置已返回，但异常最新状态无法确认");
                }
                Map<String, Object> output = new LinkedHashMap<>();
                output.put("exceptionNo", exceptionNo);
                output.put("disposition", disposition);
                output.put("newStatus", "disposed");
                output.put("newVersion", expectedVersion + 1);
                return ok("质量异常 " + exceptionNo + " 已处置为 "
                        + disposition, output);
            }
        }

        private static Map<String, Object> publishApsSchedule(
                Call call, Map<?, ?> input, Map<?, ?> context)
                throws Exception {
            String recordNo = requireWriteText(
                    input, "schedule_record_no", 60);
            String policy = requireWriteEnum(
                    input, "conflict_policy", CONFLICT_POLICIES);
            try (Connection connection = openDemo(context)) {
                Repository repository = new Repository(call, connection);
                Map<String, Object> record =
                        findSchedule(repository, recordNo);
                String prepareStatus = text(record, "status");
                // 幂等拦截：重复发布不报错、不重复写入。
                if ("published".equals(prepareStatus)) {
                    return alreadyPublished(repository, recordNo, record);
                }
                if (!PUBLISHABLE.contains(prepareStatus)) {
                    throw invalidWrite(
                            "排程状态为 " + prepareStatus
                                    + "，只有 feasible/accepted 可发布");
                }
                Object plansNode = details(record).get("plans");
                if (!(plansNode instanceof List<?> plans)
                        || plans.isEmpty()) {
                    throw invalidWrite(
                            "排程记录未包含可发布的计划行（details.plans）");
                }
                call.check();
                // 排程状态翻转、计划行落库与需求回写在同一事务内提交；
                // 任何一步失败整体回滚。
                connection.setAutoCommit(false);
                try {
                    Map<String, Object> output = publish(
                            call, repository, recordNo, policy);
                    connection.commit();
                    return ok("排程 " + recordNo + " 已发布 "
                            + ((List<?>) output.get("publishedPlanNos")).size()
                            + " 条生产计划", output);
                } catch (Exception failure) {
                    try {
                        connection.rollback();
                    } catch (SQLException ignored) {
                        // 回滚失败由连接关闭兜底。
                    }
                    throw failure;
                } finally {
                    connection.setAutoCommit(true);
                }
            }
        }

        private static Map<String, Object> publish(
                Call call,
                Repository repository,
                String recordNo,
                String policy
        ) throws Exception {
            Map<String, Object> record =
                    findSchedule(repository, recordNo);
            String status = text(record, "status");
            if ("published".equals(status)) {
                return alreadyPublished(repository, recordNo, record);
            }
            if (!PUBLISHABLE.contains(status)) {
                throw conflict("排程状态已变为 " + status + "，无法发布");
            }
            List<?> plans = (List<?>) details(record).get("plans");
            // 第一遍：逐行冲突检查并收集明细。block 遇锁定即整单拒绝并列出
            // 冲突；append 全冲突也拒绝，两种拒绝都发生在任何写入之前。
            List<Boolean> locked = new ArrayList<>();
            List<String> conflictDetails = new ArrayList<>();
            for (Object element : plans) {
                String detail = lockDetail(repository, recordNo,
                        castRow(element));
                locked.add(detail != null);
                if (detail != null) {
                    conflictDetails.add(detail);
                }
            }
            if (!conflictDetails.isEmpty() && "block".equals(policy)) {
                throw conflict(
                        "以下计划行与锁定计划（执行中/已完成/已有完成量）冲突："
                                + String.join("；", conflictDetails)
                                + "。block 策略整单拒绝；可改用 append 跳过冲突行");
            }
            if (conflictDetails.size() == plans.size()) {
                throw conflict("所有计划行均与锁定计划冲突，未发布任何计划");
            }
            call.check();
            List<String> planNos = new ArrayList<>();
            int index = 0;
            for (Object ignored : plans) {
                index++;
                if (!locked.get(index - 1)) {
                    planNos.add("PLAN-" + recordNo + "-" + index);
                }
            }
            Map<String, Object> patch = new LinkedHashMap<>();
            patch.put("publishedAt", now());
            patch.put("publishedPlanNos", planNos);
            int flipped = repository.updateProcessRecordStatus(
                    "aps", "schedule", recordNo, status, "published",
                    patch, now());
            if (flipped == 0) {
                throw conflict("排程已被并发发布或状态已变化");
            }
            index = 0;
            List<String> inserted = new ArrayList<>();
            List<String> skipped = new ArrayList<>();
            double totalBatches = 0;
            double totalWeight = 0;
            for (Object element : plans) {
                index++;
                Map<String, Object> row = castRow(element);
                if (locked.get(index - 1)) {
                    skipped.add(text(row, "equipmentCode")
                            + "@" + text(row, "planDate"));
                    continue;
                }
                String planNo = "PLAN-" + recordNo + "-" + index;
                int insertedRows = repository.insertProductionPlan(
                        planNo,
                        textOr(row, "processCode", "curing"),
                        text(row, "planDate"),
                        text(row, "equipmentCode"),
                        text(record, "itemCode"),
                        text(record, "itemName"),
                        (int) numberAt(row, "plannedBatches"),
                        numberAt(row, "plannedWeight"),
                        textOr(row, "shiftCode", "day"),
                        textOr(record, "priority", "normal"),
                        "scheduled");
                if (insertedRows != 1) {
                    throw conflict("生产计划 " + planNo + " 未能完整落库");
                }
                inserted.add(planNo);
                totalBatches += numberAt(row, "plannedBatches");
                totalWeight += numberAt(row, "plannedWeight");
                call.check();
            }
            String demandNo = text(details(record), "demandNo").trim();
            boolean demandUpdated = false;
            if (!demandNo.isBlank()) {
                demandUpdated = repository.updateDemandState(
                        demandNo, "unscheduled", "scheduled", now()) == 1;
                if (!demandUpdated) {
                    throw conflict(
                            "关联需求 " + demandNo
                                    + " 已不存在或状态不再是 unscheduled，"
                                    + "发布已整体回滚");
                }
            }
            // 写后重读确认：排程翻转为 published 且首条计划已落库。
            Map<String, Object> after = repository.findProcessRecord(
                    "aps", "schedule", recordNo);
            String firstPlanNo = inserted.isEmpty() ? "" : inserted.get(0);
            Map<String, Object> firstPlan = firstPlanNo.isBlank()
                    ? null : repository.findPlan(firstPlanNo);
            if (after == null
                    || !"published".equals(text(after, "status"))
                    || (!inserted.isEmpty() && firstPlan == null)) {
                throw conflict("发布已返回，但排程状态或首条计划无法确认");
            }
            Map<String, Object> output = new LinkedHashMap<>();
            output.put("scheduleRecordNo", recordNo);
            output.put("alreadyPublished", false);
            output.put("publishedPlanNos", inserted);
            output.put("skippedConflicts", skipped);
            output.put("demandNo", demandNo);
            output.put("demandUpdated", demandUpdated);
            output.put("totalPlannedBatches", totalBatches);
            output.put("totalPlannedWeight", totalWeight);
            return output;
        }

        /** 幂等拦截：重复发布返回原计划号，不重复写入。 */
        private static Map<String, Object> alreadyPublished(
                Repository repository,
                String recordNo,
                Map<String, Object> record
        ) throws Exception {
            Object published = details(record).get("publishedPlanNos");
            List<Object> planNos = published instanceof List<?> list
                    ? new ArrayList<>(list) : new ArrayList<>();
            // 重读确认：排程确实仍是 published。
            Map<String, Object> after = repository.findProcessRecord(
                    "aps", "schedule", recordNo);
            if (after == null
                    || !"published".equals(text(after, "status"))) {
                throw conflict("幂等拦截已返回，但排程状态无法确认");
            }
            Map<String, Object> output = new LinkedHashMap<>();
            output.put("scheduleRecordNo", recordNo);
            output.put("alreadyPublished", true);
            output.put("publishedPlanNos", planNos);
            output.put("skippedConflicts", new ArrayList<>());
            output.put("demandNo", text(details(record), "demandNo"));
            output.put("demandUpdated", false);
            output.put("totalPlannedBatches", 0);
            output.put("totalPlannedWeight", 0);
            return ok("排程 " + recordNo
                    + " 此前已发布，本次幂等拦截未重复写入", output);
        }

        /**
         * 返回该计划行的冲突明细（机台@日期 + 锁定计划号与状态），
         * 无锁定冲突返回 null。
         */
        private static String lockDetail(
                Repository repository,
                String recordNo,
                Map<String, Object> row
        ) throws Exception {
            String equipment = text(row, "equipmentCode").trim();
            String planDate = text(row, "planDate").trim();
            if (equipment.isBlank() || planDate.isBlank()) {
                throw invalidWrite(
                        "排程 " + recordNo
                                + " 的计划行缺少 equipmentCode/planDate");
            }
            List<String> lockingPlans = new ArrayList<>();
            for (Map<String, Object> plan : repository
                    .findPlansForEquipmentDate(equipment, planDate)) {
                if (numberAt(plan, "completedBatches") > 0
                        || LOCKED_STATUSES.contains(text(plan, "status"))) {
                    lockingPlans.add(text(plan, "planNo")
                            + "(" + text(plan, "status") + ")");
                }
            }
            if (lockingPlans.isEmpty()) {
                return null;
            }
            return "机台 " + equipment + "@" + planDate + " 已有 "
                    + String.join("、", lockingPlans);
        }

        private static Map<String, Object> findSchedule(
                Repository repository, String recordNo) throws Exception {
            Map<String, Object> record = repository.findProcessRecord(
                    "aps", "schedule", recordNo);
            if (record == null) {
                throw invalidWrite("排程记录不存在：" + recordNo);
            }
            return record;
        }

        // ── 归一化与结果小工具 ─────────────────────────────────────

        private static Map<String, Object> normalizedBase(Map<?, ?> input)
                throws Failure {
            Map<String, Object> normalized = new LinkedHashMap<>();
            int limit = intAt(input, "limit", DEFAULT_LIMIT);
            if (limit < 1 || limit > MAX_LIMIT) {
                throw invalid("limit 必须在 1 到 " + MAX_LIMIT + " 之间");
            }
            normalized.put("limit", limit);
            return normalized;
        }

        private static void copyText(
                Map<?, ?> input,
                Map<String, Object> normalized,
                String field,
                int maxCharacters
        ) throws Failure {
            String value = text(input, field).trim();
            if (value.length() > maxCharacters) {
                throw invalid(field + " 过长");
            }
            normalized.put(field, value);
        }

        private static void copyEnum(
                Map<?, ?> input,
                Map<String, Object> normalized,
                String field,
                Set<String> allowed
        ) throws Failure {
            String value = text(input, field).trim()
                    .toLowerCase(java.util.Locale.ROOT);
            if (!value.isBlank() && !allowed.contains(value)) {
                throw invalid(
                        field + " 只允许 " + String.join(", ", allowed));
            }
            normalized.put(field, value);
        }

        private static void copyDate(
                Map<?, ?> input,
                Map<String, Object> normalized,
                String field
        ) throws Failure {
            String value = text(input, field).trim();
            if (!value.isBlank()) {
                try {
                    LocalDate.parse(value);
                } catch (DateTimeParseException exception) {
                    throw invalid(field + " 必须为 YYYY-MM-DD");
                }
            }
            normalized.put(field, value);
        }

        private static void requireDateOrder(Map<String, Object> normalized)
                throws Failure {
            String start = text(normalized, "start_date");
            String end = text(normalized, "end_date");
            if (!start.isBlank() && !end.isBlank()
                    && LocalDate.parse(start).isAfter(LocalDate.parse(end))) {
                throw invalid("start_date 不能晚于 end_date");
            }
        }

        /** 只读查询的可预期校验失败。 */
        private static Failure invalid(String message) {
            return new Failure("invalid_industrial_query", message);
        }

        /** 写工具的业务校验失败：无副作用，可直接重试。 */
        private static Failure invalidWrite(String message) {
            return new Failure("invalid_mes_write", message);
        }

        /** 乐观守护冲突：并发或状态漂移导致守护条件不通过。 */
        private static Failure conflict(String message) {
            return new Failure("mes_write_conflict", message);
        }

        private static String requireWriteText(
                Map<?, ?> input, String field, int maxCharacters)
                throws Failure {
            String value = text(input, field).trim();
            if (value.isBlank()) {
                throw invalidWrite(field + " 不能为空");
            }
            if (value.length() > maxCharacters) {
                throw invalidWrite(field + " 过长");
            }
            return value;
        }

        private static String requireWriteEnum(
                Map<?, ?> input, String field, Set<String> allowed)
                throws Failure {
            String value = text(input, field).trim()
                    .toLowerCase(java.util.Locale.ROOT);
            if (!allowed.contains(value)) {
                throw invalidWrite(
                        field + " 只允许 " + String.join(", ", allowed));
            }
            return value;
        }

        private static String now() {
            return Instant.now().toString();
        }

        @SuppressWarnings("unchecked")
        private static Map<String, Object> details(Map<String, Object> row) {
            return row.get("details") instanceof Map<?, ?> map
                    ? (Map<String, Object>) map : new LinkedHashMap<>();
        }

        @SuppressWarnings("unchecked")
        private static Map<String, Object> castRow(Object element) {
            return element instanceof Map<?, ?> map
                    ? (Map<String, Object>) map : new LinkedHashMap<>();
        }

        private static String textOr(
                Map<String, Object> row, String field, String fallback) {
            String value = text(row, field);
            return value.isBlank() ? fallback : value;
        }

        private static Map<String, Object> readOk(
                String view, Map<String, Object> envelope) {
            return ok("mes 域视图 " + view + " 返回 "
                    + envelope.get("rowCount") + " 条模拟记录", envelope);
        }

        private static Map<String, Object> ok(
                String data, Map<String, Object> structured) {
            Map<String, Object> result = new LinkedHashMap<>();
            result.put("success", true);
            result.put("data", data);
            result.put("structuredData", structured);
            return result;
        }
    }

    // ------------------------------------------------------------------
    // 数据网关（内核 IndustrialDemoRepository 的移植）：固定视图、SQL、
    // 行预算与结果信封集中在这里；连接按调用打开并全程可取消。
    // ------------------------------------------------------------------
    static final class Repository {
        private static final Pattern NAMED_PARAMETER =
                Pattern.compile(":([A-Za-z_][A-Za-z0-9_]*)");

        private final Call call;
        private final Connection connection;

        Repository(Call call, Connection connection) {
            this.call = call;
            this.connection = connection;
        }

        Map<String, Object> materialInventory(Map<String, Object> filters)
                throws Exception {
            StringBuilder sql = new StringBuilder("""
                    SELECT material_code AS materialCode,
                           material_name AS materialName,
                           material_category AS materialCategory,
                           warehouse_code AS warehouseCode,
                           available_quantity AS availableQuantity,
                           reserved_quantity AS reservedQuantity,
                           safety_stock AS safetyStock,
                           unit,
                           updated_at AS updatedAt
                    FROM industrial_demo_material_stock
                    WHERE domain_code = :domain
                    """);
            Map<String, Object> parameters = parameters(filters);
            addContains(sql, parameters, filters, "material",
                    " AND (material_code LIKE :material"
                            + " OR material_name LIKE :material)");
            addEquals(sql, parameters, filters, "warehouse_code",
                    " AND warehouse_code = :warehouse_code");
            if (boolFilter(filters, "below_safety_stock")) {
                sql.append(" AND available_quantity < safety_stock");
            }
            sql.append(" ORDER BY material_category, material_code")
                    .append(" LIMIT :fetchLimit");
            return result("material_inventory", filters,
                    query(sql.toString(), parameters));
        }

        Map<String, Object> productionPlans(
                String view, Map<String, Object> filters) throws Exception {
            StringBuilder sql = new StringBuilder("""
                    SELECT plan_no AS planNo,
                           process_code AS processCode,
                           plan_date AS planDate,
                           equipment_code AS equipmentCode,
                           material_code AS materialCode,
                           material_name AS materialName,
                           planned_batches AS plannedBatches,
                           completed_batches AS completedBatches,
                           ROUND(
                               CASE WHEN planned_batches = 0 THEN 0
                                    ELSE completed_batches * 100.0
                                         / planned_batches END,
                               1
                           ) AS completionPercent,
                           planned_weight AS plannedWeight,
                           actual_weight AS actualWeight,
                           shift_code AS shiftCode,
                           priority,
                           status
                    FROM industrial_demo_production_plan
                    WHERE domain_code = :domain
                    """);
            Map<String, Object> parameters = parameters(filters);
            addDateRange(sql, parameters, filters, "plan_date");
            addEquals(sql, parameters, filters, "equipment_code",
                    " AND equipment_code = :equipment_code");
            addEquals(sql, parameters, filters, "material_code",
                    " AND material_code = :material_code");
            addEquals(sql, parameters, filters, "status",
                    " AND status = :status");
            sql.append("""
                     ORDER BY plan_date DESC,
                              CASE priority WHEN 'high' THEN 0 ELSE 1 END,
                              equipment_code, plan_no
                     LIMIT :fetchLimit
                    """);
            return result(view, filters, query(sql.toString(), parameters));
        }

        Map<String, Object> equipmentStates(Map<String, Object> filters)
                throws Exception {
            StringBuilder sql = new StringBuilder("""
                    SELECT equipment_code AS equipmentCode,
                           equipment_name AS equipmentName,
                           process_code AS processCode,
                           workshop_code AS workshopCode,
                           state,
                           utilization_percent AS utilizationPercent,
                           current_plan_no AS currentPlanNo,
                           latest_alarm AS latestAlarm,
                           updated_at AS updatedAt
                    FROM industrial_demo_equipment_state
                    WHERE domain_code = :domain
                    """);
            Map<String, Object> parameters = parameters(filters);
            addEquals(sql, parameters, filters, "process_code",
                    " AND process_code = :process_code");
            addEquals(sql, parameters, filters, "state",
                    " AND state = :state");
            addContains(sql, parameters, filters, "equipment",
                    " AND (equipment_code LIKE :equipment"
                            + " OR equipment_name LIKE :equipment)");
            sql.append(" ORDER BY process_code, equipment_code")
                    .append(" LIMIT :fetchLimit");
            return result("equipment_status", filters,
                    query(sql.toString(), parameters));
        }

        Map<String, Object> equipmentEvents(
                String view, Map<String, Object> filters) throws Exception {
            StringBuilder sql = new StringBuilder("""
                    SELECT event_no AS eventNo,
                           equipment_code AS equipmentCode,
                           event_type AS eventType,
                           severity,
                           reason_category AS reasonCategory,
                           started_at AS startedAt,
                           ended_at AS endedAt,
                           resolution_state AS resolutionState
                    FROM industrial_demo_equipment_event
                    WHERE domain_code = :domain
                    """);
            Map<String, Object> parameters = parameters(filters);
            addTimestampRange(sql, parameters, filters, "started_at");
            addEquals(sql, parameters, filters, "equipment_code",
                    " AND equipment_code = :equipment_code");
            addEquals(sql, parameters, filters, "severity",
                    " AND severity = :severity");
            addEquals(sql, parameters, filters, "process_code",
                    " AND equipment_code IN (SELECT equipment_code"
                            + " FROM industrial_demo_equipment_state"
                            + " WHERE domain_code = :domain"
                            + " AND process_code = :process_code)");
            if (boolFilter(filters, "unresolved_only")) {
                sql.append(" AND resolution_state <> 'resolved'");
            }
            sql.append(" ORDER BY started_at DESC, event_no")
                    .append(" LIMIT :fetchLimit");
            return result(view, filters, query(sql.toString(), parameters));
        }

        Map<String, Object> qualityMeasurements(
                Map<String, Object> filters) throws Exception {
            StringBuilder sql = new StringBuilder("""
                    SELECT sample_no AS sampleNo,
                           batch_no AS batchNo,
                           material_code AS materialCode,
                           equipment_code AS equipmentCode,
                           metric_code AS metricCode,
                           measured_value AS measuredValue,
                           lower_limit AS lowerLimit,
                           upper_limit AS upperLimit,
                           judge_result AS judgeResult,
                           sampled_at AS sampledAt
                    FROM industrial_demo_quality_measurement
                    WHERE domain_code = :domain
                    """);
            Map<String, Object> parameters = parameters(filters);
            addTimestampRange(sql, parameters, filters, "sampled_at");
            addEquals(sql, parameters, filters, "material_code",
                    " AND material_code = :material_code");
            addEquals(sql, parameters, filters, "equipment_code",
                    " AND equipment_code = :equipment_code");
            addEquals(sql, parameters, filters, "judge_result",
                    " AND judge_result = :judge_result");
            sql.append(" ORDER BY sampled_at DESC, sample_no, metric_code")
                    .append(" LIMIT :fetchLimit");
            Map<String, Object> result = result(
                    "quality_measurements", filters,
                    query(sql.toString(), parameters));
            int passed = 0;
            int failed = 0;
            for (Map<String, Object> row : rows(result)) {
                if ("pass".equals(Mes.text(row, "judgeResult"))) {
                    passed++;
                } else {
                    failed++;
                }
            }
            Map<String, Object> summary = new LinkedHashMap<>();
            summary.put("measurementCount", passed + failed);
            summary.put("passedCount", passed);
            summary.put("failedCount", failed);
            summary.put("passRatePercent",
                    passed + failed == 0
                            ? 0
                            : Math.round(passed * 10_000.0
                                    / (passed + failed)) / 100.0);
            result.put("summary", summary);
            return result;
        }

        Map<String, Object> processRecords(
                String process,
                String view,
                Map<String, Object> filters
        ) throws Exception {
            StringBuilder sql = new StringBuilder("""
                    SELECT record_type AS recordType,
                           record_no AS recordNo,
                           business_date AS businessDate,
                           item_code AS itemCode,
                           item_name AS itemName,
                           resource_code AS resourceCode,
                           status,
                           planned_quantity AS plannedQuantity,
                           actual_quantity AS actualQuantity,
                           unit,
                           priority,
                           detail_json AS detailJson,
                           updated_at AS updatedAt
                    FROM industrial_demo_process_record
                    WHERE domain_code = :domain
                      AND process_code = :process
                    """);
            Map<String, Object> parameters = parameters(filters);
            parameters.put("process", process);
            addEquals(sql, parameters, filters, "record_type",
                    " AND record_type = :record_type");
            addDateRange(sql, parameters, filters, "business_date");
            addContains(sql, parameters, filters, "item",
                    " AND (item_code LIKE :item OR item_name LIKE :item)");
            addEquals(sql, parameters, filters, "resource_code",
                    " AND resource_code = :resource_code");
            addEquals(sql, parameters, filters, "status",
                    " AND status = :status");
            sql.append("""
                     ORDER BY business_date DESC,
                              CASE priority WHEN 'high' THEN 0 ELSE 1 END,
                              record_no
                     LIMIT :fetchLimit
                    """);
            List<Map<String, Object>> rows =
                    query(sql.toString(), parameters);
            for (Map<String, Object> row : rows) {
                expandDetails(row);
            }
            return result(view, filters, rows);
        }

        /** IN 集合由调用方固定，模型不可选择。 */
        Map<String, Object> referenceObjects(
                Set<String> objectTypes,
                String view,
                Map<String, Object> filters
        ) throws Exception {
            StringBuilder sql = new StringBuilder("""
                    SELECT object_code AS objectCode,
                           object_name AS objectName,
                           object_type AS objectType,
                           process_code AS processCode,
                           version,
                           status,
                           resource_code AS resourceCode,
                           detail_json AS detailJson,
                           updated_at AS updatedAt
                    FROM industrial_demo_reference_object
                    WHERE domain_code = :domain
                      AND object_type IN (:objectTypes)
                    """);
            Map<String, Object> parameters = parameters(filters);
            parameters.put("objectTypes", List.copyOf(objectTypes));
            addContains(sql, parameters, filters, "query",
                    " AND (object_code LIKE :query"
                            + " OR object_name LIKE :query)");
            addEquals(sql, parameters, filters, "process_code",
                    " AND process_code = :process_code");
            addEquals(sql, parameters, filters, "status",
                    " AND status = :status");
            sql.append(" ORDER BY object_code LIMIT :fetchLimit");
            List<Map<String, Object>> rows =
                    query(sql.toString(), parameters);
            for (Map<String, Object> row : rows) {
                expandDetails(row);
            }
            return result(view, filters, rows);
        }

        Map<String, Object> demandOrders(Map<String, Object> filters)
                throws Exception {
            StringBuilder sql = new StringBuilder("""
                    SELECT demand_no AS demandNo,
                           item_code AS itemCode,
                           item_name AS itemName,
                           quantity,
                           unit,
                           due_date AS dueDate,
                           priority,
                           state,
                           source,
                           updated_at AS updatedAt
                    FROM industrial_demo_demand_order
                    WHERE domain_code = :domain
                    """);
            Map<String, Object> parameters = parameters(filters);
            addContains(sql, parameters, filters, "item",
                    " AND (item_code LIKE :item OR item_name LIKE :item)");
            addEquals(sql, parameters, filters, "state",
                    " AND state = :state");
            addEquals(sql, parameters, filters, "priority",
                    " AND priority = :priority");
            addDateRange(sql, parameters, filters, "due_date");
            sql.append("""
                     ORDER BY due_date,
                              CASE priority WHEN 'high' THEN 0 ELSE 1 END,
                              demand_no
                     LIMIT :fetchLimit
                    """);
            return result("demand_orders", filters,
                    query(sql.toString(), parameters));
        }

        Map<String, Object> batches(Map<String, Object> filters)
                throws Exception {
            StringBuilder sql = new StringBuilder("""
                    SELECT batch_no AS batchNo,
                           item_code AS itemCode,
                           item_name AS itemName,
                           plan_no AS planNo,
                           equipment_code AS equipmentCode,
                           process_code AS processCode,
                           produced_at AS producedAt,
                           quantity,
                           unit,
                           quality_state AS qualityState,
                           downstream_ref AS downstreamRef,
                           updated_at AS updatedAt
                    FROM industrial_demo_batch
                    WHERE domain_code = :domain
                    """);
            Map<String, Object> parameters = parameters(filters);
            addContains(sql, parameters, filters, "batch",
                    " AND batch_no LIKE :batch");
            addContains(sql, parameters, filters, "item",
                    " AND (item_code LIKE :item OR item_name LIKE :item)");
            addEquals(sql, parameters, filters, "plan_no",
                    " AND plan_no = :plan_no");
            addEquals(sql, parameters, filters, "equipment_code",
                    " AND equipment_code = :equipment_code");
            addEquals(sql, parameters, filters, "quality_state",
                    " AND quality_state = :quality_state");
            sql.append(" ORDER BY produced_at DESC, batch_no")
                    .append(" LIMIT :fetchLimit");
            return result("mixing_batches", filters,
                    query(sql.toString(), parameters));
        }

        Map<String, Object> materialMovements(Map<String, Object> filters)
                throws Exception {
            StringBuilder sql = new StringBuilder("""
                    SELECT movement_no AS movementNo,
                           material_code AS materialCode,
                           material_name AS materialName,
                           movement_type AS movementType,
                           quantity,
                           unit,
                           warehouse_code AS warehouseCode,
                           related_no AS relatedNo,
                           occurred_at AS occurredAt
                    FROM industrial_demo_material_movement
                    WHERE domain_code = :domain
                    """);
            Map<String, Object> parameters = parameters(filters);
            addContains(sql, parameters, filters, "material",
                    " AND (material_code LIKE :material"
                            + " OR material_name LIKE :material)");
            addEquals(sql, parameters, filters, "movement_type",
                    " AND movement_type = :movement_type");
            addEquals(sql, parameters, filters, "warehouse_code",
                    " AND warehouse_code = :warehouse_code");
            addEquals(sql, parameters, filters, "related_no",
                    " AND related_no = :related_no");
            addTimestampRange(sql, parameters, filters, "occurred_at");
            sql.append(" ORDER BY occurred_at DESC, movement_no")
                    .append(" LIMIT :fetchLimit");
            Map<String, Object> result = result(
                    "material_movements", filters,
                    query(sql.toString(), parameters));
            double received = 0;
            double issued = 0;
            double returned = 0;
            for (Map<String, Object> row : rows(result)) {
                double quantity = numberValue(row.get("quantity"));
                switch (Mes.text(row, "movementType")) {
                    case "receipt" -> received += quantity;
                    case "issue" -> issued += quantity;
                    case "return" -> returned += quantity;
                    default -> {
                    }
                }
            }
            Map<String, Object> summary = new LinkedHashMap<>();
            summary.put("receivedQuantity", received);
            summary.put("issuedQuantity", issued);
            summary.put("returnedQuantity", returned);
            result.put("summary", summary);
            return result;
        }

        Map<String, Object> qualityExceptions(Map<String, Object> filters)
                throws Exception {
            StringBuilder sql = new StringBuilder("""
                    SELECT exception_no AS exceptionNo,
                           item_code AS itemCode,
                           item_name AS itemName,
                           source_record_no AS sourceRecordNo,
                           defect_category AS defectCategory,
                           affected_quantity AS affectedQuantity,
                           status,
                           disposition,
                           version,
                           opened_at AS openedAt,
                           updated_at AS updatedAt
                    FROM industrial_demo_quality_exception
                    WHERE domain_code = :domain
                    """);
            Map<String, Object> parameters = parameters(filters);
            addContains(sql, parameters, filters, "item",
                    " AND (item_code LIKE :item OR item_name LIKE :item)");
            addEquals(sql, parameters, filters, "status",
                    " AND status = :status");
            addEquals(sql, parameters, filters, "disposition",
                    " AND disposition = :disposition");
            sql.append(" ORDER BY opened_at DESC, exception_no")
                    .append(" LIMIT :fetchLimit");
            Map<String, Object> result = result(
                    "quality_exceptions", filters,
                    query(sql.toString(), parameters));
            int open = 0;
            int disposed = 0;
            for (Map<String, Object> row : rows(result)) {
                if ("open".equals(Mes.text(row, "status"))) {
                    open++;
                } else if ("disposed".equals(Mes.text(row, "status"))) {
                    disposed++;
                }
            }
            Map<String, Object> summary = new LinkedHashMap<>();
            summary.put("openCount", open);
            summary.put("disposedCount", disposed);
            result.put("summary", summary);
            return result;
        }

        /**
         * 批次全生命周期追溯：按批号或物料片段跨表串出各阶段行，
         * 每行带 stage 字段。不是单表视图，是确定性的跨表走访。
         */
        Map<String, Object> batchTrace(Map<String, Object> filters)
                throws Exception {
            String batchNo = Mes.text(filters, "batch_no");
            String item = Mes.text(filters, "item");
            List<Map<String, Object>> rows = new ArrayList<>();
            if (!batchNo.isBlank()) {
                Map<String, Object> batchParams = mapOf(
                        "domain", DOMAIN,
                        "batchNo", "%" + batchNo + "%");
                List<Map<String, Object>> batchRows = query("""
                        SELECT batch_no AS batchNo, item_code AS itemCode,
                               item_name AS itemName, plan_no AS planNo,
                               equipment_code AS equipmentCode,
                               produced_at AS producedAt, quantity, unit,
                               quality_state AS qualityState,
                               downstream_ref AS downstreamRef
                        FROM industrial_demo_batch
                        WHERE domain_code = :domain AND batch_no LIKE :batchNo
                        ORDER BY produced_at DESC LIMIT 10
                        """, batchParams);
                for (Map<String, Object> batch : batchRows) {
                    call.check();
                    rows.add(withStage(batch, "batch"));
                    String planNo = Mes.text(batch, "planNo");
                    for (Map<String, Object> plan : query("""
                            SELECT plan_no AS planNo,
                                   process_code AS processCode,
                                   plan_date AS planDate,
                                   equipment_code AS equipmentCode,
                                   material_code AS materialCode,
                                   material_name AS materialName,
                                   planned_batches AS plannedBatches,
                                   completed_batches AS completedBatches,
                                   shift_code AS shiftCode, status
                            FROM industrial_demo_production_plan
                            WHERE domain_code = :domain AND plan_no = :planNo
                            LIMIT 5
                            """, mapOf("domain", DOMAIN, "planNo", planNo))) {
                        rows.add(withStage(plan, "plan"));
                    }
                    Map<String, Object> stepParams = mapOf(
                            "domain", DOMAIN,
                            "batchNo", Mes.text(batch, "batchNo"));
                    for (Map<String, Object> quality : query("""
                            SELECT sample_no AS sampleNo,
                                   metric_code AS metricCode,
                                   measured_value AS measuredValue,
                                   lower_limit AS lowerLimit,
                                   upper_limit AS upperLimit,
                                   judge_result AS judgeResult,
                                   sampled_at AS sampledAt
                            FROM industrial_demo_quality_measurement
                            WHERE domain_code = :domain
                              AND batch_no = :batchNo
                            ORDER BY sampled_at DESC LIMIT 10
                            """, stepParams)) {
                        rows.add(withStage(quality, "quality"));
                    }
                    for (Map<String, Object> record : query("""
                            SELECT record_type AS recordType,
                                   record_no AS recordNo,
                                   business_date AS businessDate,
                                   item_code AS itemCode,
                                   item_name AS itemName,
                                   resource_code AS resourceCode, status,
                                   detail_json AS detailJson
                            FROM industrial_demo_process_record
                            WHERE domain_code = :domain
                              AND detail_json LIKE :batchRef
                            ORDER BY business_date DESC LIMIT 10
                            """, mapOf("domain", DOMAIN, "batchRef",
                            "%" + Mes.text(batch, "batchNo") + "%"))) {
                        expandDetails(record);
                        rows.add(withStage(record,
                                Mes.text(record, "recordType")));
                    }
                    String downstream =
                            Mes.text(batch, "downstreamRef");
                    if (!downstream.isBlank()) {
                        for (Map<String, Object> record : query("""
                                SELECT process_code AS processCode,
                                       record_type AS recordType,
                                       record_no AS recordNo,
                                       business_date AS businessDate,
                                       item_code AS itemCode,
                                       item_name AS itemName,
                                       resource_code AS resourceCode, status,
                                       planned_quantity AS plannedQuantity,
                                       actual_quantity AS actualQuantity,
                                       unit,
                                       detail_json AS detailJson
                                FROM industrial_demo_process_record
                                WHERE domain_code = :domain
                                  AND record_no = :recordNo
                                LIMIT 5
                                """, mapOf("domain", DOMAIN,
                                "recordNo", downstream))) {
                            expandDetails(record);
                            rows.add(withStage(record,
                                    Mes.text(record, "processCode")));
                        }
                    }
                }
            } else if (!item.isBlank()) {
                String like = "%" + item + "%";
                for (Map<String, Object> batch : query("""
                        SELECT batch_no AS batchNo, item_code AS itemCode,
                               item_name AS itemName, plan_no AS planNo,
                               equipment_code AS equipmentCode,
                               produced_at AS producedAt, quantity, unit,
                               quality_state AS qualityState,
                               downstream_ref AS downstreamRef
                        FROM industrial_demo_batch
                        WHERE domain_code = :domain
                          AND (item_code LIKE :item OR item_name LIKE :item)
                        ORDER BY produced_at DESC LIMIT 20
                        """, mapOf("domain", DOMAIN, "item", like))) {
                    rows.add(withStage(batch, "batch"));
                }
                for (Map<String, Object> record : query("""
                        SELECT process_code AS processCode,
                               record_type AS recordType,
                               record_no AS recordNo,
                               business_date AS businessDate,
                               item_code AS itemCode, item_name AS itemName,
                               resource_code AS resourceCode, status,
                               planned_quantity AS plannedQuantity,
                               actual_quantity AS actualQuantity, unit,
                               detail_json AS detailJson
                        FROM industrial_demo_process_record
                        WHERE domain_code = :domain
                          AND (item_code LIKE :item OR item_name LIKE :item)
                        ORDER BY business_date DESC LIMIT 40
                        """, mapOf("domain", DOMAIN, "item", like))) {
                    expandDetails(record);
                    rows.add(withStage(record,
                            Mes.text(record, "processCode")
                                    + "_" + Mes.text(
                                            record, "recordType")));
                }
                for (Map<String, Object> plan : query("""
                        SELECT plan_no AS planNo,
                               process_code AS processCode,
                               plan_date AS planDate,
                               equipment_code AS equipmentCode,
                               material_code AS materialCode,
                               material_name AS materialName,
                               planned_batches AS plannedBatches,
                               completed_batches AS completedBatches,
                               shift_code AS shiftCode, status
                        FROM industrial_demo_production_plan
                        WHERE domain_code = :domain
                          AND (material_code LIKE :item
                               OR material_name LIKE :item)
                        ORDER BY plan_date DESC LIMIT 20
                        """, mapOf("domain", DOMAIN, "item", like))) {
                    rows.add(withStage(plan, "plan"));
                }
            }
            rows.sort(Comparator.comparingInt(
                    row -> stageOrder(Mes.text(row, "stage"))));
            return result("batch_trace", filters, rows);
        }

        Map<String, Object> reportPlanExecution(
                Map<String, Object> filters) throws Exception {
            StringBuilder sql = new StringBuilder("""
                    SELECT process_code AS processCode,
                           plan_date AS planDate,
                           COUNT(*) AS planCount,
                           SUM(planned_batches) AS plannedBatches,
                           SUM(completed_batches) AS completedBatches,
                           ROUND(
                               CASE WHEN SUM(planned_batches) = 0 THEN 0
                                    ELSE SUM(completed_batches) * 100.0
                                         / SUM(planned_batches) END,
                               1
                           ) AS completionPercent,
                           SUM(planned_weight) AS plannedWeight,
                           SUM(actual_weight) AS actualWeight
                    FROM industrial_demo_production_plan
                    WHERE domain_code = :domain
                    """);
            Map<String, Object> parameters = parameters(filters);
            addDateRange(sql, parameters, filters, "plan_date");
            addEquals(sql, parameters, filters, "process_code",
                    " AND process_code = :process_code");
            sql.append("""
                     GROUP BY process_code, plan_date
                     ORDER BY plan_date DESC, process_code
                     LIMIT :fetchLimit
                    """);
            Map<String, Object> result = result(
                    "report_plan_execution", filters,
                    query(sql.toString(), parameters));
            double planned = 0;
            double completed = 0;
            for (Map<String, Object> row : rows(result)) {
                planned += numberValue(row.get("plannedBatches"));
                completed += numberValue(row.get("completedBatches"));
            }
            Map<String, Object> summary = new LinkedHashMap<>();
            summary.put("plannedBatches", planned);
            summary.put("completedBatches", completed);
            summary.put("completionPercent",
                    planned == 0
                            ? 0
                            : Math.round(completed * 1000.0 / planned) / 10.0);
            result.put("summary", summary);
            return result;
        }

        Map<String, Object> reportQualitySummary(
                Map<String, Object> filters) throws Exception {
            StringBuilder sql = new StringBuilder("""
                    SELECT material_code AS itemCode,
                           COUNT(*) AS measurementCount,
                           SUM(CASE WHEN judge_result = 'pass'
                                    THEN 1 ELSE 0 END) AS passedCount,
                           SUM(CASE WHEN judge_result = 'fail'
                                    THEN 1 ELSE 0 END) AS failedCount,
                           ROUND(
                               SUM(CASE WHEN judge_result = 'pass'
                                        THEN 1 ELSE 0 END)
                                   * 100.0 / COUNT(*),
                               1
                           ) AS passRatePercent
                    FROM industrial_demo_quality_measurement
                    WHERE domain_code = :domain
                    """);
            Map<String, Object> parameters = parameters(filters);
            addTimestampRange(sql, parameters, filters, "sampled_at");
            sql.append(" GROUP BY material_code ORDER BY itemCode")
                    .append(" LIMIT :fetchLimit");
            List<Map<String, Object>> rows =
                    query(sql.toString(), parameters);
            Map<String, int[]> exceptionsByItem = new LinkedHashMap<>();
            for (Map<String, Object> row : query("""
                    SELECT item_code AS itemCode,
                           SUM(CASE WHEN status = 'open'
                                    THEN 1 ELSE 0 END) AS openCount,
                           SUM(CASE WHEN status = 'disposed'
                                    THEN 1 ELSE 0 END) AS disposedCount
                    FROM industrial_demo_quality_exception
                    WHERE domain_code = :domain
                    GROUP BY item_code
                    """, mapOf("domain", DOMAIN))) {
                exceptionsByItem.put(Mes.text(row, "itemCode"),
                        new int[]{
                            (int) numberValue(row.get("openCount")),
                            (int) numberValue(row.get("disposedCount"))
                        });
            }
            int totalMeasurements = 0;
            int totalPassed = 0;
            for (Map<String, Object> row : rows) {
                int[] counts =
                        exceptionsByItem.get(Mes.text(row, "itemCode"));
                row.put("openExceptionCount", counts == null ? 0 : counts[0]);
                row.put("disposedExceptionCount",
                        counts == null ? 0 : counts[1]);
                totalMeasurements +=
                        (int) numberValue(row.get("measurementCount"));
                totalPassed += (int) numberValue(row.get("passedCount"));
            }
            Map<String, Object> result = result(
                    "report_quality_summary", filters, rows);
            Map<String, Object> summary = new LinkedHashMap<>();
            summary.put("measurementCount", totalMeasurements);
            summary.put("passRatePercent",
                    totalMeasurements == 0
                            ? 0
                            : Math.round(totalPassed * 1000.0
                                    / totalMeasurements) / 10.0);
            result.put("summary", summary);
            return result;
        }

        Map<String, Object> planDelays(Map<String, Object> filters)
                throws Exception {
            StringBuilder sql = new StringBuilder("""
                    SELECT plan_no AS planNo,
                           process_code AS processCode,
                           plan_date AS planDate,
                           equipment_code AS equipmentCode,
                           material_code AS materialCode,
                           material_name AS materialName,
                           planned_batches AS plannedBatches,
                           completed_batches AS completedBatches,
                           shift_code AS shiftCode,
                           priority,
                           status,
                           CAST(julianday(:as_of) - julianday(plan_date)
                               AS INTEGER) AS daysDelayed
                    FROM industrial_demo_production_plan
                    WHERE domain_code = :domain
                      AND plan_date < :as_of
                      AND status IN ('scheduled', 'running')
                    """);
            Map<String, Object> parameters = parameters(filters);
            parameters.put("as_of", Mes.text(filters, "as_of_date"));
            addEquals(sql, parameters, filters, "process_code",
                    " AND process_code = :process_code");
            addEquals(sql, parameters, filters, "equipment_code",
                    " AND equipment_code = :equipment_code");
            sql.append(" ORDER BY daysDelayed DESC, plan_no")
                    .append(" LIMIT :fetchLimit");
            Map<String, Object> result = result(
                    "plan_delays", filters,
                    query(sql.toString(), parameters));
            double remaining = 0;
            for (Map<String, Object> row : rows(result)) {
                remaining += numberValue(row.get("plannedBatches"))
                        - numberValue(row.get("completedBatches"));
            }
            Map<String, Object> summary = new LinkedHashMap<>();
            summary.put("delayedPlanCount", result.get("rowCount"));
            summary.put("remainingBatches", remaining);
            result.put("summary", summary);
            return result;
        }

        // ── 写操作支持：只做参数化 SQL 与乐观校验，业务规则在 Actions。──

        /** 按主键读单条工序记录；不存在返回 null。 */
        Map<String, Object> findProcessRecord(
                String process, String recordType, String recordNo)
                throws Exception {
            List<Map<String, Object>> rows = query("""
                    SELECT record_type AS recordType, record_no AS recordNo,
                           business_date AS businessDate,
                           item_code AS itemCode, item_name AS itemName,
                           resource_code AS resourceCode, status,
                           planned_quantity AS plannedQuantity,
                           actual_quantity AS actualQuantity, unit, priority,
                           detail_json AS detailJson
                    FROM industrial_demo_process_record
                    WHERE domain_code = :domain
                      AND process_code = :process
                      AND record_type = :recordType
                      AND record_no = :recordNo
                    LIMIT 1
                    """, mapOf(
                            "domain", DOMAIN,
                            "process", process,
                            "recordType", recordType,
                            "recordNo", recordNo));
            if (rows.isEmpty()) {
                return null;
            }
            Map<String, Object> row = rows.get(0);
            expandDetails(row);
            return row;
        }

        /** 按主键读单条生产计划；不存在返回 null。 */
        Map<String, Object> findPlan(String planNo) throws Exception {
            List<Map<String, Object>> rows = query("""
                    SELECT plan_no AS planNo, process_code AS processCode,
                           plan_date AS planDate,
                           equipment_code AS equipmentCode,
                           material_code AS materialCode,
                           material_name AS materialName,
                           planned_batches AS plannedBatches,
                           completed_batches AS completedBatches,
                           planned_weight AS plannedWeight,
                           actual_weight AS actualWeight,
                           shift_code AS shiftCode, priority, status
                    FROM industrial_demo_production_plan
                    WHERE domain_code = :domain AND plan_no = :planNo
                    LIMIT 1
                    """, mapOf("domain", DOMAIN, "planNo", planNo));
            return rows.isEmpty() ? null : rows.get(0);
        }

        /** 目标机台某日的既有计划（发布冲突检查用）。 */
        List<Map<String, Object>> findPlansForEquipmentDate(
                String equipmentCode, String planDate) throws Exception {
            return query("""
                    SELECT plan_no AS planNo, material_code AS materialCode,
                           planned_batches AS plannedBatches,
                           completed_batches AS completedBatches,
                           shift_code AS shiftCode, status
                    FROM industrial_demo_production_plan
                    WHERE domain_code = :domain
                      AND equipment_code = :equipmentCode
                      AND plan_date = :planDate
                    ORDER BY plan_no
                    """, mapOf(
                            "domain", DOMAIN,
                            "equipmentCode", equipmentCode,
                            "planDate", planDate));
        }

        /** 发布排程 → 新增生产计划。返回插入行数。 */
        int insertProductionPlan(
                String planNo,
                String processCode,
                String planDate,
                String equipmentCode,
                String materialCode,
                String materialName,
                int plannedBatches,
                double plannedWeight,
                String shiftCode,
                String priority,
                String status
        ) throws Exception {
            return update("""
                    INSERT INTO industrial_demo_production_plan (
                        domain_code, plan_no, process_code, plan_date,
                        equipment_code, material_code, material_name,
                        planned_batches, completed_batches,
                        planned_weight, actual_weight,
                        shift_code, priority, status
                    ) VALUES (
                        :domain, :planNo, :processCode, :planDate,
                        :equipmentCode, :materialCode, :materialName,
                        :plannedBatches, 0, :plannedWeight, 0,
                        :shiftCode, :priority, :status
                    )
                    """, mapOf(
                            "domain", DOMAIN,
                            "planNo", planNo,
                            "processCode", processCode,
                            "planDate", planDate,
                            "equipmentCode", equipmentCode,
                            "materialCode", materialCode,
                            "materialName", materialName,
                            "plannedBatches", plannedBatches,
                            "plannedWeight", plannedWeight,
                            "shiftCode", shiftCode,
                            "priority", priority,
                            "status", status));
        }

        /** 乐观更新工序记录状态并合并 details 补丁；不匹配返回 0。 */
        int updateProcessRecordStatus(
                String process,
                String recordType,
                String recordNo,
                String expectedStatus,
                String newStatus,
                Map<String, Object> detailPatch,
                String updatedAt
        ) throws Exception {
            Map<String, Object> current =
                    findProcessRecord(process, recordType, recordNo);
            if (current == null) {
                return 0;
            }
            Map<String, Object> details = new LinkedHashMap<>(
                    Actions.details(current));
            details.putAll(detailPatch);
            return update("""
                    UPDATE industrial_demo_process_record
                    SET status = :newStatus,
                        detail_json = :detailJson,
                        updated_at = :updatedAt
                    WHERE domain_code = :domain
                      AND process_code = :process
                      AND record_type = :recordType
                      AND record_no = :recordNo
                      AND status = :expectedStatus
                    """, mapOf(
                            "newStatus", newStatus,
                            "detailJson", Json.write(details),
                            "updatedAt", updatedAt,
                            "domain", DOMAIN,
                            "process", process,
                            "recordType", recordType,
                            "recordNo", recordNo,
                            "expectedStatus", expectedStatus));
        }

        /** 乐观更新需求状态；expectedState 不匹配返回 0。 */
        int updateDemandState(
                String demandNo,
                String expectedState,
                String newState,
                String updatedAt
        ) throws Exception {
            return update("""
                    UPDATE industrial_demo_demand_order
                    SET state = :newState, updated_at = :updatedAt
                    WHERE domain_code = :domain
                      AND demand_no = :demandNo
                      AND state = :expectedState
                    """, mapOf(
                            "newState", newState,
                            "updatedAt", updatedAt,
                            "domain", DOMAIN,
                            "demandNo", demandNo,
                            "expectedState", expectedState));
        }

        /** 乐观更新计划状态/优先级；守护条件不满足返回 0。 */
        int updatePlanState(
                String planNo,
                String expectedStatus,
                String newStatus,
                String priority,
                String updatedAt
        ) throws Exception {
            // updatedAt 不在生产计划表上；内核同样只更新状态与优先级。
            return update("""
                    UPDATE industrial_demo_production_plan
                    SET status = :newStatus, priority = :priority
                    WHERE domain_code = :domain
                      AND plan_no = :planNo
                      AND status = :expectedStatus
                      AND completed_batches = 0
                    """, mapOf(
                            "newStatus", newStatus,
                            "priority", priority,
                            "domain", DOMAIN,
                            "planNo", planNo,
                            "expectedStatus", expectedStatus));
        }

        /** 按主键读单条质量异常；不存在返回 null。 */
        Map<String, Object> findQualityException(String exceptionNo)
                throws Exception {
            List<Map<String, Object>> rows = query("""
                    SELECT exception_no AS exceptionNo,
                           item_code AS itemCode,
                           item_name AS itemName,
                           source_record_no AS sourceRecordNo,
                           defect_category AS defectCategory,
                           affected_quantity AS affectedQuantity,
                           status, disposition, version,
                           opened_at AS openedAt, updated_at AS updatedAt
                    FROM industrial_demo_quality_exception
                    WHERE domain_code = :domain
                      AND exception_no = :exceptionNo
                    LIMIT 1
                    """, mapOf("domain", DOMAIN,
                            "exceptionNo", exceptionNo));
            return rows.isEmpty() ? null : rows.get(0);
        }

        /** 乐观处置质量异常；version 不匹配或已不是 open 返回 0。 */
        int disposeQualityException(
                String exceptionNo,
                String disposition,
                int expectedVersion,
                String updatedAt
        ) throws Exception {
            return update("""
                    UPDATE industrial_demo_quality_exception
                    SET status = 'disposed',
                        disposition = :disposition,
                        version = version + 1,
                        updated_at = :updatedAt
                    WHERE domain_code = :domain
                      AND exception_no = :exceptionNo
                      AND status = 'open'
                      AND version = :expectedVersion
                    """, mapOf(
                            "disposition", disposition,
                            "updatedAt", updatedAt,
                            "domain", DOMAIN,
                            "exceptionNo", exceptionNo,
                            "expectedVersion", expectedVersion));
        }

        // ── SQL 装配与执行 ─────────────────────────────────────────

        private Map<String, Object> parameters(
                Map<String, Object> filters) {
            Map<String, Object> parameters = new LinkedHashMap<>();
            parameters.put("domain", DOMAIN);
            parameters.put("fetchLimit",
                    Mes.intAt(filters, "limit", DEFAULT_LIMIT) + 1);
            return parameters;
        }

        private void addContains(
                StringBuilder sql,
                Map<String, Object> parameters,
                Map<String, Object> filters,
                String field,
                String clause
        ) {
            String value = Mes.text(filters, field);
            if (!value.isBlank()) {
                sql.append(clause);
                parameters.put(field, "%" + value + "%");
            }
        }

        private void addEquals(
                StringBuilder sql,
                Map<String, Object> parameters,
                Map<String, Object> filters,
                String field,
                String clause
        ) {
            String value = Mes.text(filters, field);
            if (!value.isBlank()) {
                sql.append(clause);
                parameters.put(field, value);
            }
        }

        private void addDateRange(
                StringBuilder sql,
                Map<String, Object> parameters,
                Map<String, Object> filters,
                String column
        ) {
            String from = Mes.text(filters, "start_date");
            String to = Mes.text(filters, "end_date");
            if (!from.isBlank()) {
                sql.append(" AND ").append(column).append(" >= :start_date");
                parameters.put("start_date", from);
            }
            if (!to.isBlank()) {
                sql.append(" AND ").append(column).append(" <= :end_date");
                parameters.put("end_date", to);
            }
        }

        private void addTimestampRange(
                StringBuilder sql,
                Map<String, Object> parameters,
                Map<String, Object> filters,
                String column
        ) {
            String from = Mes.text(filters, "start_date");
            String to = Mes.text(filters, "end_date");
            if (!from.isBlank()) {
                sql.append(" AND ").append(column).append(" >= :start_time");
                parameters.put("start_time", from + "T00:00:00Z");
            }
            if (!to.isBlank()) {
                sql.append(" AND ").append(column).append(" < :end_time");
                parameters.put("end_time", to + "T23:59:59.999Z");
            }
        }

        /** 固定 SQL 的 :name 参数展开为 ?；List 值展开 IN 集合。 */
        private PreparedStatement prepare(
                String sql, Map<String, Object> parameters)
                throws SQLException {
            Matcher matcher = NAMED_PARAMETER.matcher(sql);
            StringBuilder positional = new StringBuilder();
            List<Object> values = new ArrayList<>();
            while (matcher.find()) {
                Object value = parameters.get(matcher.group(1));
                String replacement;
                if (value instanceof List<?> list) {
                    StringBuilder placeholders = new StringBuilder("(");
                    for (int index = 0; index < list.size(); index++) {
                        if (index > 0) {
                            placeholders.append(',');
                        }
                        placeholders.append('?');
                        values.add(list.get(index));
                    }
                    replacement = placeholders.append(')').toString();
                } else {
                    values.add(value);
                    replacement = "?";
                }
                matcher.appendReplacement(positional,
                        Matcher.quoteReplacement(replacement));
            }
            matcher.appendTail(positional);
            PreparedStatement statement =
                    connection.prepareStatement(positional.toString());
            for (int index = 0; index < values.size(); index++) {
                statement.setObject(index + 1, values.get(index));
            }
            return statement;
        }

        private List<Map<String, Object>> query(
                String sql, Map<String, Object> parameters)
                throws Failure, SQLException, Cancelled {
            PreparedStatement statement = prepare(sql, parameters);
            call.track(statement);
            try (PreparedStatement owned = statement) {
                try (ResultSet resultSet = owned.executeQuery()) {
                    List<Map<String, Object>> rows = new ArrayList<>();
                    ResultSetMetaData metadata = resultSet.getMetaData();
                    while (resultSet.next()) {
                        Map<String, Object> row = new LinkedHashMap<>();
                        for (int index = 1;
                                index <= metadata.getColumnCount();
                                index++) {
                            row.put(metadata.getColumnLabel(index),
                                    cell(resultSet.getObject(index)));
                        }
                        rows.add(row);
                    }
                    return rows;
                }
            } catch (SQLException failure) {
                throw dataFailure("只读 SQL 查询", failure);
            } finally {
                call.untrack(statement);
            }
        }

        private int update(String sql, Map<String, Object> parameters)
                throws Failure, SQLException, Cancelled {
            PreparedStatement statement = prepare(sql, parameters);
            call.track(statement);
            try (PreparedStatement owned = statement) {
                return owned.executeUpdate();
            } catch (SQLException failure) {
                throw dataFailure("写入 SQL 执行", failure);
            } finally {
                call.untrack(statement);
            }
        }

        private Failure dataFailure(String operation, SQLException failure) {
            String diagnostic = failure.getMessage() == null
                    ? failure.getClass().getSimpleName()
                    : failure.getMessage().replaceAll("\\s+", " ").trim();
            if (diagnostic.length() > 400) {
                diagnostic = diagnostic.substring(0, 400);
            }
            return new Failure(
                    "industrial_demo_sql_unavailable",
                    "工业域的" + operation + "失败；无需原样重试参数，"
                            + "请确认演示数据库已初始化。环境反馈：" + diagnostic);
        }

        private Object cell(Object value) {
            if (value == null || value instanceof Integer
                    || value instanceof Long || value instanceof Double
                    || value instanceof Float || value instanceof Boolean
                    || value instanceof String) {
                return value;
            }
            if (value instanceof Number number) {
                return number.doubleValue();
            }
            return value.toString();
        }

        private void expandDetails(Map<String, Object> row) throws Failure {
            String json = Mes.text(row, "detailJson");
            row.remove("detailJson");
            try {
                row.put("details", Json.parse(json));
            } catch (RuntimeException parseFailure) {
                throw new Failure(
                        "industrial_demo_record_invalid",
                        "工业模拟记录的 details 不是合法 JSON；"
                                + "该记录不能作为业务证据，"
                                + "请修复模拟数据后再查询");
            }
        }

        private Map<String, Object> withStage(
                Map<String, Object> row, String stage) {
            row.put("stage", stage);
            return row;
        }

        private static int stageOrder(String stage) {
            if (stage.startsWith("aps")) {
                return 5;
            }
            if (stage.equals("plan") || stage.endsWith("_plan")) {
                return 10;
            }
            if (stage.equals("batch")) {
                return 20;
            }
            if (stage.startsWith("mixing")
                    || stage.equals("consumption")
                    || stage.equals("feeding")) {
                return 30;
            }
            if (stage.startsWith("quality")) {
                return 40;
            }
            if (stage.startsWith("semifinished")) {
                return 50;
            }
            if (stage.startsWith("forming")) {
                return 60;
            }
            if (stage.startsWith("curing")) {
                return 70;
            }
            if (stage.startsWith("warehouse") || stage.equals("shipment")) {
                return 80;
            }
            return 90;
        }

        /** 结果信封：dataset/simulated/domain/view/filters/rows/... */
        private Map<String, Object> result(
                String view,
                Map<String, Object> filters,
                List<Map<String, Object>> fetchedRows
        ) {
            int limit = Mes.intAt(filters, "limit", DEFAULT_LIMIT);
            boolean truncated = fetchedRows.size() > limit;
            List<Map<String, Object>> visible = truncated
                    ? new ArrayList<>(fetchedRows.subList(0, limit))
                    : fetchedRows;
            Map<String, Object> result = new LinkedHashMap<>();
            result.put("dataset", "iris-industrial");
            result.put("simulated", true);
            result.put("domain", DOMAIN);
            result.put("view", view);
            result.put("filters", new LinkedHashMap<>(filters));
            result.put("rows", visible);
            result.put("rowCount", visible.size());
            result.put("truncated", truncated);
            result.put(
                    "guidance",
                    truncated
                            ? "结果达到行数预算；请增加日期、状态、设备或物料条件后"
                                    + "重新查询"
                            : visible.isEmpty()
                                    ? "没有符合条件的记录；可放宽筛选条件"
                                    : "已返回当前筛选范围内的全部记录");
            return result;
        }

        @SuppressWarnings("unchecked")
        private List<Map<String, Object>> rows(
                Map<String, Object> envelope) {
            return (List<Map<String, Object>>) envelope.get("rows");
        }

        private boolean boolFilter(
                Map<String, Object> filters, String field) {
            return filters.get(field) instanceof Boolean value && value;
        }

        private static double numberValue(Object value) {
            return value instanceof Number number
                    ? number.doubleValue() : 0;
        }

        private static Map<String, Object> mapOf(Object... keyValues) {
            Map<String, Object> map = new LinkedHashMap<>();
            for (int index = 0; index < keyValues.length; index += 2) {
                map.put((String) keyValues[index], keyValues[index + 1]);
            }
            return map;
        }
    }

    // ------------------------------------------------------------------
    // 演示库打开与自种子：{workspace}/industry/mes-demo.db，
    // BEGIN IMMEDIATE + seed_marker 双检，并发首种安全。
    // ------------------------------------------------------------------
    private static Connection openDemo(Map<?, ?> context)
            throws Failure, SQLException {
        String workspace = context.get("workspace") instanceof String text
                && !text.isBlank() ? text.trim() : null;
        if (workspace == null) {
            throw new Failure(
                    "mes_workspace_unavailable",
                    "调用上下文未携带工作区路径，演示数据库无法定位");
        }
        Path database;
        try {
            database = Path.of(workspace)
                    .resolve("industry")
                    .resolve("mes-demo.db");
            Files.createDirectories(database.getParent());
        } catch (IOException | RuntimeException pathFailure) {
            throw new Failure(
                    "mes_workspace_unavailable",
                    "工作区路径不可用: " + workspace);
        }
        Properties properties = new Properties();
        properties.setProperty("busy_timeout", "5000");
        // IMMEDIATE 使 setAutoCommit(false) 的首条语句即取得写锁，
        // 与内核 BEGIN IMMEDIATE 的首种语义等价。
        properties.setProperty("transaction_mode", "IMMEDIATE");
        Connection connection = DriverManager.getConnection(
                "jdbc:sqlite:" + database.toAbsolutePath(), properties);
        try {
            ensureSeeded(connection);
        } catch (Exception seedFailure) {
            try {
                connection.close();
            } catch (SQLException ignored) {
                // 连接关闭失败不影响种子错误的上报。
            }
            throw seedFailure;
        }
        return connection;
    }

    private static void ensureSeeded(Connection connection)
            throws Failure, SQLException {
        connection.setAutoCommit(false);
        try (Statement statement = connection.createStatement()) {
            if (!seeded(statement)) {
                statement.execute("""
                        CREATE TABLE IF NOT EXISTS mes_seed_marker (
                            id INTEGER PRIMARY KEY CHECK (id = 1),
                            seeded_at TEXT NOT NULL
                        )
                        """);
                for (String ddlOrSeed : seedStatements()) {
                    statement.execute(ddlOrSeed);
                }
                statement.execute(
                        "INSERT INTO mes_seed_marker (id, seeded_at)"
                                + " VALUES (1, '" + Instant.now() + "')");
            }
            connection.commit();
        } catch (SQLException | Failure failure) {
            try {
                connection.rollback();
            } catch (SQLException ignored) {
                // 回滚失败由连接关闭兜底。
            }
            throw failure;
        } finally {
            connection.setAutoCommit(true);
        }
    }

    private static boolean seeded(Statement statement) throws SQLException {
        boolean markerExists;
        try (ResultSet result = statement.executeQuery(
                "SELECT COUNT(*) FROM sqlite_master"
                        + " WHERE type = 'table'"
                        + " AND name = 'mes_seed_marker'")) {
            markerExists = result.next() && result.getLong(1) > 0;
        }
        if (!markerExists) {
            return false;
        }
        try (ResultSet result = statement.executeQuery(
                "SELECT COUNT(*) FROM mes_seed_marker")) {
            return result.next() && result.getLong(1) > 0;
        }
    }

    /** seed.sql 按“行尾分号”切语句；-- 注释行与空行剥除。 */
    private static List<String> seedStatements() throws Failure {
        List<String> cached = seedStatements;
        if (cached != null) {
            return cached;
        }
        synchronized (Mes.class) {
            if (seedStatements != null) {
                return seedStatements;
            }
            String text;
            try {
                text = Files.readString(pluginDir.resolve("seed.sql"),
                        StandardCharsets.UTF_8);
            } catch (IOException readFailure) {
                throw new Failure(
                        "mes_seed_unavailable",
                        "种子脚本 seed.sql 不可读: " + readFailure.getMessage());
            }
            List<String> statements = new ArrayList<>();
            StringBuilder current = new StringBuilder();
            for (String line : text.split("\n")) {
                String trimmed = line.trim();
                if (trimmed.isEmpty() || trimmed.startsWith("--")) {
                    continue;
                }
                current.append(line).append('\n');
                if (trimmed.endsWith(";")) {
                    statements.add(current.toString());
                    current.setLength(0);
                }
            }
            String tail = current.toString().trim();
            if (!tail.isEmpty()) {
                statements.add(tail);
            }
            seedStatements = List.copyOf(statements);
            return seedStatements;
        }
    }

    // ------------------------------------------------------------------
    // 帧写出与输入小工具
    // ------------------------------------------------------------------
    private static synchronized void writeFrame(Map<String, Object> frame) {
        try {
            out.write(Json.write(frame));
            out.newLine();
            out.flush();
        } catch (IOException ignored) {
            // 内核已退出；进程随之结束。
        }
    }

    /** 对齐 Jackson asText：非字符串标量取其文本，缺省/容器为空串。 */
    static String text(Map<?, ?> map, String field) {
        Object value = map.get(field);
        if (value instanceof String text) {
            return text;
        }
        if (value instanceof Number || value instanceof Boolean) {
            return String.valueOf(value);
        }
        return "";
    }

    static int intAt(Map<?, ?> input, String field, int fallback) {
        return input.get(field) instanceof Number number
                ? number.intValue() : fallback;
    }

    static double numberAt(Map<?, ?> row, String field) {
        return row.get(field) instanceof Number number
                ? number.doubleValue() : 0;
    }

    static boolean boolAt(Map<?, ?> input, String field, boolean fallback) {
        return input.get(field) instanceof Boolean value ? value : fallback;
    }

    private static Map<String, Object> error(String code, String message) {
        Map<String, Object> error = new LinkedHashMap<>();
        error.put("code", code);
        error.put("message", message);
        return error;
    }

    /** 原语层可预期的失败：code 是给模型的恢复信号。 */
    static final class Failure extends Exception {
        final String code;

        Failure(String code, String message) {
            super(message);
            this.code = code;
        }
    }

    /** 取消帧生效；不是失败。 */
    static final class Cancelled extends Exception {
    }

    // ------------------------------------------------------------------
    // 自足 JSON：无第三方依赖，供帧协议、details 展开与补丁序列化使用。
    // ------------------------------------------------------------------
    static final class Json {

        static Object parse(String text) {
            Parser parser = new Parser(text);
            Object value = parser.parseValue();
            parser.skipWhitespace();
            if (!parser.atEnd()) {
                throw new IllegalArgumentException("JSON 尾部有多余字符");
            }
            return value;
        }

        static String write(Object value) {
            StringBuilder out = new StringBuilder();
            writeValue(value, out);
            return out.toString();
        }

        private static void writeValue(Object value, StringBuilder out) {
            if (value == null) {
                out.append("null");
            } else if (value instanceof String text) {
                writeString(text, out);
            } else if (value instanceof Number number) {
                out.append(number instanceof Double || number instanceof Float
                        ? trimDecimal(number.doubleValue())
                        : number.toString());
            } else if (value instanceof Boolean) {
                out.append(value.toString());
            } else if (value instanceof Map<?, ?> map) {
                out.append('{');
                boolean first = true;
                for (Map.Entry<?, ?> entry : map.entrySet()) {
                    if (!first) {
                        out.append(',');
                    }
                    first = false;
                    writeString(String.valueOf(entry.getKey()), out);
                    out.append(':');
                    writeValue(entry.getValue(), out);
                }
                out.append('}');
            } else if (value instanceof List<?> list) {
                out.append('[');
                boolean first = true;
                for (Object element : list) {
                    if (!first) {
                        out.append(',');
                    }
                    first = false;
                    writeValue(element, out);
                }
                out.append(']');
            } else {
                writeString(String.valueOf(value), out);
            }
        }

        private static String trimDecimal(double value) {
            return value == Math.rint(value)
                    && Math.abs(value) < 1e15
                    ? Long.toString((long) value)
                    : Double.toString(value);
        }

        private static void writeString(String text, StringBuilder out) {
            out.append('"');
            for (int i = 0; i < text.length(); i++) {
                char c = text.charAt(i);
                switch (c) {
                    case '"' -> out.append("\\\"");
                    case '\\' -> out.append("\\\\");
                    case '\n' -> out.append("\\n");
                    case '\r' -> out.append("\\r");
                    case '\t' -> out.append("\\t");
                    default -> {
                        if (c < 0x20) {
                            out.append(String.format("\\u%04x", (int) c));
                        } else {
                            out.append(c);
                        }
                    }
                }
            }
            out.append('"');
        }

        private static final class Parser {
            private final String text;
            private int position;

            Parser(String text) {
                this.text = text;
            }

            Object parseValue() {
                skipWhitespace();
                if (atEnd()) {
                    throw new IllegalArgumentException("JSON 意外结束");
                }
                char c = text.charAt(position);
                return switch (c) {
                    case '{' -> parseObject();
                    case '[' -> parseArray();
                    case '"' -> parseString();
                    case 't' -> literal("true", Boolean.TRUE);
                    case 'f' -> literal("false", Boolean.FALSE);
                    case 'n' -> literal("null", null);
                    default -> parseNumber();
                };
            }

            private Map<String, Object> parseObject() {
                Map<String, Object> map = new LinkedHashMap<>();
                position++; // '{'
                skipWhitespace();
                if (!atEnd() && text.charAt(position) == '}') {
                    position++;
                    return map;
                }
                while (true) {
                    skipWhitespace();
                    String key = parseString();
                    skipWhitespace();
                    expect(':');
                    map.put(key, parseValue());
                    skipWhitespace();
                    if (!atEnd() && text.charAt(position) == ',') {
                        position++;
                        continue;
                    }
                    expect('}');
                    return map;
                }
            }

            private List<Object> parseArray() {
                List<Object> list = new ArrayList<>();
                position++; // '['
                skipWhitespace();
                if (!atEnd() && text.charAt(position) == ']') {
                    position++;
                    return list;
                }
                while (true) {
                    list.add(parseValue());
                    skipWhitespace();
                    if (!atEnd() && text.charAt(position) == ',') {
                        position++;
                        continue;
                    }
                    expect(']');
                    return list;
                }
            }

            private String parseString() {
                expect('"');
                StringBuilder value = new StringBuilder();
                while (!atEnd()) {
                    char c = text.charAt(position++);
                    if (c == '"') {
                        return value.toString();
                    }
                    if (c == '\\') {
                        if (atEnd()) {
                            break;
                        }
                        char escape = text.charAt(position++);
                        switch (escape) {
                            case '"' -> value.append('"');
                            case '\\' -> value.append('\\');
                            case '/' -> value.append('/');
                            case 'n' -> value.append('\n');
                            case 'r' -> value.append('\r');
                            case 't' -> value.append('\t');
                            case 'b' -> value.append('\b');
                            case 'f' -> value.append('\f');
                            case 'u' -> {
                                value.append((char) Integer.parseInt(
                                        text.substring(position, position + 4),
                                        16));
                                position += 4;
                            }
                            default -> throw new IllegalArgumentException(
                                    "非法转义: \\" + escape);
                        }
                    } else {
                        value.append(c);
                    }
                }
                throw new IllegalArgumentException("字符串未闭合");
            }

            private Object parseNumber() {
                int start = position;
                while (!atEnd()) {
                    char c = text.charAt(position);
                    if ((c >= '0' && c <= '9') || c == '-' || c == '+'
                            || c == '.' || c == 'e' || c == 'E') {
                        position++;
                    } else {
                        break;
                    }
                }
                if (start == position) {
                    throw new IllegalArgumentException(
                            "此处需要 JSON 值（位置 " + position + "）");
                }
                try {
                    return Double.valueOf(text.substring(start, position));
                } catch (NumberFormatException failure) {
                    throw new IllegalArgumentException("数字格式无效", failure);
                }
            }

            private Object literal(String word, Object value) {
                if (text.startsWith(word, position)) {
                    position += word.length();
                    return value;
                }
                throw new IllegalArgumentException(
                        "无法识别的字面量（位置 " + position + "）");
            }

            private void expect(char expected) {
                if (atEnd() || text.charAt(position) != expected) {
                    throw new IllegalArgumentException(
                            "期望 '" + expected + "'（位置 " + position + "）");
                }
                position++;
            }

            private void skipWhitespace() {
                while (!atEnd()) {
                    char c = text.charAt(position);
                    if (c == ' ' || c == '\t' || c == '\n' || c == '\r') {
                        position++;
                    } else {
                        return;
                    }
                }
            }

            private boolean atEnd() {
                return position >= text.length();
            }
        }
    }
}
