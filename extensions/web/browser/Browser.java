import java.io.BufferedReader;
import java.io.BufferedWriter;
import java.io.IOException;
import java.io.InputStream;
import java.io.InputStreamReader;
import java.io.OutputStreamWriter;
import java.net.URI;
import java.net.http.HttpClient;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;
import java.net.http.HttpTimeoutException;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.security.MessageDigest;
import java.time.Duration;
import java.util.ArrayList;
import java.util.HexFormat;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.Set;
import java.util.concurrent.CompletableFuture;
import java.util.concurrent.CompletionException;
import java.util.concurrent.ConcurrentHashMap;
import java.util.regex.Pattern;

/**
 * /web/browser 常驻插件（docs/31 §4 + §11 M3a）：会话化浏览器的全部
 * 原语。本目录 19 个 process 清单共享这一个进程（§3.2），invoke 帧的
 * tool 字段决定原语。
 *
 * <p>daemon 协议所有权在插件：endpoint、Bearer token、幂等键与
 * actionAttemptId 都由这里组装；token 只从 runtimes.json 声明的环境
 * 变量名读取（默认 IRIS_BRIDGE_TOKEN，与 webbridge-daemon 同源）。
 * Runtime 不可达/未配置 = 本次调用明确报错，不静默降级。</p>
 *
 * <p>写语义：动作类原语把 daemon 的 applied / not_applied /
 * outcome_unknown 三态如实投影成 result 帧的 success 与 error.code，
 * 不伪造成功。截图字节由插件写入工作区围栏内声明路径（自证 =
 * 内容 hash 随 structuredData 返回）。</p>
 *
 * <p>人工接管不是浏览器原语：需要用户操作时由内核
 * /system/interaction/ask_user 暂停任务，用户交还后用
 * observe_browser_page 重读页面再继续。</p>
 */
public class Browser {

    private static final Duration READ_TIMEOUT = Duration.ofSeconds(8);
    private static final Duration ACTION_TIMEOUT = Duration.ofSeconds(45);
    private static final Duration HEALTH_CACHE = Duration.ofSeconds(3);
    private static final long MAX_SCREENSHOT_BYTES = 12L * 1024 * 1024;
    private static final long MAX_UPLOAD_BYTES = 128L * 1024 * 1024;
    private static final Pattern OBJECT_ID =
            Pattern.compile("[A-Za-z0-9][A-Za-z0-9._:-]{0,127}");
    private static final Pattern OBSERVATION_REF =
            Pattern.compile("obs_[a-f0-9]{16,64}");
    private static final Set<String> ALLOWED_KEYS = Set.of(
            "Enter", "Escape", "Tab",
            "ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight",
            "Home", "End", "PageUp", "PageDown",
            "Backspace", "Delete", "Space");
    private static final Set<String> UNFILLABLE_TYPES = Set.of(
            "password", "file", "hidden", "checkbox",
            "radio", "button", "submit", "reset", "image");

    private static final Map<String, CallTask> inFlight =
            new ConcurrentHashMap<>();
    private static final Map<String, CachedHealth> healthCache =
            new ConcurrentHashMap<>();
    private static BufferedWriter out;
    private static HttpClient http;
    private static RuntimeRegistry registry;

    public static void main(String[] args) throws Exception {
        BufferedReader in = new BufferedReader(new InputStreamReader(
                System.in, StandardCharsets.UTF_8));
        out = new BufferedWriter(new OutputStreamWriter(
                System.out, StandardCharsets.UTF_8));
        http = HttpClient.newBuilder()
                .connectTimeout(Duration.ofSeconds(5))
                .build();
        registry = RuntimeRegistry.load(
                Path.of(Browser.class.getProtectionDomain()
                        .getCodeSource().getLocation().toURI())
                        .getParent());
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
            Thread.ofVirtual().name("browser-" + callId).start(task);
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
                        "cancelled", "调用已取消，浏览器动作未提交或已中止"));
            } catch (Failure failure) {
                result.put("success", false);
                result.put("error", error(failure.code, failure.getMessage()));
            } catch (Exception unexpected) {
                result.put("success", false);
                result.put("error", error(
                        "browser_plugin_internal_error",
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
            return switch (tool) {
                case "list_browser_runtimes" ->
                        Actions.listRuntimes(call);
                case "list_browser_sessions" ->
                        Actions.listSessions(call, input);
                case "open_browser_session" ->
                        Actions.openSession(call, input);
                case "close_browser_session" ->
                        Actions.closeSession(call, input);
                case "observe_browser_page" ->
                        Actions.observe(call, input);
                case "open_browser_page" ->
                        Actions.openPage(call, input);
                case "switch_browser_page" ->
                        Actions.switchPage(call, input);
                case "close_browser_page" ->
                        Actions.closePage(call, input);
                case "navigate_browser_page" ->
                        Actions.navigate(call, input);
                case "navigate_browser_history" ->
                        Actions.navigateHistory(call, input);
                case "wait_browser_page" ->
                        Actions.waitForPage(call, input);
                case "click_browser_element" ->
                        Actions.click(call, input);
                case "fill_browser_field" ->
                        Actions.fill(call, input);
                case "select_browser_option" ->
                        Actions.select(call, input);
                case "press_browser_key" ->
                        Actions.press(call, input);
                case "scroll_browser_page" ->
                        Actions.scroll(call, input);
                case "upload_browser_file" ->
                        Actions.upload(call, input, workspaceRoot(message));
                case "capture_browser_screenshot" ->
                        Actions.screenshot(call, input, workspaceRoot(message));
                case "inspect_browser_action" ->
                        Actions.inspectAction(call, input);
                default -> throw new Failure(
                        "unknown_browser_primitive",
                        "未知浏览器原语: " + tool);
            };
        }
    }

    /** 调用级取消上下文：cancel 帧到达时中止在途 HTTP 请求。 */
    static final class Call {
        final String id;
        private volatile boolean cancelled;
        private volatile CompletableFuture<?> pending;

        Call(String id) {
            this.id = id;
        }

        void cancel() {
            cancelled = true;
            CompletableFuture<?> future = pending;
            if (future != null) {
                future.cancel(true);
            }
        }

        void check() throws Cancelled {
            if (cancelled) {
                throw new Cancelled();
            }
        }

        void track(CompletableFuture<?> future) {
            pending = future;
            if (cancelled) {
                future.cancel(true);
            }
        }

        void untrack(CompletableFuture<?> future) {
            if (pending == future) {
                pending = null;
            }
        }
    }

    // ------------------------------------------------------------------
    // 原语实现：每个静态方法对应一个工具，daemon 协议细节全部在这一层。
    // ------------------------------------------------------------------
    static final class Actions {
        private Actions() {
        }

        static Map<String, Object> listRuntimes(Call call) throws Exception {
            List<Object> items = new ArrayList<>();
            for (RuntimeBinding binding : registry.bindings.values()) {
                String reason = healthReason(call, binding);
                Map<String, Object> item = new LinkedHashMap<>();
                item.put("runtimeId", binding.id());
                item.put("title", binding.title());
                item.put("description", binding.description());
                item.put("available", reason == null);
                item.put("reason", reason == null ? "可用" : reason);
                item.put("protocolVersion", binding.protocolVersion());
                item.put("isDefault",
                        binding.id().equals(registry.defaultRuntimeId));
                items.add(item);
            }
            Map<String, Object> structured = new LinkedHashMap<>();
            structured.put("runtimes", items);
            structured.put("count", items.size());
            structured.put("guidance", items.isEmpty()
                    ? "当前没有配置 Browser Runtime；请在插件目录的"
                            + " runtimes.json 中绑定本机 daemon"
                    : "普通任务省略 runtime_id 使用默认 Runtime；"
                            + "仅在定向选择或故障诊断时显式指定");
            return ok("共配置 " + items.size() + " 个 Browser Runtime",
                    structured);
        }

        static Map<String, Object> listSessions(Call call, Map<?, ?> input)
                throws Exception {
            RuntimeBinding binding = resolveAvailable(call, input);
            Map<String, Object> payload = new LinkedHashMap<>(request(
                    call, binding, "GET", "/sessions", null,
                    READ_TIMEOUT).payload());
            payload.put("runtimeId", binding.id());
            int count = numberAt(payload, "count", 0);
            payload.put("guidance", count == 0
                    ? "当前没有存活会话；使用 open_browser_session 创建"
                    : "直接续接活动页，或从 pages 选择 pageId 后调用"
                            + " switch_browser_page；页面引用只在所属页面"
                            + "和会话存活期间有效");
            return ok("Runtime " + binding.id() + " 当前有 " + count
                    + " 个存活会话", payload);
        }

        static Map<String, Object> openSession(Call call, Map<?, ?> input)
                throws Exception {
            RuntimeBinding binding = resolveAvailable(call, input);
            String url = optionalUrl(input, "url");
            Map<String, Object> body = new LinkedHashMap<>();
            if (url != null) {
                body.put("url", url);
            }
            Map<String, Object> payload = new LinkedHashMap<>(request(
                    call, binding, "POST", "/sessions", body,
                    ACTION_TIMEOUT).payload());
            payload.put("runtimeId", binding.id());
            return ok("已创建浏览器会话 "
                    + textAt(payload, "sessionId", ""), payload);
        }

        static Map<String, Object> closeSession(Call call, Map<?, ?> input)
                throws Exception {
            RuntimeBinding binding = resolveAvailable(call, input);
            String sessionId = requiredId(input, "session_id");
            Map<String, Object> payload = request(call, binding, "DELETE",
                    "/sessions/" + segment(sessionId), null,
                    ACTION_TIMEOUT).payload();
            return ok("浏览器会话 " + sessionId + " 已关闭", payload);
        }

        static Map<String, Object> observe(Call call, Map<?, ?> input)
                throws Exception {
            RuntimeBinding binding = resolveAvailable(call, input);
            String sessionId = requiredId(input, "session_id");
            String pageId = optionalId(input, "page_id");
            String purpose = input.get("purpose") instanceof String text
                    ? text.trim() : "interact";
            if (!"interact".equals(purpose) && !"search".equals(purpose)
                    && !"read".equals(purpose)) {
                throw new Failure("invalid_browser_observation_purpose",
                        "purpose 必须是 interact、search 或 read");
            }
            String searchQuery = null;
            if ("search".equals(purpose)) {
                searchQuery = requiredText(input, "search_query", 500);
            }
            int maxText = bounded(input, "max_text_characters",
                    "read".equals(purpose) ? 24_000 : 8_000, 1_000, 80_000);
            int maxElements = bounded(input, "max_elements",
                    "read".equals(purpose) ? 40
                            : "search".equals(purpose) ? 80 : 160,
                    1, 500);
            int maxMatches = bounded(input, "max_matches", 20, 1, 50);
            Map<String, Object> body = new LinkedHashMap<>();
            if (pageId != null) {
                body.put("pageId", pageId);
            }
            body.put("purpose", purpose);
            if (searchQuery != null) {
                body.put("searchQuery", searchQuery);
            }
            body.put("maxTextCharacters", maxText);
            body.put("maxElements", maxElements);
            body.put("maxMatches", maxMatches);
            Map<String, Object> payload = request(call, binding, "POST",
                    "/sessions/" + segment(sessionId) + "/observe", body,
                    ACTION_TIMEOUT).payload();
            String ref = payload.get("observation")
                    instanceof Map<?, ?> observation
                    ? textAt(castMap(observation), "ref", "") : "";
            return ok("已完成 " + purpose + " 目的的页面观察"
                    + (ref.isBlank() ? "" : "，observation ref: " + ref),
                    payload);
        }

        static Map<String, Object> openPage(Call call, Map<?, ?> input)
                throws Exception {
            RuntimeBinding binding = resolveAvailable(call, input);
            String sessionId = requiredId(input, "session_id");
            String url = requiredUrl(input, "url");
            Map<String, Object> body = actionBody(call, "open_page");
            body.put("url", url);
            Map<String, Object> payload = request(call, binding, "POST",
                    "/sessions/" + segment(sessionId) + "/pages", body,
                    ACTION_TIMEOUT).payload();
            Map<String, Object> outcome = actionOutcome(payload,
                    "browser_page_open_not_applied", "新页面未打开",
                    "browser_page_open_outcome_unknown",
                    "Browser Runtime 未能证明新页面是否已经打开");
            // 不假成功：applied 还必须携带新页面身份，否则降级 unknown。
            if (!boolAt(payload, "openedNewPage", false)
                    || textAt(payload, "pageId", "").isBlank()) {
                throw new Failure("browser_page_open_outcome_unknown",
                        "daemon 返回了页面打开结果，但缺少新页面身份");
            }
            return outcome;
        }

        static Map<String, Object> switchPage(Call call, Map<?, ?> input)
                throws Exception {
            RuntimeBinding binding = resolveAvailable(call, input);
            String sessionId = requiredId(input, "session_id");
            String pageId = requiredId(input, "page_id");
            Map<String, Object> body = new LinkedHashMap<>();
            body.put("pageId", pageId);
            body.put("purpose", "interact");
            Map<String, Object> payload = request(call, binding, "POST",
                    "/sessions/" + segment(sessionId) + "/pages/switch",
                    body, ACTION_TIMEOUT).payload();
            return ok("已切换到页面 " + pageId + " 并完成新观察", payload);
        }

        static Map<String, Object> closePage(Call call, Map<?, ?> input)
                throws Exception {
            RuntimeBinding binding = resolveAvailable(call, input);
            String sessionId = requiredId(input, "session_id");
            String pageId = requiredId(input, "page_id");
            Map<String, Object> payload = request(call, binding, "POST",
                    "/sessions/" + segment(sessionId)
                            + "/pages/" + segment(pageId) + "/close",
                    actionBody(call, "close_page"), ACTION_TIMEOUT).payload();
            return actionOutcome(payload,
                    "browser_page_close_not_applied", "浏览器页面未关闭",
                    "browser_page_close_outcome_unknown",
                    "Browser Runtime 无法证明页面是否已经关闭");
        }

        static Map<String, Object> navigate(Call call, Map<?, ?> input)
                throws Exception {
            RuntimeBinding binding = resolveAvailable(call, input);
            String sessionId = requiredId(input, "session_id");
            String pageId = requiredId(input, "page_id");
            String url = requiredUrl(input, "url");
            String expected = optionalObservationRef(
                    input, "expected_observation_ref");
            Map<String, Object> body = actionBody(call, "navigate");
            if (expected != null) {
                body.put("expectedObservationRef", expected);
            }
            body.put("primitive", "navigate");
            Map<String, Object> arguments = new LinkedHashMap<>();
            arguments.put("pageId", pageId);
            arguments.put("url", url);
            body.put("normalizedArgs", arguments);
            Map<String, Object> payload = request(call, binding, "POST",
                    actionsPath(sessionId), body, ACTION_TIMEOUT).payload();
            return actionOutcome(payload,
                    "browser_action_not_applied",
                    "页面状态已经变化；动作未执行，请重新观察",
                    "browser_action_outcome_unknown",
                    "daemon 无法证明页面动作是否生效");
        }

        static Map<String, Object> navigateHistory(
                Call call, Map<?, ?> input) throws Exception {
            RuntimeBinding binding = resolveAvailable(call, input);
            String sessionId = requiredId(input, "session_id");
            String pageId = requiredId(input, "page_id");
            String observationRef =
                    requiredObservationRef(input, "observation_ref");
            String direction = requiredText(input, "direction", 16);
            if (!Set.of("back", "forward", "reload").contains(direction)) {
                throw new Failure("invalid_browser_history_direction",
                        "direction 只能是 back、forward 或 reload");
            }
            Map<String, Object> body = actionBody(call, "history");
            body.put("expectedObservationRef", observationRef);
            body.put("primitive", "history");
            Map<String, Object> arguments = new LinkedHashMap<>();
            arguments.put("pageId", pageId);
            arguments.put("direction", direction);
            body.put("normalizedArgs", arguments);
            Map<String, Object> payload = request(call, binding, "POST",
                    actionsPath(sessionId), body, ACTION_TIMEOUT).payload();
            return actionOutcome(payload,
                    "browser_history_not_applied",
                    "页面已变化或没有对应历史记录；历史动作未执行",
                    "browser_history_outcome_unknown",
                    "Browser Runtime 无法证明历史动作是否生效");
        }

        static Map<String, Object> waitForPage(Call call, Map<?, ?> input)
                throws Exception {
            RuntimeBinding binding = resolveAvailable(call, input);
            String sessionId = requiredId(input, "session_id");
            String pageId = requiredId(input, "page_id");
            String baseline =
                    requiredObservationRef(input, "after_observation_ref");
            String condition = input.get("condition") instanceof String text
                    ? text.trim() : "change";
            if (!Set.of("change", "ready", "text").contains(condition)) {
                throw new Failure("invalid_browser_wait_condition",
                        "condition 只能是 change、ready 或 text");
            }
            String text = optionalText(input, "text", 500);
            if ("text".equals(condition) && text == null) {
                throw new Failure("invalid_browser_wait_text",
                        "condition=text 时必须提供非空 text");
            }
            int timeoutMs = bounded(input, "timeout_ms", 5_000, 250, 15_000);
            Map<String, Object> body = new LinkedHashMap<>();
            body.put("pageId", pageId);
            body.put("afterObservationRef", baseline);
            body.put("condition", condition);
            if (text != null) {
                body.put("text", text);
            }
            body.put("timeoutMs", timeoutMs);
            Map<String, Object> payload = request(call, binding, "POST",
                    "/sessions/" + segment(sessionId) + "/wait", body,
                    Duration.ofMillis(timeoutMs + 3_000L)).payload();
            return ok("页面等待结束（conditionMet="
                    + boolAt(payload, "conditionMet", false) + "）", payload);
        }

        static Map<String, Object> click(Call call, Map<?, ?> input)
                throws Exception {
            RuntimeBinding binding = resolveAvailable(call, input);
            String sessionId = requiredId(input, "session_id");
            String pageId = requiredId(input, "page_id");
            String observationRef =
                    requiredObservationRef(input, "observation_ref");
            String elementRef = requiredId(input, "element_ref");
            Map<String, Object> element = resolveElement(
                    call, binding, sessionId, pageId, observationRef,
                    elementRef);
            if (boolAt(element, "disabled", false)) {
                throw new Failure("browser_element_disabled",
                        "页面元素当前不可点击："
                                + describeElement(element, elementRef));
            }
            Map<String, Object> body = actionBody(call, "click");
            body.put("expectedObservationRef", observationRef);
            body.put("primitive", "click");
            Map<String, Object> arguments = new LinkedHashMap<>();
            arguments.put("pageId", pageId);
            arguments.put("elementRef", elementRef);
            body.put("normalizedArgs", arguments);
            Map<String, Object> payload = request(call, binding, "POST",
                    actionsPath(sessionId), body, ACTION_TIMEOUT).payload();
            return actionOutcome(payload,
                    "browser_action_not_applied",
                    "页面或元素状态已变化；点击未执行，请重新观察",
                    "browser_action_outcome_unknown",
                    "daemon 无法证明点击是否生效");
        }

        static Map<String, Object> fill(Call call, Map<?, ?> input)
                throws Exception {
            RuntimeBinding binding = resolveAvailable(call, input);
            String sessionId = requiredId(input, "session_id");
            String pageId = requiredId(input, "page_id");
            String observationRef =
                    requiredObservationRef(input, "observation_ref");
            String elementRef = requiredId(input, "element_ref");
            if (!(input.get("value") instanceof String value)
                    || value.length() > 20_000) {
                throw new Failure("invalid_browser_field_value",
                        "value 必须是长度不超过 20000 的字符串；"
                                + "清空字段请传空字符串");
            }
            Map<String, Object> element = resolveElement(
                    call, binding, sessionId, pageId, observationRef,
                    elementRef);
            String tag = textAt(element, "tag", "");
            String role = textAt(element, "role", "");
            String type = textAt(element, "type", "")
                    .toLowerCase(Locale.ROOT);
            boolean editable = "input".equals(tag) || "textarea".equals(tag)
                    || "textbox".equals(role)
                    || boolAt(element, "contentEditable", false);
            if (!editable || UNFILLABLE_TYPES.contains(type)) {
                throw new Failure("browser_field_not_fillable",
                        describeElement(element, elementRef)
                                + " 不是普通可重读文本字段；密码、文件与敏感输入"
                                + "请改用人工接管（ask_user + 重新观察）");
            }
            if (boolAt(element, "disabled", false)) {
                throw new Failure("browser_element_disabled",
                        describeElement(element, elementRef) + " 当前不可编辑");
            }
            Map<String, Object> body = actionBody(call, "fill");
            body.put("expectedObservationRef", observationRef);
            body.put("primitive", "fill");
            Map<String, Object> arguments = new LinkedHashMap<>();
            arguments.put("pageId", pageId);
            arguments.put("elementRef", elementRef);
            arguments.put("value", value);
            body.put("normalizedArgs", arguments);
            Map<String, Object> payload = request(call, binding, "POST",
                    actionsPath(sessionId), body, ACTION_TIMEOUT).payload();
            return actionOutcome(payload,
                    "browser_action_not_applied",
                    "页面或字段状态已变化；填写未执行，请重新观察",
                    "browser_action_outcome_unknown",
                    "daemon 无法证明字段填写是否生效");
        }

        static Map<String, Object> select(Call call, Map<?, ?> input)
                throws Exception {
            RuntimeBinding binding = resolveAvailable(call, input);
            String sessionId = requiredId(input, "session_id");
            String pageId = requiredId(input, "page_id");
            String observationRef =
                    requiredObservationRef(input, "observation_ref");
            String elementRef = requiredId(input, "element_ref");
            if (!(input.get("value") instanceof String value)) {
                throw new Failure("invalid_browser_option_value",
                        "value 必须是 observation 中 option 的字符串 value");
            }
            Map<String, Object> element = resolveElement(
                    call, binding, sessionId, pageId, observationRef,
                    elementRef);
            if (!"select".equals(textAt(element, "tag", ""))) {
                throw new Failure("browser_select_not_supported",
                        "元素 " + elementRef + " 不是原生 select 下拉框");
            }
            boolean found = false;
            boolean optionDisabled = false;
            if (element.get("options") instanceof List<?> options) {
                for (Object candidate : options) {
                    if (candidate instanceof Map<?, ?> option
                            && value.equals(textAt(
                                    castMap(option), "value", null))) {
                        found = true;
                        optionDisabled = boolAt(
                                castMap(option), "disabled", false);
                        break;
                    }
                }
            }
            if (!found || optionDisabled) {
                throw new Failure("browser_option_not_available",
                        "当前观察中没有可用 option value=" + value);
            }
            Map<String, Object> body = actionBody(call, "select");
            body.put("expectedObservationRef", observationRef);
            body.put("primitive", "select");
            Map<String, Object> arguments = new LinkedHashMap<>();
            arguments.put("pageId", pageId);
            arguments.put("elementRef", elementRef);
            arguments.put("value", value);
            body.put("normalizedArgs", arguments);
            Map<String, Object> payload = request(call, binding, "POST",
                    actionsPath(sessionId), body, ACTION_TIMEOUT).payload();
            return actionOutcome(payload,
                    "browser_action_not_applied",
                    "页面或下拉项已变化；选择未执行，请重新观察",
                    "browser_action_outcome_unknown",
                    "无法确认下拉项是否改变");
        }

        static Map<String, Object> press(Call call, Map<?, ?> input)
                throws Exception {
            RuntimeBinding binding = resolveAvailable(call, input);
            String sessionId = requiredId(input, "session_id");
            String pageId = requiredId(input, "page_id");
            String observationRef =
                    requiredObservationRef(input, "observation_ref");
            String key = requiredText(input, "key", 32);
            if (!ALLOWED_KEYS.contains(key)) {
                throw new Failure("invalid_browser_key",
                        "key 只能是 Enter、Escape、Tab、方向/翻页键、"
                                + "Backspace、Delete 或 Space");
            }
            String elementRef = optionalId(input, "element_ref");
            if (elementRef != null) {
                Map<String, Object> element = resolveElement(
                        call, binding, sessionId, pageId, observationRef,
                        elementRef);
                if (boolAt(element, "disabled", false)) {
                    throw new Failure("browser_element_disabled",
                            "指定元素当前不可接收按键："
                                    + describeElement(element, elementRef));
                }
            }
            Map<String, Object> body = actionBody(call, "press");
            body.put("expectedObservationRef", observationRef);
            body.put("primitive", "press");
            Map<String, Object> arguments = new LinkedHashMap<>();
            arguments.put("pageId", pageId);
            arguments.put("key", key);
            if (elementRef != null) {
                arguments.put("elementRef", elementRef);
            }
            body.put("normalizedArgs", arguments);
            Map<String, Object> payload = request(call, binding, "POST",
                    actionsPath(sessionId), body, ACTION_TIMEOUT).payload();
            return actionOutcome(payload,
                    "browser_action_not_applied",
                    "页面或焦点状态已变化；按键未发送，请重新观察",
                    "browser_action_outcome_unknown",
                    "daemon 无法证明按键动作是否生效");
        }

        static Map<String, Object> scroll(Call call, Map<?, ?> input)
                throws Exception {
            RuntimeBinding binding = resolveAvailable(call, input);
            String sessionId = requiredId(input, "session_id");
            String pageId = requiredId(input, "page_id");
            String observationRef =
                    requiredObservationRef(input, "observation_ref");
            String direction = requiredText(input, "direction", 16);
            if (!Set.of("up", "down", "top", "bottom").contains(direction)) {
                throw new Failure("invalid_browser_scroll_direction",
                        "direction 必须是 up、down、top 或 bottom");
            }
            int amount = bounded(input, "amount", 800, 100, 5_000);
            Map<String, Object> body = actionBody(call, "scroll");
            body.put("expectedObservationRef", observationRef);
            body.put("primitive", "scroll");
            Map<String, Object> arguments = new LinkedHashMap<>();
            arguments.put("pageId", pageId);
            arguments.put("direction", direction);
            arguments.put("amount", amount);
            body.put("normalizedArgs", arguments);
            Map<String, Object> payload = request(call, binding, "POST",
                    actionsPath(sessionId), body, ACTION_TIMEOUT).payload();
            return actionOutcome(payload,
                    "browser_action_not_applied",
                    "页面状态已经变化；滚动未执行，请重新观察",
                    "browser_action_outcome_unknown",
                    "daemon 无法证明页面视口是否已经滚动");
        }

        static Map<String, Object> upload(
                Call call, Map<?, ?> input, Path workspace) throws Exception {
            RuntimeBinding binding = resolveAvailable(call, input);
            String sessionId = requiredId(input, "session_id");
            String pageId = requiredId(input, "page_id");
            String observationRef =
                    requiredObservationRef(input, "observation_ref");
            String elementRef = requiredId(input, "element_ref");
            Map<String, Object> element = resolveElement(
                    call, binding, sessionId, pageId, observationRef,
                    elementRef);
            if (!"input".equals(textAt(element, "tag", ""))
                    || !"file".equals(textAt(element, "type", ""))) {
                throw new Failure("browser_file_input_required",
                        "element_ref 必须指向当前观察中的 file input");
            }
            if (boolAt(element, "disabled", false)) {
                throw new Failure("browser_element_disabled",
                        "目标 file input 当前不可用");
            }
            String workspacePath = requiredText(input, "workspace_path", 500);
            Path file = fence(workspace, workspacePath);
            if (!Files.isRegularFile(file)) {
                throw new Failure("workspace_file_not_found",
                        "工作区内找不到文件: " + workspacePath);
            }
            long byteCount = Files.size(file);
            if (byteCount > MAX_UPLOAD_BYTES) {
                throw new Failure("browser_upload_file_too_large",
                        "上传文件为 " + byteCount + " 字节，超过 128 MiB 上限");
            }
            String contentHash = sha256(file);
            Map<String, Object> body = actionBody(call, "upload");
            body.put("expectedObservationRef", observationRef);
            body.put("primitive", "upload");
            Map<String, Object> arguments = new LinkedHashMap<>();
            arguments.put("pageId", pageId);
            arguments.put("elementRef", elementRef);
            arguments.put("filePath", file.toString());
            arguments.put("fileName", file.getFileName().toString());
            arguments.put("byteCount", byteCount);
            body.put("normalizedArgs", arguments);
            Map<String, Object> payload = request(call, binding, "POST",
                    actionsPath(sessionId), body, ACTION_TIMEOUT).payload();
            Map<String, Object> result = actionOutcome(payload,
                    "browser_upload_not_applied",
                    "页面、字段或工作区文件已变化；文件未设置",
                    "browser_upload_outcome_unknown",
                    "Browser Runtime 无法证明文件是否已经设置");
            // 自证：内容 hash 随结果返回，供事后核对网页读到的是同一文件
            Map<String, Object> structured = new LinkedHashMap<>(
                    castMap((Map<?, ?>) result.get("structuredData")));
            structured.put("workspacePath", workspacePath);
            structured.put("contentHash", contentHash);
            structured.put("byteCount", byteCount);
            result.put("structuredData", structured);
            return result;
        }

        static Map<String, Object> screenshot(
                Call call, Map<?, ?> input, Path workspace) throws Exception {
            RuntimeBinding binding = resolveAvailable(call, input);
            String sessionId = requiredId(input, "session_id");
            String pageId = requiredId(input, "page_id");
            String format = input.get("format") instanceof String text
                    ? text.trim().toLowerCase(Locale.ROOT) : "jpeg";
            if (!"jpeg".equals(format) && !"png".equals(format)) {
                throw new Failure("invalid_screenshot_format",
                        "format 只能是 jpeg 或 png");
            }
            int quality = bounded(input, "quality", 70, 30, 90);
            boolean fullPage = input.get("full_page") instanceof Boolean flag
                    && flag;
            String workspacePath = requiredText(input, "workspace_path", 500);
            Path target = fence(workspace, workspacePath);
            Path parent = target.getParent();
            if (parent == null || !Files.isDirectory(parent)) {
                throw new Failure("workspace_parent_not_found",
                        "截图目标的父目录在工作区内不存在: " + workspacePath);
            }
            Map<String, Object> body = new LinkedHashMap<>();
            body.put("pageId", pageId);
            body.put("format", format);
            body.put("quality", quality);
            body.put("fullPage", fullPage);
            HttpResponse<byte[]> response = requestBytes(call, binding,
                    "/sessions/" + segment(sessionId) + "/screenshot",
                    body, ACTION_TIMEOUT);
            String mediaType = response.headers()
                    .firstValue("Content-Type").orElse("");
            if (!"image/png".equals(mediaType)
                    && !"image/jpeg".equals(mediaType)) {
                throw new Failure("webbridge_invalid_screenshot",
                        "Browser Runtime 返回了不支持的截图媒体类型");
            }
            byte[] bytes = response.body();
            if (bytes.length == 0 || bytes.length > MAX_SCREENSHOT_BYTES) {
                throw new Failure("webbridge_invalid_screenshot",
                        "Browser Runtime 截图为空或超过 12 MB");
            }
            Files.write(target, bytes);
            Map<String, Object> structured = new LinkedHashMap<>();
            structured.put("workspacePath", workspacePath);
            structured.put("byteCount", bytes.length);
            structured.put("contentHash", sha256(target));
            structured.put("mediaType", mediaType);
            structured.put("pageId", response.headers()
                    .firstValue("X-Iris-Page-Id").orElse(pageId));
            structured.put("observationRef", response.headers()
                    .firstValue("X-Iris-Observation-Ref").orElse(""));
            structured.put("guidance",
                    "截图已写入工作区文件；用工作区文件读取/预览原语查看图像，"
                            + "不要把字节塞进文本上下文");
            return ok("页面截图已写入工作区文件 " + workspacePath
                    + "（" + bytes.length + " 字节）", structured);
        }

        static Map<String, Object> inspectAction(Call call, Map<?, ?> input)
                throws Exception {
            RuntimeBinding binding = resolveAvailable(call, input);
            String sessionId = requiredId(input, "session_id");
            String executionId = requiredId(input, "tool_execution_id");
            Map<String, Object> payload = request(call, binding, "GET",
                    "/sessions/" + segment(sessionId)
                            + "/actions/" + segment(executionId),
                    null, READ_TIMEOUT).payload();
            return actionOutcome(payload,
                    "browser_action_not_applied",
                    "原浏览器动作已确认没有执行；请重新观察后调整",
                    "browser_action_still_unknown",
                    "原浏览器动作仍无法确认；请重新观察页面并核对当前事实");
        }

        // --------------------------------------------------------------
        // 原语层内部小工具
        // --------------------------------------------------------------

        private static Map<String, Object> ok(
                String data, Map<String, Object> structured) {
            Map<String, Object> result = new LinkedHashMap<>();
            result.put("success", true);
            result.put("data", data);
            result.put("structuredData", structured);
            return result;
        }

        /** 动作请求公共帧：callId（= 内核 executionId）即幂等身份。 */
        private static Map<String, Object> actionBody(
                Call call, String attemptSuffix) {
            Map<String, Object> body = new LinkedHashMap<>();
            body.put("toolExecutionId", call.id);
            body.put("actionAttemptId", call.id + ":" + attemptSuffix);
            body.put("idempotencyKey", call.id);
            return body;
        }

        private static String actionsPath(String sessionId) throws Failure {
            return "/sessions/" + segment(sessionId) + "/actions";
        }

        private static Map<String, Object> resolveElement(
                Call call,
                RuntimeBinding binding,
                String sessionId,
                String pageId,
                String observationRef,
                String elementRef
        ) throws Exception {
            Map<String, Object> body = new LinkedHashMap<>();
            body.put("pageId", pageId);
            body.put("observationRef", observationRef);
            body.put("elementRef", elementRef);
            Map<String, Object> payload = request(call, binding, "POST",
                    "/sessions/" + segment(sessionId) + "/elements/resolve",
                    body, READ_TIMEOUT).payload();
            if (payload.get("element") instanceof Map<?, ?> element) {
                return castMap(element);
            }
            throw new Failure("browser_element_not_resolvable",
                    "daemon 没有返回元素 " + elementRef + " 的解析结果");
        }

        private static String describeElement(
                Map<String, Object> element, String fallback) {
            String name = textAt(element, "name", "").trim();
            String tag = textAt(element, "tag", "element");
            return name.isBlank()
                    ? "页面元素 " + fallback + "（" + tag + "）"
                    : "页面元素“" + name + "”（" + tag + "）";
        }
    }

    // ------------------------------------------------------------------
    // Runtime 注册表与健康检查
    // ------------------------------------------------------------------

    /** 插件自有的 Runtime 注册表（runtimes.json）；token 只存环境变量名。 */
    static final class RuntimeRegistry {
        final Map<String, RuntimeBinding> bindings;
        final String defaultRuntimeId;

        private RuntimeRegistry(
                Map<String, RuntimeBinding> bindings,
                String defaultRuntimeId
        ) {
            this.bindings = bindings;
            this.defaultRuntimeId = defaultRuntimeId;
        }

        static RuntimeRegistry load(Path pluginDir) throws Failure {
            Path file = pluginDir.resolve("runtimes.json");
            Object parsed;
            try {
                parsed = Json.parse(Files.readString(
                        file, StandardCharsets.UTF_8));
            } catch (IOException | RuntimeException readFailure) {
                throw new Failure("browser_runtimes_config_invalid",
                        "runtimes.json 不可读或不是合法 JSON: "
                                + readFailure.getMessage());
            }
            if (!(parsed instanceof Map<?, ?> root)) {
                throw new Failure("browser_runtimes_config_invalid",
                        "runtimes.json 顶层必须是 object");
            }
            Map<String, RuntimeBinding> bindings = new LinkedHashMap<>();
            Object runtimes = root.get("runtimes");
            if (runtimes instanceof List<?> list) {
                for (Object element : list) {
                    if (!(element instanceof Map<?, ?> entry)) {
                        continue;
                    }
                    RuntimeBinding binding = binding(entry);
                    bindings.put(binding.id(), binding);
                }
            }
            String defaultId = root.get("default_runtime")
                    instanceof String text ? text.trim() : null;
            if (defaultId != null && !defaultId.isBlank()
                    && !bindings.containsKey(defaultId)) {
                throw new Failure("browser_runtimes_config_invalid",
                        "default_runtime 未在 runtimes 中定义: " + defaultId);
            }
            if ((defaultId == null || defaultId.isBlank())
                    && bindings.size() == 1) {
                defaultId = bindings.keySet().iterator().next();
            }
            return new RuntimeRegistry(Map.copyOf(bindings), defaultId);
        }

        private static RuntimeBinding binding(Map<?, ?> entry)
                throws Failure {
            String id = text(entry, "id");
            String title = text(entry, "title");
            String description = text(entry, "description");
            String endpoint = text(entry, "endpoint");
            String tokenEnv = text(entry, "token_env");
            int protocol = entry.get("protocol_version")
                    instanceof Number number ? number.intValue() : -1;
            if (id == null || !OBJECT_ID.matcher(id).matches()
                    || title == null || description == null
                    || endpoint == null || tokenEnv == null || protocol < 1) {
                throw new Failure("browser_runtimes_config_invalid",
                        "runtimes.json 存在不完整的 Runtime 条目: " + id);
            }
            URI uri = URI.create(endpoint);
            if (!"http".equalsIgnoreCase(uri.getScheme())
                    || uri.getHost() == null
                    || !"127.0.0.1".equals(uri.getHost())
                    || uri.getUserInfo() != null
                    || uri.getQuery() != null
                    || uri.getFragment() != null) {
                throw new Failure("browser_runtimes_config_invalid",
                        "Runtime endpoint 必须是干净的 http://127.0.0.1 地址: "
                                + id);
            }
            String normalized = endpoint.replaceAll("/+$", "");
            String token = System.getenv(tokenEnv);
            return new RuntimeBinding(id, title, description,
                    URI.create(normalized), tokenEnv,
                    token == null || token.isBlank() ? null : token.trim(),
                    protocol);
        }

        private static String text(Map<?, ?> entry, String field) {
            return entry.get(field) instanceof String value
                    && !value.isBlank() ? value.trim() : null;
        }
    }

    record RuntimeBinding(
            String id,
            String title,
            String description,
            URI endpoint,
            String tokenEnv,
            String token,
            int protocolVersion
    ) {
    }

    private record CachedHealth(
            boolean available,
            String reason,
            long expiresAtMillis
    ) {
    }

    /** 健康检查（3s 缓存）；返回 null 表示可用，否则为不可用原因。 */
    static String healthReason(Call call, RuntimeBinding binding) {
        long now = System.currentTimeMillis();
        CachedHealth cached = healthCache.get(binding.id());
        if (cached != null && cached.expiresAtMillis() > now) {
            return cached.available() ? null : cached.reason();
        }
        String reason;
        if (binding.token() == null) {
            reason = "缺少访问令牌：环境变量 " + binding.tokenEnv() + " 未设置";
        } else {
            try {
                Map<String, Object> payload = request(call, binding, "GET",
                        "/health", null, READ_TIMEOUT).payload();
                int actual = numberAt(payload, "protocolVersion",
                        numberAt(payload, "protocol_version", -1));
                if (actual != binding.protocolVersion()) {
                    reason = "协议版本不兼容：需要 " + binding.protocolVersion()
                            + "，实际 " + actual;
                } else {
                    boolean ok = boolAt(payload, "ok", false)
                            || "ok".equalsIgnoreCase(
                                    textAt(payload, "status", ""));
                    boolean browserReady = boolAt(payload, "browserReady",
                            boolAt(payload, "browser_ready", true));
                    reason = ok && browserReady
                            ? null : "daemon 已响应，但没有进入 ready 状态";
                }
            } catch (Failure failure) {
                reason = failure.getMessage();
            } catch (Cancelled cancelled) {
                reason = "健康检查已取消";
            }
        }
        healthCache.put(binding.id(), new CachedHealth(
                reason == null,
                reason == null ? "可用" : reason,
                now + HEALTH_CACHE.toMillis()));
        return reason;
    }

    /** runtime_id 可选：缺省走默认 Runtime；执行前核对健康（3s 缓存）。 */
    static RuntimeBinding resolveAvailable(Call call, Map<?, ?> input)
            throws Failure, Cancelled {
        String requested = optionalId(input, "runtime_id");
        RuntimeBinding binding;
        if (requested != null) {
            binding = registry.bindings.get(requested);
            if (binding == null) {
                throw new Failure("browser_runtime_not_found",
                        "找不到 Browser Runtime " + requested
                                + "；先调用 list_browser_runtimes 查看可用对象");
            }
        } else {
            if (registry.bindings.isEmpty()) {
                throw new Failure("browser_runtime_not_configured",
                        "当前没有配置 Browser Runtime（runtimes.json 为空）");
            }
            if (registry.defaultRuntimeId == null) {
                throw new Failure("browser_runtime_choice_required",
                        "配置了多个 Browser Runtime，但没有默认对象；"
                                + "调用 list_browser_runtimes 后显式选择 "
                                + "runtime_id");
            }
            binding = registry.bindings.get(registry.defaultRuntimeId);
        }
        String reason = healthReason(call, binding);
        if (reason != null) {
            throw new Failure("browser_runtime_unavailable",
                    "Browser Runtime " + binding.id() + " 当前不可用："
                            + reason);
        }
        return binding;
    }

    // ------------------------------------------------------------------
    // 通用校验与 HTTP
    // ------------------------------------------------------------------

    static Path workspaceRoot(Map<?, ?> message) throws Failure {
        Object context = message.get("context");
        Object workspace = context instanceof Map<?, ?> map
                ? map.get("workspace") : null;
        if (!(workspace instanceof String text) || text.isBlank()) {
            throw new Failure("workspace_root_missing",
                    "invoke 帧缺少 context.workspace");
        }
        return Path.of(text).toAbsolutePath().normalize();
    }

    /** 工作区围栏（fail-close）：拒绝绝对路径与任何越界解析。 */
    static Path fence(Path root, String relative) throws Failure {
        Path candidate;
        try {
            candidate = Path.of(relative);
        } catch (RuntimeException invalid) {
            throw new Failure("invalid_workspace_path",
                    "不是合法相对路径: " + relative);
        }
        if (candidate.isAbsolute()) {
            throw new Failure("workspace_fence_violation",
                    "必须是工作区内相对路径: " + relative);
        }
        Path resolved = root.resolve(candidate).normalize();
        if (!resolved.startsWith(root) || resolved.equals(root)) {
            throw new Failure("workspace_fence_violation",
                    "越过工作区围栏: " + relative);
        }
        return resolved;
    }

    static String requiredId(Map<?, ?> input, String field) throws Failure {
        String value = input.get(field) instanceof String text
                ? text.trim() : "";
        if (!OBJECT_ID.matcher(value).matches()) {
            throw new Failure("invalid_browser_object_id",
                    field + " 不是有效的 Browser Runtime 对象 ID");
        }
        return value;
    }

    static String optionalId(Map<?, ?> input, String field) throws Failure {
        if (!(input.get(field) instanceof String text)
                || text.isBlank()) {
            return null;
        }
        return requiredId(input, field);
    }

    static String optionalObservationRef(Map<?, ?> input, String field)
            throws Failure {
        if (!(input.get(field) instanceof String text)
                || text.isBlank()) {
            return null;
        }
        if (!OBSERVATION_REF.matcher(text.trim()).matches()) {
            throw new Failure("invalid_browser_observation_ref",
                    field + " 必须来自最近一次 observe_browser_page 返回值");
        }
        return text.trim();
    }

    static String requiredObservationRef(Map<?, ?> input, String field)
            throws Failure {
        String value = optionalObservationRef(input, field);
        if (value == null) {
            throw new Failure("browser_observation_required",
                    field + " 必须传入最近一次页面观察的 observation ref");
        }
        return value;
    }

    static String requiredText(Map<?, ?> input, String field, int max)
            throws Failure {
        String value = input.get(field) instanceof String text
                ? text.trim() : "";
        if (value.isBlank() || value.length() > max) {
            throw new Failure("invalid_tool_input",
                    field + " 必须是 1 到 " + max + " 字符的非空文本");
        }
        return value;
    }

    static String optionalText(Map<?, ?> input, String field, int max)
            throws Failure {
        if (!(input.get(field) instanceof String text)
                || text.isBlank()) {
            return null;
        }
        return requiredText(input, field, max);
    }

    static String requiredUrl(Map<?, ?> input, String field) throws Failure {
        String value = requiredText(input, field, 2_000);
        URI uri;
        try {
            uri = URI.create(value);
        } catch (IllegalArgumentException invalid) {
            throw invalidUrl(field);
        }
        String scheme = uri.getScheme();
        boolean web = "http".equalsIgnoreCase(scheme)
                || "https".equalsIgnoreCase(scheme);
        boolean blankPage = "about".equalsIgnoreCase(scheme)
                && "blank".equalsIgnoreCase(uri.getSchemeSpecificPart());
        if ((!web && !blankPage)
                || (web && (uri.getHost() == null
                || uri.getUserInfo() != null))) {
            throw invalidUrl(field);
        }
        return uri.toASCIIString();
    }

    static String optionalUrl(Map<?, ?> input, String field) throws Failure {
        if (!(input.get(field) instanceof String text)
                || text.isBlank()) {
            return null;
        }
        return requiredUrl(input, field);
    }

    private static Failure invalidUrl(String field) {
        return new Failure("invalid_browser_url",
                field + " 必须是 http/https URL 或 about:blank，"
                        + "且不能包含账号信息");
    }

    static int bounded(
            Map<?, ?> input,
            String field,
            int defaultValue,
            int minimum,
            int maximum
    ) throws Failure {
        int value = input.get(field) instanceof Number number
                ? number.intValue() : defaultValue;
        if (value < minimum || value > maximum) {
            throw new Failure("invalid_tool_input",
                    field + " 必须在 " + minimum + " 到 " + maximum + " 之间");
        }
        return value;
    }

    static String sha256(Path path) throws Failure {
        try {
            MessageDigest digest = MessageDigest.getInstance("SHA-256");
            try (InputStream in = Files.newInputStream(path)) {
                byte[] buffer = new byte[64 * 1024];
                int read;
                while ((read = in.read(buffer)) >= 0) {
                    if (read > 0) {
                        digest.update(buffer, 0, read);
                    }
                }
            }
            return "sha256:" + HexFormat.of().formatHex(digest.digest());
        } catch (Exception failure) {
            throw new Failure("workspace_file_unreadable",
                    "无法读取工作区文件: " + failure.getMessage());
        }
    }

    /** daemon 响应：payload 恒为解析后的 JSON object。 */
    record DaemonResponse(Map<String, Object> payload) {
    }

    static DaemonResponse request(
            Call call,
            RuntimeBinding binding,
            String method,
            String path,
            Map<String, Object> body,
            Duration timeout
    ) throws Failure, Cancelled {
        HttpRequest.Builder request = HttpRequest.newBuilder()
                .uri(URI.create(binding.endpoint().toString() + path))
                .timeout(timeout)
                .header("Accept", "application/json");
        if (binding.token() != null) {
            request.header("Authorization", "Bearer " + binding.token());
        }
        if (body == null) {
            request.method(method, HttpRequest.BodyPublishers.noBody());
        } else {
            request.header("Content-Type", "application/json")
                    .method(method, HttpRequest.BodyPublishers.ofString(
                            Json.write(body), StandardCharsets.UTF_8));
        }
        HttpResponse<String> response = send(call, request.build(),
                HttpResponse.BodyHandlers.ofString(StandardCharsets.UTF_8));
        Object parsed;
        try {
            parsed = Json.parse(response.body());
        } catch (RuntimeException invalid) {
            throw new Failure("webbridge_invalid_response",
                    "Browser Runtime 返回了无法解析的响应");
        }
        Map<String, Object> payload = parsed instanceof Map<?, ?> map
                ? castMap(map) : new LinkedHashMap<>();
        if (response.statusCode() >= 200 && response.statusCode() < 300) {
            return new DaemonResponse(payload);
        }
        throw envelopeError(payload, response.statusCode());
    }

    static HttpResponse<byte[]> requestBytes(
            Call call,
            RuntimeBinding binding,
            String path,
            Map<String, Object> body,
            Duration timeout
    ) throws Failure, Cancelled {
        HttpRequest.Builder request = HttpRequest.newBuilder()
                .uri(URI.create(binding.endpoint().toString() + path))
                .timeout(timeout)
                .header("Accept", "image/png, image/jpeg")
                .header("Content-Type", "application/json");
        if (binding.token() != null) {
            request.header("Authorization", "Bearer " + binding.token());
        }
        request.POST(HttpRequest.BodyPublishers.ofString(
                Json.write(body), StandardCharsets.UTF_8));
        HttpResponse<byte[]> response = send(call, request.build(),
                HttpResponse.BodyHandlers.ofByteArray());
        if (response.statusCode() >= 200 && response.statusCode() < 300) {
            return response;
        }
        Map<String, Object> payload = new LinkedHashMap<>();
        try {
            Object parsed = Json.parse(new String(
                    response.body(), StandardCharsets.UTF_8));
            if (parsed instanceof Map<?, ?> map) {
                payload = castMap(map);
            }
        } catch (RuntimeException ignored) {
            // 错误体不是 JSON 时走兜底 code/message
        }
        throw envelopeError(payload, response.statusCode());
    }

    private static Failure envelopeError(
            Map<String, Object> payload, int statusCode) {
        Object errorNode = payload.get("error");
        String code = errorNode instanceof Map<?, ?> errorMap
                ? textAt(castMap(errorMap), "code", null) : null;
        String message = errorNode instanceof Map<?, ?> errorMap
                ? textAt(castMap(errorMap), "message", null) : null;
        if (code == null) {
            code = textAt(payload, "code", "webbridge_request_failed");
        }
        if (message == null) {
            message = textAt(payload, "message",
                    "Browser Runtime 返回 HTTP " + statusCode);
        }
        return new Failure(code, message);
    }

    private static <T> HttpResponse<T> send(
            Call call,
            HttpRequest request,
            HttpResponse.BodyHandler<T> handler
    ) throws Failure, Cancelled {
        call.check();
        CompletableFuture<HttpResponse<T>> future =
                http.sendAsync(request, handler);
        call.track(future);
        try {
            return future.join();
        } catch (RuntimeException completion) {
            call.check();
            Throwable cause = completion instanceof CompletionException
                    && completion.getCause() != null
                    ? completion.getCause() : completion;
            if (cause instanceof HttpTimeoutException) {
                throw new Failure("webbridge_timeout",
                        "Browser Runtime 响应超时");
            }
            throw new Failure("webbridge_unreachable",
                    "Browser Runtime 当前不可达");
        } finally {
            call.untrack(future);
        }
    }

    /** 动作三态投影：applied / not_applied / outcome_unknown 如实上抛。 */
    static Map<String, Object> actionOutcome(
            Map<String, Object> response,
            String notAppliedCode,
            String notAppliedFallback,
            String unknownCode,
            String unknownFallback
    ) throws Failure {
        String status = textAt(response, "status", "");
        switch (status) {
            case "applied" -> {
                // 不假成功：applied 必须带证据引用；返回里带 observation
                // 对象时其 ref 也必须非空，否则如实降级 outcome_unknown。
                String evidenceRef = response.get("evidence")
                        instanceof Map<?, ?> evidence
                        ? textAt(castMap(evidence), "ref", "") : "";
                Object observationNode = response.get("observation");
                String observationRef = observationNode
                        instanceof Map<?, ?> observation
                        ? textAt(castMap(observation), "ref", "") : null;
                if (evidenceRef.isBlank()
                        || (observationRef != null && observationRef.isBlank())) {
                    throw new Failure(unknownCode, unknownFallback);
                }
                Map<String, Object> success = new LinkedHashMap<>();
                success.put("success", true);
                success.put("data", textAt(response, "message",
                        "动作已应用"));
                success.put("structuredData", response);
                return success;
            }
            case "not_applied" ->
                    throw new Failure(notAppliedCode,
                            textAt(response, "message", notAppliedFallback));
            case "outcome_unknown" ->
                    throw new Failure(unknownCode,
                            textAt(response, "message", unknownFallback));
            default -> throw new Failure("invalid_browser_action_status",
                    "Browser Runtime 返回了未知动作状态");
        }
    }

    static String segment(String value) throws Failure {
        if (value == null || value.isBlank()) {
            throw new Failure("invalid_browser_object_id",
                    "Browser Session/Page 对象 ID 不能为空");
        }
        return java.net.URLEncoder.encode(value, StandardCharsets.UTF_8)
                .replace("+", "%20");
    }

    // ------------------------------------------------------------------
    // JSON 树访问小工具（Map 形态）
    // ------------------------------------------------------------------

    @SuppressWarnings("unchecked")
    static Map<String, Object> castMap(Map<?, ?> map) {
        return (Map<String, Object>) map;
    }

    static String textAt(Map<String, Object> node, String field,
            String fallback) {
        return node.get(field) instanceof String text ? text : fallback;
    }

    static int numberAt(Map<String, Object> node, String field,
            int fallback) {
        return node.get(field) instanceof Number number
                ? number.intValue() : fallback;
    }

    static boolean boolAt(Map<String, Object> node, String field,
            boolean fallback) {
        return node.get(field) instanceof Boolean value
                ? value : fallback;
    }

    private static Map<String, Object> error(String code, String message) {
        Map<String, Object> error = new LinkedHashMap<>();
        error.put("code", code);
        error.put("message", message);
        return error;
    }

    private static synchronized void writeFrame(Map<String, Object> frame) {
        try {
            out.write(Json.write(frame));
            out.newLine();
            out.flush();
        } catch (IOException ignored) {
            // 管道已断，内核侧按进程死亡处理。
        }
    }

    static final class Failure extends Exception {
        final String code;

        Failure(String code, String message) {
            super(message);
            this.code = code;
        }
    }

    private static final class Cancelled extends Exception {
    }

    /**
     * 最小 JSON 编解码（对象/数组/字符串/数字/布尔/null），
     * 与 calculate 插件同形。
     */
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
            if (value == Math.rint(value)
                    && Math.abs(value) < 1e15) {
                return Long.toString((long) value);
            }
            return Double.toString(value);
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

            void skipWhitespace() {
                while (!atEnd()
                        && Character.isWhitespace(text.charAt(position))) {
                    position++;
                }
            }

            boolean atEnd() {
                return position >= text.length();
            }
        }
    }
}
