package com.iris.objective.system;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RestController;

import java.net.URI;
import java.net.http.HttpClient;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;
import java.time.Duration;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

/**
 * 供应商探测 API（WonWork 契约形状 /api/providerprobe/*，对照 ProviderProbeController.cs
 * + ProviderProbeService.cs，逻辑照 cc-switch 的探测语义）。
 *
 * <p>三个端点都是"客观环境探测"：模型清单 / 连通性 / 额度。浏览器直连供应商有
 * CORS 问题，故探测集中走后端；后端只报事实，展示与策略在前端。</p>
 */
@RestController
@RequestMapping("/api/providerprobe")
public class ProviderProbeApiController {

    private static final Duration PROBE_TIMEOUT = Duration.ofSeconds(15);
    private static final Duration PING_TIMEOUT = Duration.ofSeconds(8);
    private static final int ERROR_BODY_MAX = 512;

    /** 已知 Anthropic 协议兼容子路径后缀（照 cc-switch KNOWN_COMPAT_SUFFIXES，最长优先）。 */
    private static final String[] KNOWN_COMPAT_SUFFIXES = {
            "/api/claudecode", "/api/anthropic", "/apps/anthropic", "/api/coding",
            "/claudecode", "/anthropic", "/step_plan", "/coding", "/claude"
    };

    private final ObjectMapper om = new ObjectMapper();
    private final HttpClient http = HttpClient.newBuilder()
            .connectTimeout(PROBE_TIMEOUT)
            .followRedirects(HttpClient.Redirect.NORMAL)
            .build();

    // ── 模型清单 ─────────────────────────────────────────────

    /** POST /api/providerprobe/models —— 候选 URL 逐个试，返回首个成功的。 */
    @PostMapping("/models")
    public Map<String, Object> models(@RequestBody ProbeModelsRequest request) {
        String baseUrl = request == null ? null : request.baseUrl();
        if (isBlank(baseUrl)) {
            return modelsFail("baseUrl 不能为空");
        }
        List<String> candidates;
        try {
            candidates = buildModelsUrlCandidates(baseUrl, request.modelsUrl());
        } catch (Exception ex) {
            return modelsFail(ex.getMessage());
        }

        String lastError = "";
        for (String url : candidates) {
            try {
                HttpRequest.Builder b = HttpRequest.newBuilder()
                        .uri(URI.create(url))
                        .timeout(PROBE_TIMEOUT)
                        .GET();
                applyAuthHeader(b, request.apiKey(), request.apiFormat());
                HttpResponse<String> resp = http.send(b.build(), HttpResponse.BodyHandlers.ofString());

                int status = resp.statusCode();
                if (status == 404 || status == 405) {
                    lastError = "HTTP " + status;
                    continue; // 404/405 续试下一候选（cc-switch 同款）
                }
                if (status < 200 || status >= 300) {
                    return modelsFail("HTTP " + status + "：" + truncate(resp.body()));
                }
                List<String> models = parseOpenAiModelList(resp.body());
                if (models.isEmpty()) {
                    return modelsFail("端点响应中没有可识别的模型清单（期望 OpenAI {data:[{id}]} 形状）");
                }
                Map<String, Object> ok = new LinkedHashMap<>();
                ok.put("success", true);
                ok.put("models", models);
                ok.put("sourceUrl", url);
                return ok;
            } catch (java.net.http.HttpTimeoutException | java.io.InterruptedIOException ex) {
                return modelsFail("请求超时（" + PROBE_TIMEOUT.getSeconds() + "s）：" + url);
            } catch (java.net.ConnectException | java.net.UnknownHostException ex) {
                return modelsFail("网络错误：" + ex.getMessage());
            } catch (InterruptedException ex) {
                Thread.currentThread().interrupt();
                return modelsFail("探测被中断");
            } catch (Exception ex) {
                return modelsFail("探测异常：" + ex.getMessage());
            }
        }
        return modelsFail("所有候选端点均不可用（最后：" + lastError + "）");
    }

    /** 候选 URL 推导（照 cc-switch build_models_url_candidates，已去重保序）。 */
    private static List<String> buildModelsUrlCandidates(String baseUrl, String modelsUrlOverride) {
        if (!isBlank(modelsUrlOverride)) {
            List<String> one = new ArrayList<>();
            one.add(modelsUrlOverride.trim());
            return one;
        }
        String trimmed = baseUrl.trim();
        while (trimmed.endsWith("/")) trimmed = trimmed.substring(0, trimmed.length() - 1);
        if (trimmed.isEmpty()) throw new IllegalArgumentException("baseUrl 不能为空");

        List<String> candidates = new ArrayList<>();
        if (endsWithVersionSegment(trimmed)) {
            candidates.add(trimmed + "/models");
            if (!trimmed.toLowerCase().endsWith("/v1")) {
                candidates.add(trimmed + "/v1/models");
            }
        } else {
            candidates.add(trimmed + "/v1/models");
        }
        String stripped = stripCompatSuffix(trimmed);
        if (stripped != null) {
            String root = stripped;
            while (root.endsWith("/")) root = root.substring(0, root.length() - 1);
            if (root.contains("://")) {
                candidates.add(root + "/v1/models");
                candidates.add(root + "/models");
            }
        }
        // 去重保序
        List<String> unique = new ArrayList<>();
        for (String c : candidates) if (!unique.contains(c)) unique.add(c);
        return unique;
    }

    private static boolean endsWithVersionSegment(String url) {
        int lastSlash = url.lastIndexOf('/');
        if (lastSlash < 0 || lastSlash == url.length() - 1) return false;
        String seg = url.substring(lastSlash + 1);
        if (seg.length() < 2 || (seg.charAt(0) != 'v' && seg.charAt(0) != 'V')) return false;
        for (int i = 1; i < seg.length(); i++) if (!Character.isDigit(seg.charAt(i))) return false;
        return true;
    }

    private static String stripCompatSuffix(String url) {
        String lower = url.toLowerCase(java.util.Locale.ROOT);
        for (String suffix : KNOWN_COMPAT_SUFFIXES) {
            if (lower.endsWith(suffix)) return url.substring(0, url.length() - suffix.length());
        }
        return null;
    }

    private static void applyAuthHeader(HttpRequest.Builder b, String apiKey, String apiFormat) {
        if (isBlank(apiKey)) return;
        // cc-switch：apiFormat=anthropic 用 x-api-key，其余默认 Bearer
        if ("anthropic".equalsIgnoreCase(apiFormat)) {
            b.header("x-api-key", apiKey);
        } else {
            b.header("Authorization", "Bearer " + apiKey);
        }
    }

    private List<String> parseOpenAiModelList(String json) {
        List<String> models = new ArrayList<>();
        try {
            JsonNode root = om.readTree(json);
            JsonNode data = root.get("data");
            if (data == null || !data.isArray()) return models;
            for (JsonNode item : data) {
                JsonNode id = item.get("id");
                if (id != null && id.isTextual() && !id.asText().isBlank()) {
                    models.add(id.asText());
                }
            }
            models.sort(String.CASE_INSENSITIVE_ORDER);
        } catch (Exception ignored) {
            // 非 JSON / 形状不符 → 空清单
        }
        return models;
    }

    // ── 连通性 ───────────────────────────────────────────────

    /** POST /api/providerprobe/ping —— GET base_url 判可达 + 延迟（可达即成功）。 */
    @PostMapping("/ping")
    public Map<String, Object> ping(@RequestBody ProbePingRequest request) {
        String baseUrl = request == null ? null : request.baseUrl();
        if (isBlank(baseUrl)) return pingFail("baseUrl 不能为空");
        URI uri;
        try {
            uri = URI.create(baseUrl);
        } catch (Exception ex) {
            return pingFail("baseUrl 不是合法的 http(s) 地址");
        }
        String scheme = uri.getScheme();
        if (scheme == null || !(scheme.equalsIgnoreCase("http") || scheme.equalsIgnoreCase("https"))) {
            return pingFail("baseUrl 不是合法的 http(s) 地址");
        }
        try {
            HttpClient pingClient = HttpClient.newBuilder()
                    .connectTimeout(PING_TIMEOUT)
                    .followRedirects(HttpClient.Redirect.NORMAL)
                    .build();
            long t0 = System.nanoTime();
            HttpResponse<String> resp = pingClient.send(
                    HttpRequest.newBuilder().uri(uri).timeout(PING_TIMEOUT).GET().build(),
                    HttpResponse.BodyHandlers.ofString());
            long latencyMs = (System.nanoTime() - t0) / 1_000_000;
            Map<String, Object> ok = new LinkedHashMap<>();
            ok.put("ok", true);
            ok.put("status", resp.statusCode());
            ok.put("latencyMs", latencyMs);
            return ok;
        } catch (java.net.http.HttpTimeoutException ex) {
            return pingFail("连接超时（" + PING_TIMEOUT.getSeconds() + "s）");
        } catch (InterruptedException ex) {
            Thread.currentThread().interrupt();
            return pingFail("探测被中断");
        } catch (Exception ex) {
            return pingFail("网络错误：" + ex.getMessage());
        }
    }

    // ── 额度检测 ─────────────────────────────────────────────

    /** POST /api/providerprobe/usage —— URL 子串识别供应商走各家官方端点，未识别如实报不支持。 */
    @PostMapping("/usage")
    public Map<String, Object> usage(@RequestBody ProbeUsageRequest request) {
        String baseUrl = request == null ? null : request.baseUrl();
        String apiKey = request == null ? null : request.apiKey();
        if (isBlank(baseUrl)) return usageFail("baseUrl 不能为空");
        if (isBlank(apiKey)) return usageFail("额度查询需要 API Key");

        String url = baseUrl.toLowerCase(java.util.Locale.ROOT);
        try {
            if (url.contains("api.deepseek.com")) {
                return queryDeepSeekBalance(apiKey);
            } else if (url.contains("api.siliconflow.cn")) {
                return querySiliconFlowBalance("api.siliconflow.cn", apiKey);
            } else if (url.contains("api.siliconflow.com")) {
                return querySiliconFlowBalance("api.siliconflow.com", apiKey);
            } else if (url.contains("openrouter.ai")) {
                return queryOpenRouterCredits(apiKey);
            } else if (url.contains("api.kimi.com/coding")) {
                return queryKimiCodingUsage(apiKey);
            } else if (url.contains("bigmodel.cn")) {
                return queryZhipuUsage("open.bigmodel.cn", apiKey);
            } else if (url.contains("api.z.ai")) {
                return queryZhipuUsage("api.z.ai", apiKey);
            }
            return usageFail("该供应商暂不支持额度查询（未识别）");
        } catch (InterruptedException ex) {
            Thread.currentThread().interrupt();
            return usageFail("查询被中断");
        } catch (Exception ex) {
            return usageFail("查询异常：" + ex.getMessage());
        }
    }

    /** 带 Bearer 鉴权 GET 并读完整 body。返回 [status, body]。 */
    private String[] sendAuthedGet(String url, String apiKey) throws Exception {
        HttpResponse<String> resp = http.send(
                HttpRequest.newBuilder()
                        .uri(URI.create(url))
                        .timeout(PROBE_TIMEOUT)
                        .header("Authorization", "Bearer " + apiKey)
                        .header("Accept", "application/json")
                        .GET()
                        .build(),
                HttpResponse.BodyHandlers.ofString());
        return new String[]{String.valueOf(resp.statusCode()), resp.body()};
    }

    private Map<String, Object> authFailureOrNull(String[] resp) {
        int status = Integer.parseInt(resp[0]);
        if (status == 401 || status == 403) {
            return usageFail("鉴权失败（HTTP " + status + "），请检查 API Key");
        }
        if (status < 200 || status >= 300) {
            return usageFail("HTTP " + status + "：" + truncate(resp[1]));
        }
        return null;
    }

    /** DeepSeek：GET /user/balance → balance_infos[{currency,total_balance}]。 */
    private Map<String, Object> queryDeepSeekBalance(String apiKey) throws Exception {
        String[] resp = sendAuthedGet("https://api.deepseek.com/user/balance", apiKey);
        Map<String, Object> bad = authFailureOrNull(resp);
        if (bad != null) return bad;
        JsonNode root = om.readTree(resp[1]);
        JsonNode infos = root.get("balance_infos");
        if (infos == null || !infos.isArray() || infos.isEmpty()) {
            return usageFail("响应中没有 balance_infos");
        }
        JsonNode first = infos.get(0);
        String currency = first.has("currency") ? first.get("currency").asText("") : "";
        Double total = readNumberish(first, "total_balance");
        return usageOk(total, null, total, currency, "DeepSeek 余额");
    }

    /** SiliconFlow：GET /v1/user/info → data.totalBalance。 */
    private Map<String, Object> querySiliconFlowBalance(String host, String apiKey) throws Exception {
        String[] resp = sendAuthedGet("https://" + host + "/v1/user/info", apiKey);
        Map<String, Object> bad = authFailureOrNull(resp);
        if (bad != null) return bad;
        JsonNode root = om.readTree(resp[1]);
        JsonNode data = root.get("data");
        if (data == null || !data.isObject()) return usageFail("响应中没有 data");
        Double total = readNumberish(data, "totalBalance");
        String unit = host.toLowerCase(java.util.Locale.ROOT).endsWith(".cn") ? "CNY" : "USD";
        return usageOk(total, null, total, unit, "SiliconFlow 余额");
    }

    /** OpenRouter：GET /api/v1/credits → data.{total_credits,total_usage}。 */
    private Map<String, Object> queryOpenRouterCredits(String apiKey) throws Exception {
        String[] resp = sendAuthedGet("https://openrouter.ai/api/v1/credits", apiKey);
        Map<String, Object> bad = authFailureOrNull(resp);
        if (bad != null) return bad;
        JsonNode root = om.readTree(resp[1]);
        JsonNode data = root.get("data");
        if (data == null || !data.isObject()) return usageFail("响应中没有 data");
        Double total = readNumberish(data, "total_credits");
        Double used = readNumberish(data, "total_usage");
        Double remaining = (total != null && used != null) ? total - used : null;
        return usageOk(total, used, remaining, "USD", "OpenRouter 额度");
    }

    /** Kimi For Coding：GET /coding/v1/usages → limits[].detail.{limit,remaining}。 */
    private Map<String, Object> queryKimiCodingUsage(String apiKey) throws Exception {
        String[] resp = sendAuthedGet("https://api.kimi.com/coding/v1/usages", apiKey);
        Map<String, Object> bad = authFailureOrNull(resp);
        if (bad != null) return bad;
        JsonNode root = om.readTree(resp[1]);
        JsonNode limits = root.get("limits");
        if (limits == null || !limits.isArray()) return usageFail("响应中没有 limits");
        for (JsonNode item : limits) {
            JsonNode detail = item.get("detail");
            if (detail == null) continue;
            double limit = readNumberish(detail, "limit") != null ? readNumberish(detail, "limit") : 0;
            double remaining = readNumberish(detail, "remaining") != null ? readNumberish(detail, "remaining") : 0;
            if (limit <= 0) continue;
            return usageOk(limit, Math.max(0, limit - remaining), remaining, "tokens", "Kimi Coding 5 小时窗口");
        }
        return usageFail("limits 中没有可用的限额明细");
    }

    /** 智谱：GET /api/monitor/usage/quota/limit → data.limits[] TOKENS_LIMIT percentage。 */
    private Map<String, Object> queryZhipuUsage(String host, String apiKey) throws Exception {
        String[] resp = sendAuthedGet("https://" + host + "/api/monitor/usage/quota/limit", apiKey);
        Map<String, Object> bad = authFailureOrNull(resp);
        if (bad != null) return bad;
        JsonNode root = om.readTree(resp[1]);
        JsonNode data = root.get("data");
        if (data == null || !data.isObject()) return usageFail("响应中没有 data");
        JsonNode limits = data.get("limits");
        if (limits == null || !limits.isArray()) return usageFail("响应中没有 limits");
        for (JsonNode item : limits) {
            String type = item.has("type") ? item.get("type").asText("") : "";
            if (!type.equalsIgnoreCase("TOKENS_LIMIT") && !type.equalsIgnoreCase("CREDIT_LIMIT")) continue;
            double pct = readNumberish(item, "percentage") != null ? readNumberish(item, "percentage") : 0;
            return usageOk(100.0, pct, Math.max(0, 100 - pct), "%", "智谱用量窗口");
        }
        return usageFail("limits 中没有 TOKENS_LIMIT 条目");
    }

    /** 数值宽容读取：数字或数字字符串都接。 */
    private static Double readNumberish(JsonNode obj, String name) {
        JsonNode v = obj.get(name);
        if (v == null) return null;
        if (v.isNumber()) return v.asDouble();
        if (v.isTextual()) {
            try { return Double.parseDouble(v.asText()); } catch (NumberFormatException e) { return null; }
        }
        return null;
    }

    // ── 结果构造 ─────────────────────────────────────────────

    private static Map<String, Object> modelsFail(String error) {
        Map<String, Object> m = new LinkedHashMap<>();
        m.put("success", false);
        m.put("error", error);
        return m;
    }

    private static Map<String, Object> pingFail(String error) {
        Map<String, Object> m = new LinkedHashMap<>();
        m.put("ok", false);
        m.put("error", error);
        return m;
    }

    private static Map<String, Object> usageFail(String error) {
        Map<String, Object> m = new LinkedHashMap<>();
        m.put("success", false);
        m.put("error", error);
        return m;
    }

    private static Map<String, Object> usageOk(
            Double total, Double used, Double remaining, String unit, String planName) {
        Map<String, Object> m = new LinkedHashMap<>();
        m.put("success", true);
        m.put("planName", planName);
        m.put("total", total);
        m.put("used", used);
        m.put("remaining", remaining);
        m.put("unit", unit);
        return m;
    }

    private static String truncate(String body) {
        if (body == null) return "";
        return body.length() <= ERROR_BODY_MAX ? body : body.substring(0, ERROR_BODY_MAX) + "…";
    }

    private static boolean isBlank(String s) {
        return s == null || s.trim().isEmpty();
    }

    // ── 请求 DTO ─────────────────────────────────────────────

    public record ProbeModelsRequest(
            String baseUrl, String apiKey, String apiFormat, String modelsUrl) { }
    public record ProbePingRequest(String baseUrl) { }
    public record ProbeUsageRequest(String baseUrl, String apiKey) { }
}
