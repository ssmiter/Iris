import java.io.BufferedReader;
import java.io.BufferedWriter;
import java.io.IOException;
import java.io.InputStreamReader;
import java.io.OutputStreamWriter;
import java.math.BigDecimal;
import java.net.URL;
import java.net.URLClassLoader;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.sql.Connection;
import java.sql.DatabaseMetaData;
import java.sql.Driver;
import java.sql.DriverManager;
import java.sql.PreparedStatement;
import java.sql.ResultSet;
import java.sql.ResultSetMetaData;
import java.sql.SQLException;
import java.sql.Statement;
import java.util.ArrayList;
import java.util.Base64;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.Properties;
import java.util.Set;
import java.util.concurrent.ConcurrentHashMap;
import java.util.regex.Pattern;

/**
 * /data/sql 常驻插件（docs/31 §4 + §11 M3b）：SQL 连接目录、结构观察与
 * 只读参数化查询。本目录 3 个 process 清单共享这一个进程（§3.2），
 * invoke 帧的 tool 字段决定原语。
 *
 * <p>连接配置所有权在插件：connections.json 声明连接（URL 可写，凭据只写
 * 环境变量名，从本进程环境解析）；JDBC 驱动随插件自带（lib/ 由 entry 的
 * -cp 装载，sqlite-jdbc 在内），其它方言可用连接的 driver 字段指向本机
 * jar，经 DriverShim 注册。内核不持有 URL、口令与方言知识。</p>
 *
 * <p>只读三重门：连接声明 access_mode=read_only + 打开后
 * setReadOnly(true) + 词法分析器证明只读（无法证明 = ambiguous
 * fail-close）。真正的只读兜底仍应是数据库账号本身。</p>
 */
public class Sql {

    private static final int MAX_SQL_CHARACTERS = 100_000;
    private static final int MAX_RESULT_COLUMNS = 256;
    private static final int DEFAULT_MAX_ROWS = 500;
    private static final int MAX_ROWS = 5_000;
    private static final int DEFAULT_MAX_CELL_CHARACTERS = 8_000;
    private static final int MAX_CELL_CHARACTERS = 50_000;
    private static final int DEFAULT_TIMEOUT_SECONDS = 30;
    private static final int MAX_TIMEOUT_SECONDS = 60;
    private static final int DEFAULT_MAX_OBJECTS = 100;
    private static final int MAX_OBJECTS = 500;
    private static final int DEFAULT_MAX_COLUMNS = 100;
    private static final int MAX_COLUMNS_PER_OBJECT = 256;
    private static final int MAX_RELATIONSHIPS_PER_OBJECT = 100;
    private static final Pattern CONNECTION_ID =
            Pattern.compile("[a-z][a-z0-9]*(?:[_-][a-z0-9]+)*");
    private static final Set<String> DIALECTS = Set.of(
            "sqlite", "postgresql", "mysql", "sqlserver", "generic");

    private static final Map<String, CallTask> inFlight =
            new ConcurrentHashMap<>();
    private static BufferedWriter out;
    private static Path pluginDir;
    private static ConnectionRegistry registry;

    public static void main(String[] args) throws Exception {
        BufferedReader in = new BufferedReader(new InputStreamReader(
                System.in, StandardCharsets.UTF_8));
        out = new BufferedWriter(new OutputStreamWriter(
                System.out, StandardCharsets.UTF_8));
        pluginDir = Path.of(Sql.class.getProtectionDomain()
                .getCodeSource().getLocation().toURI()).getParent();
        registry = ConnectionRegistry.load(pluginDir);
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
            Thread.ofVirtual().name("sql-" + callId).start(task);
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
            } catch (SQLException sqlFailure) {
                String state = sqlFailure.getSQLState() == null
                        ? "unknown" : sqlFailure.getSQLState();
                String detail = sqlFailure.getMessage() == null
                        ? "数据库未返回错误详情" : sqlFailure.getMessage();
                if (detail.length() > 1_000) {
                    detail = detail.substring(0, 1_000) + "…";
                }
                result.put("success", false);
                result.put("error", error(
                        "sql_engine_error",
                        "SQL 执行失败（SQLState=" + state
                                + ", vendorCode=" + sqlFailure.getErrorCode()
                                + "）：" + detail));
            } catch (Exception unexpected) {
                result.put("success", false);
                result.put("error", error(
                        "sql_plugin_internal_error",
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
                case "list_sql_connections" -> Actions.listConnections(call);
                case "inspect_sql_schema" -> Actions.inspect(call, input);
                case "query_sql" -> Actions.query(call, input);
                default -> throw new Failure(
                        "unknown_sql_primitive",
                        "未知 SQL 原语: " + tool);
            };
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
                    // 只读语句的取消失败由 Runtime deadline 继续收敛。
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
    // 原语实现：每个静态方法对应一个工具。
    // ------------------------------------------------------------------
    static final class Actions {
        private Actions() {
        }

        static Map<String, Object> listConnections(Call call)
                throws Exception {
            call.check();
            List<Object> items = new ArrayList<>();
            for (ConnectionBinding binding : registry.bindings.values()) {
                Map<String, Object> item = new LinkedHashMap<>();
                item.put("id", binding.id());
                item.put("title", binding.title());
                item.put("description", binding.description());
                item.put("dialect", binding.dialect());
                item.put("accessMode", binding.accessMode());
                items.add(item);
            }
            Map<String, Object> structured = new LinkedHashMap<>();
            structured.put("connections", items);
            structured.put("count", items.size());
            structured.put("guidance", items.isEmpty()
                    ? "当前没有配置 SQL 连接；请在插件目录的 connections.json"
                            + " 中声明连接（凭据只写环境变量名）"
                    : "把目标连接的 id 作为 query_sql.connection_id");
            return ok("共配置 " + items.size() + " 个 SQL 连接", structured);
        }

        static Map<String, Object> inspect(Call call, Map<?, ?> input)
                throws Exception {
            String connectionId = requiredText(input, "connection_id", 128);
            ConnectionBinding binding = registry.requireReadOnly(connectionId);
            String catalog = optionalText(input, "catalog", 256);
            String schemaPattern = optionalText(input, "schema_pattern", 256);
            String objectPattern = optionalText(input, "object_pattern", 256);
            if (objectPattern == null) {
                objectPattern = "%";
            }
            boolean includeViews = boolAt(castMap(input), "include_views",
                    true);
            boolean includeColumns = boolAt(castMap(input), "include_columns",
                    true);
            boolean includeKeys = boolAt(castMap(input), "include_keys",
                    true);
            int maxObjects = bounded(intAt(input, "max_objects",
                    DEFAULT_MAX_OBJECTS), 1, MAX_OBJECTS, "max_objects");
            int maxColumns = bounded(intAt(input, "max_columns_per_object",
                    DEFAULT_MAX_COLUMNS), 1, MAX_COLUMNS_PER_OBJECT,
                    "max_columns_per_object");

            Map<String, Object> inspection;
            try (Connection connection = binding.open()) {
                inspection = SchemaInspector.inspect(call, connection,
                        catalog, schemaPattern, objectPattern,
                        includeViews, includeColumns, includeKeys,
                        maxObjects, maxColumns);
            }
            Map<String, Object> structured = new LinkedHashMap<>();
            structured.put("connectionId", connectionId);
            structured.put("catalog", inspection.get("catalog"));
            structured.put("schemaPattern", inspection.get("schemaPattern"));
            structured.put("objectPattern", inspection.get("objectPattern"));
            structured.put("objects", inspection.get("objects"));
            int objectCount = inspection.get("objects") instanceof List<?> list
                    ? list.size() : 0;
            structured.put("objectCount", objectCount);
            structured.put("truncated", inspection.get("truncated"));
            structured.put("guidance", Boolean.TRUE.equals(
                    inspection.get("truncated"))
                    ? "对象数达到预算；请用更精确的 object_pattern 收窄，"
                            + "不要把当前窗口当作全集"
                    : "结构观察已完整返回");
            return ok("连接 " + connectionId + " 返回 " + objectCount
                    + " 个结构化对象", structured);
        }

        static Map<String, Object> query(Call call, Map<?, ?> input)
                throws Exception {
            String connectionId = requiredText(input, "connection_id", 128);
            String sql = requiredText(input, "sql", MAX_SQL_CHARACTERS + 1);
            ConnectionBinding binding = registry.requireReadOnly(connectionId);
            Analysis analysis = Analyzer.analyze(sql, binding.dialect());
            requireRead(analysis);
            List<Object> parameters = normalizeParameters(
                    input.get("parameters"));
            int maxRows = bounded(intAt(input, "max_rows", DEFAULT_MAX_ROWS),
                    1, MAX_ROWS, "max_rows");
            int maxCellCharacters = bounded(intAt(input,
                    "max_cell_characters", DEFAULT_MAX_CELL_CHARACTERS),
                    1, MAX_CELL_CHARACTERS, "max_cell_characters");
            int timeoutSeconds = bounded(intAt(input, "timeout_seconds",
                    DEFAULT_TIMEOUT_SECONDS), 1, MAX_TIMEOUT_SECONDS,
                    "timeout_seconds");

            Map<String, Object> result;
            try (Connection connection = binding.open();
                 PreparedStatement statement =
                         connection.prepareStatement(sql)) {
                call.track(statement);
                try {
                    result = QueryExecutor.execute(call, statement,
                            parameters, maxRows, maxCellCharacters,
                            timeoutSeconds);
                } finally {
                    call.untrack(statement);
                }
            }
            Map<String, Object> structured = new LinkedHashMap<>();
            structured.put("connectionId", connectionId);
            structured.put("dialect", binding.dialect());
            Map<String, Object> analysisNode = new LinkedHashMap<>();
            analysisNode.put("operation", analysis.operation());
            analysisNode.put("reason", analysis.reason());
            analysisNode.put("resources", analysis.resources());
            structured.put("analysis", analysisNode);
            structured.put("columns", result.get("columns"));
            structured.put("rows", result.get("rows"));
            int rowCount = result.get("rows") instanceof List<?> rows
                    ? rows.size() : 0;
            structured.put("rowCount", rowCount);
            structured.put("truncated", result.get("truncated"));
            structured.put("durationMs", result.get("durationMs"));
            structured.put("guidance", Boolean.TRUE.equals(
                    result.get("truncated"))
                    ? "结果达到行数预算；请增加更精确的 WHERE、聚合或 LIMIT，"
                            + "不要把当前窗口当作全集"
                    : "查询结果已完整返回");
            return ok("只读连接 " + connectionId + " 返回 " + rowCount + " 行",
                    structured);
        }

        private static Map<String, Object> ok(
                String data, Map<String, Object> structured) {
            Map<String, Object> result = new LinkedHashMap<>();
            result.put("success", true);
            result.put("data", data);
            result.put("structuredData", structured);
            return result;
        }

        private static void requireRead(Analysis analysis) throws Failure {
            if (analysis.kind() == Kind.WRITE) {
                throw new Failure(
                        "sql_write_not_allowed",
                        "query_sql 只允许读取；分析到的操作 "
                                + analysis.operation() + " 可能改变数据库状态");
            }
            if (analysis.kind() != Kind.READ) {
                throw new Failure(
                        "sql_read_not_proven",
                        "当前分析器无法证明 SQL 只读：" + analysis.reason());
            }
        }

        private static List<Object> normalizeParameters(Object source)
                throws Failure {
            List<Object> normalized = new ArrayList<>();
            if (source == null) {
                return normalized;
            }
            if (!(source instanceof List<?> list)) {
                throw new Failure(
                        "invalid_sql_parameters",
                        "parameters 必须是与 ? 占位符顺序一致的数组");
            }
            for (int index = 0; index < list.size(); index++) {
                Object value = list.get(index);
                if (value == null || value instanceof String
                        || value instanceof Number
                        || value instanceof Boolean) {
                    normalized.add(value);
                    continue;
                }
                throw new Failure(
                        "invalid_sql_parameter",
                        "parameters[" + index
                                + "] 只能是字符串、数字、布尔值或 null");
            }
            return normalized;
        }
    }

    // ------------------------------------------------------------------
    // 连接注册表（插件自有 connections.json；凭据只存环境变量名）
    // ------------------------------------------------------------------
    static final class ConnectionRegistry {
        final Map<String, ConnectionBinding> bindings;

        private ConnectionRegistry(Map<String, ConnectionBinding> bindings) {
            this.bindings = bindings;
        }

        static ConnectionRegistry load(Path dir) throws Failure {
            Path file = dir.resolve("connections.json");
            Object parsed;
            try {
                parsed = Json.parse(Files.readString(
                        file, StandardCharsets.UTF_8));
            } catch (IOException | RuntimeException readFailure) {
                throw new Failure("sql_connections_config_invalid",
                        "connections.json 不可读或不是合法 JSON: "
                                + readFailure.getMessage());
            }
            if (!(parsed instanceof Map<?, ?> root)) {
                throw new Failure("sql_connections_config_invalid",
                        "connections.json 顶层必须是 object");
            }
            Map<String, ConnectionBinding> accepted = new LinkedHashMap<>();
            Object connections = root.get("connections");
            if (connections instanceof List<?> list) {
                for (Object element : list) {
                    if (!(element instanceof Map<?, ?> entry)) {
                        continue;
                    }
                    ConnectionBinding binding = binding(entry);
                    if (accepted.putIfAbsent(binding.id(), binding) != null) {
                        throw new Failure("sql_connections_config_invalid",
                                "SQL 连接 id 冲突: " + binding.id());
                    }
                }
            }
            return new ConnectionRegistry(Map.copyOf(accepted));
        }

        private static ConnectionBinding binding(Map<?, ?> entry)
                throws Failure {
            String id = text(entry, "id");
            String title = text(entry, "title");
            String description = text(entry, "description");
            String url = text(entry, "url");
            String dialect = text(entry, "dialect");
            String accessMode = text(entry, "access_mode");
            if (dialect == null) {
                dialect = "generic";
            }
            if (accessMode == null) {
                accessMode = "read_only";
            }
            if (id == null || !CONNECTION_ID.matcher(id).matches()
                    || title == null || description == null
                    || url == null
                    || !DIALECTS.contains(dialect.toLowerCase(Locale.ROOT))
                    || !("read_only".equals(accessMode)
                            || "read_write".equals(accessMode))) {
                throw new Failure("sql_connections_config_invalid",
                        "连接定义不完整或方言/读写能力非法: " + id);
            }
            Map<String, String> properties = new LinkedHashMap<>();
            if (entry.get("properties") instanceof Map<?, ?> map) {
                for (Map.Entry<?, ?> property : map.entrySet()) {
                    properties.put(String.valueOf(property.getKey()),
                            String.valueOf(property.getValue()));
                }
            }
            return new ConnectionBinding(
                    id,
                    title,
                    description,
                    dialect.toLowerCase(Locale.ROOT),
                    accessMode,
                    url,
                    text(entry, "username_env"),
                    text(entry, "password_env"),
                    text(entry, "driver"),
                    properties
            );
        }

        ConnectionBinding requireReadOnly(String connectionId)
                throws Failure {
            ConnectionBinding binding = bindings.get(connectionId);
            if (binding == null) {
                throw new Failure(
                        "sql_connection_not_found",
                        "找不到 SQL 连接 " + connectionId
                                + "；先调用 list_sql_connections 查看可用对象");
            }
            if (!"read_only".equals(binding.accessMode())) {
                throw new Failure(
                        "sql_connection_not_read_only",
                        "连接 " + connectionId
                                + " 未声明为 read_only，只读 SQL 能力拒绝使用");
            }
            return binding;
        }

        private static String text(Map<?, ?> map, String field) {
            return map.get(field) instanceof String value
                    && !value.isBlank() ? value.trim() : null;
        }
    }

    /** 一个声明式连接；open() 负责凭据解析、驱动装载与只读会话策略。 */
    record ConnectionBinding(
            String id,
            String title,
            String description,
            String dialect,
            String accessMode,
            String url,
            String usernameEnv,
            String passwordEnv,
            String driver,
            Map<String, String> properties
    ) {
        private static final Map<String, Driver> LOADED_DRIVERS =
                new ConcurrentHashMap<>();

        Connection open() throws Failure, SQLException {
            loadDriver();
            Properties jdbcProperties = new Properties();
            jdbcProperties.putAll(properties);
            if (usernameEnv != null) {
                String username = System.getenv(usernameEnv);
                if (username == null || username.isBlank()) {
                    throw new Failure("sql_credential_env_missing",
                            "连接 " + id + " 声明的环境变量 " + usernameEnv
                                    + " 不存在或为空");
                }
                jdbcProperties.setProperty("user", username);
            }
            if (passwordEnv != null) {
                String password = System.getenv(passwordEnv);
                if (password == null) {
                    throw new Failure("sql_credential_env_missing",
                            "连接 " + id + " 声明的环境变量 " + passwordEnv
                                    + " 不存在");
                }
                jdbcProperties.setProperty("password", password);
            }
            Connection connection;
            if ("read_only".equals(accessMode) && "sqlite".equals(dialect)) {
                // sqlite-jdbc 拒绝连接建立后再改 read-only；只读必须在
                // 打开时经 open_mode=1（READONLY）兑现。
                jdbcProperties.setProperty("open_mode", "1");
                connection = DriverManager.getConnection(url, jdbcProperties);
            } else {
                connection = DriverManager.getConnection(url, jdbcProperties);
                if ("read_only".equals(accessMode)) {
                    connection.setReadOnly(true);
                }
            }
            return connection;
        }

        /** lib/* 已在 classpath 的驱动由 ServiceLoader 自注册；driver
         *  字段指向的额外 jar 经独立 classloader + shim 注册。 */
        private void loadDriver() throws Failure {
            if (driver == null) {
                return;
            }
            Driver loaded = LOADED_DRIVERS.computeIfAbsent(driver,
                    ConnectionBinding::loadDriverJar);
            if (loaded == null) {
                throw new Failure("sql_driver_unavailable",
                        "连接 " + id + " 的 JDBC 驱动不可装载: " + driver
                                + "；请确认 jar 存在于该路径且含 JDBC 4 服务声明");
            }
        }

        private static Driver loadDriverJar(String path) {
            try {
                Path jar = Path.of(path).isAbsolute()
                        ? Path.of(path) : pluginDir.resolve(path);
                if (!Files.isRegularFile(jar)) {
                    return null;
                }
                URLClassLoader loader = new URLClassLoader(
                        new URL[]{jar.toUri().toURL()},
                        Sql.class.getClassLoader());
                java.util.Iterator<Driver> drivers =
                        java.util.ServiceLoader.load(Driver.class, loader)
                                .iterator();
                if (!drivers.hasNext()) {
                    return null;
                }
                Driver candidate = drivers.next();
                DriverManager.registerDriver(new DriverShim(candidate));
                return candidate;
            } catch (Exception failure) {
                return null;
            }
        }
    }

    /** JDBC 只认 system classloader 注册；shim 把外部 jar 的驱动桥接进来。 */
    private record DriverShim(Driver delegate) implements Driver {
        @Override
        public Connection connect(String url, Properties info)
                throws SQLException {
            return delegate.connect(url, info);
        }

        @Override
        public boolean acceptsURL(String url) throws SQLException {
            return delegate.acceptsURL(url);
        }

        @Override
        public java.sql.DriverPropertyInfo[] getPropertyInfo(
                String url, Properties info) throws SQLException {
            return delegate.getPropertyInfo(url, info);
        }

        @Override
        public int getMajorVersion() {
            return delegate.getMajorVersion();
        }

        @Override
        public int getMinorVersion() {
            return delegate.getMinorVersion();
        }

        @Override
        public boolean jdbcCompliant() {
            return delegate.jdbcCompliant();
        }

        @Override
        public java.util.logging.Logger getParentLogger() {
            return java.util.logging.Logger.getGlobal();
        }
    }

    // ------------------------------------------------------------------
    // 只读查询执行：JDBC adapter，行/列/单元格全部有硬预算。
    // ------------------------------------------------------------------
    static final class QueryExecutor {
        private QueryExecutor() {
        }

        static Map<String, Object> execute(
                Call call,
                PreparedStatement statement,
                List<Object> parameters,
                int maxRows,
                int maxCellCharacters,
                int timeoutSeconds
        ) throws Failure, SQLException, Cancelled {
            long started = System.nanoTime();
            statement.setQueryTimeout(timeoutSeconds);
            statement.setMaxRows(maxRows + 1);
            bind(statement, parameters);
            try (ResultSet resultSet = statement.executeQuery()) {
                ResultSetMetaData metadata = resultSet.getMetaData();
                int columnCount = metadata.getColumnCount();
                if (columnCount > MAX_RESULT_COLUMNS) {
                    throw new Failure(
                            "sql_too_many_columns",
                            "查询返回 " + columnCount
                                    + " 列，超过单次查询上限 "
                                    + MAX_RESULT_COLUMNS);
                }
                List<Object> columns = new ArrayList<>();
                for (int index = 1; index <= columnCount; index++) {
                    Map<String, Object> column = new LinkedHashMap<>();
                    column.put("index", index);
                    column.put("label", metadata.getColumnLabel(index));
                    column.put("jdbcType", metadata.getColumnType(index));
                    column.put("typeName",
                            metadata.getColumnTypeName(index));
                    column.put("nullable", metadata.isNullable(index));
                    columns.add(column);
                }
                List<Object> rows = new ArrayList<>();
                boolean truncated = false;
                while (resultSet.next()) {
                    call.check();
                    if (rows.size() >= maxRows) {
                        truncated = true;
                        break;
                    }
                    List<Object> row = new ArrayList<>();
                    for (int index = 1; index <= columnCount; index++) {
                        row.add(readCell(resultSet, index,
                                maxCellCharacters));
                    }
                    rows.add(row);
                }
                Map<String, Object> result = new LinkedHashMap<>();
                result.put("columns", columns);
                result.put("rows", rows);
                result.put("truncated", truncated);
                result.put("durationMs",
                        (System.nanoTime() - started) / 1_000_000);
                return result;
            }
        }

        private static Object readCell(
                ResultSet resultSet, int index, int maxCharacters
        ) throws SQLException {
            Object value = resultSet.getObject(index);
            if (value == null || value instanceof Boolean
                    || value instanceof Number) {
                return value;
            }
            if (value instanceof byte[] bytes) {
                int maximumBytes = Math.max(1, maxCharacters * 3 / 4);
                int returnedBytes = Math.min(bytes.length, maximumBytes);
                Map<String, Object> projected = new LinkedHashMap<>();
                projected.put("kind", "binary");
                projected.put("sizeBytes", bytes.length);
                projected.put("base64", Base64.getEncoder().encodeToString(
                        java.util.Arrays.copyOf(bytes, returnedBytes)));
                projected.put("truncated", returnedBytes < bytes.length);
                return projected;
            }
            if (value instanceof java.sql.Blob blob) {
                Map<String, Object> projected = new LinkedHashMap<>();
                projected.put("kind", "blob");
                projected.put("sizeBytes", blob.length());
                projected.put("guidance",
                        "二进制大对象未内联；请使用面向该应用对象的专用能力读取");
                return projected;
            }
            if (value instanceof java.sql.Clob clob) {
                long length = clob.length();
                int count = (int) Math.min(length, maxCharacters);
                String text = count == 0
                        ? "" : clob.getSubString(1, count);
                return boundedText(text, length, maxCharacters);
            }
            if (value instanceof java.sql.SQLXML) {
                Map<String, Object> projected = new LinkedHashMap<>();
                projected.put("kind", "sqlxml");
                projected.put("guidance",
                        "SQLXML 未内联；请在 SQL 中选择所需的文本片段");
                return projected;
            }
            return boundedText(value.toString(), null, maxCharacters);
        }

        private static Object boundedText(
                String value, Long knownLength, int maxCharacters) {
            long length = knownLength == null
                    ? value.length() : knownLength;
            if (length <= maxCharacters && value.length() <= maxCharacters) {
                return value;
            }
            Map<String, Object> projected = new LinkedHashMap<>();
            projected.put("value", value.substring(
                    0, Math.min(value.length(), maxCharacters)));
            projected.put("truncated", true);
            projected.put("originalCharacters", length);
            return projected;
        }

        /** JSON 帧里的数字按 double 承载；整数值在 2^53 内回 long，
         *  更大或带小数的按 BigDecimal 绑定。超大精确整数请用字符串传。 */
        private static void bind(
                PreparedStatement statement, List<Object> parameters
        ) throws SQLException {
            for (int index = 0; index < parameters.size(); index++) {
                Object value = parameters.get(index);
                int jdbcIndex = index + 1;
                if (value == null) {
                    statement.setObject(jdbcIndex, null);
                } else if (value instanceof Boolean bool) {
                    statement.setBoolean(jdbcIndex, bool);
                } else if (value instanceof Number number) {
                    double asDouble = number.doubleValue();
                    if (asDouble == Math.rint(asDouble)
                            && Math.abs(asDouble) < 9.0e15) {
                        statement.setLong(jdbcIndex, (long) asDouble);
                    } else {
                        statement.setBigDecimal(jdbcIndex,
                                BigDecimal.valueOf(asDouble));
                    }
                } else {
                    statement.setString(jdbcIndex, value.toString());
                }
            }
        }
    }

    // ------------------------------------------------------------------
    // 结构观察：JDBC metadata → 有界结构化对象投影。
    // ------------------------------------------------------------------
    static final class SchemaInspector {
        private SchemaInspector() {
        }

        static Map<String, Object> inspect(
                Call call,
                Connection connection,
                String catalog,
                String schemaPattern,
                String objectPattern,
                boolean includeViews,
                boolean includeColumns,
                boolean includeKeys,
                int maxObjects,
                int maxColumnsPerObject
        ) throws SQLException, Cancelled {
            DatabaseMetaData metadata = connection.getMetaData();
            String effectiveCatalog = catalog == null
                    ? connection.getCatalog() : catalog;
            List<Object> objects = new ArrayList<>();
            boolean truncated = false;
            try (ResultSet tables = metadata.getTables(
                    effectiveCatalog,
                    schemaPattern,
                    objectPattern,
                    includeViews
                            ? new String[]{"TABLE", "VIEW"}
                            : new String[]{"TABLE"})) {
                while (tables.next()) {
                    call.check();
                    if (objects.size() >= maxObjects) {
                        truncated = true;
                        break;
                    }
                    String objectCatalog = tables.getString("TABLE_CAT");
                    String objectSchema = tables.getString("TABLE_SCHEM");
                    String objectName = tables.getString("TABLE_NAME");
                    Map<String, Object> object = new LinkedHashMap<>();
                    object.put("catalog", objectCatalog);
                    object.put("schema", objectSchema);
                    object.put("name", objectName);
                    object.put("type", lower(tables.getString("TABLE_TYPE")));
                    object.put("remarks", bounded(
                            tables.getString("REMARKS"), 1_000));
                    object.put("identity", identity(
                            objectCatalog, objectSchema, objectName));
                    if (includeColumns) {
                        projectColumns(call, metadata, object,
                                objectCatalog, objectSchema, objectName,
                                maxColumnsPerObject);
                    }
                    if (includeKeys) {
                        projectKeys(call, metadata, object,
                                objectCatalog, objectSchema, objectName);
                    }
                    objects.add(object);
                }
            }
            Map<String, Object> inspection = new LinkedHashMap<>();
            inspection.put("catalog", effectiveCatalog);
            inspection.put("schemaPattern", schemaPattern);
            inspection.put("objectPattern", objectPattern);
            inspection.put("objects", objects);
            inspection.put("truncated", truncated);
            return inspection;
        }

        private static void projectColumns(
                Call call,
                DatabaseMetaData metadata,
                Map<String, Object> object,
                String catalog,
                String schema,
                String name,
                int maximum
        ) throws SQLException, Cancelled {
            List<Object> columns = new ArrayList<>();
            boolean truncated = false;
            try (ResultSet result = metadata.getColumns(
                    catalog, schema, name, "%")) {
                while (result.next()) {
                    call.check();
                    if (columns.size() >= maximum) {
                        truncated = true;
                        break;
                    }
                    Map<String, Object> column = new LinkedHashMap<>();
                    column.put("name", result.getString("COLUMN_NAME"));
                    column.put("ordinal",
                            result.getInt("ORDINAL_POSITION"));
                    column.put("jdbcType", result.getInt("DATA_TYPE"));
                    column.put("typeName", result.getString("TYPE_NAME"));
                    column.put("nullable", result.getInt("NULLABLE"));
                    column.put("size", nullableInteger(result, "COLUMN_SIZE"));
                    column.put("decimalDigits",
                            nullableInteger(result, "DECIMAL_DIGITS"));
                    column.put("defaultValue",
                            bounded(result.getString("COLUMN_DEF"), 1_000));
                    columns.add(column);
                }
            }
            object.put("columns", columns);
            object.put("columnsTruncated", truncated);
        }

        private static void projectKeys(
                Call call,
                DatabaseMetaData metadata,
                Map<String, Object> object,
                String catalog,
                String schema,
                String name
        ) throws SQLException, Cancelled {
            List<Object> primaryKey = new ArrayList<>();
            try (ResultSet result = metadata.getPrimaryKeys(
                    catalog, schema, name)) {
                while (result.next()) {
                    call.check();
                    Map<String, Object> item = new LinkedHashMap<>();
                    item.put("column", result.getString("COLUMN_NAME"));
                    item.put("sequence", result.getInt("KEY_SEQ"));
                    item.put("name", result.getString("PK_NAME"));
                    primaryKey.add(item);
                }
            }
            List<Object> foreignKeys = new ArrayList<>();
            boolean truncated = false;
            try (ResultSet result = metadata.getImportedKeys(
                    catalog, schema, name)) {
                while (result.next()) {
                    call.check();
                    if (foreignKeys.size() >= MAX_RELATIONSHIPS_PER_OBJECT) {
                        truncated = true;
                        break;
                    }
                    Map<String, Object> item = new LinkedHashMap<>();
                    item.put("name", result.getString("FK_NAME"));
                    item.put("column", result.getString("FKCOLUMN_NAME"));
                    item.put("referencedObject", identity(
                            result.getString("PKTABLE_CAT"),
                            result.getString("PKTABLE_SCHEM"),
                            result.getString("PKTABLE_NAME")));
                    item.put("referencedColumn",
                            result.getString("PKCOLUMN_NAME"));
                    item.put("sequence", result.getInt("KEY_SEQ"));
                    foreignKeys.add(item);
                }
            }
            object.put("primaryKey", primaryKey);
            object.put("foreignKeys", foreignKeys);
            object.put("foreignKeysTruncated", truncated);
        }

        private static String identity(
                String catalog, String schema, String name) {
            StringBuilder identity = new StringBuilder();
            if (catalog != null && !catalog.isBlank()) {
                identity.append(catalog).append('.');
            }
            if (schema != null && !schema.isBlank()) {
                identity.append(schema).append('.');
            }
            return identity.append(name).toString();
        }

        private static String lower(String value) {
            return value == null
                    ? "unknown" : value.toLowerCase(Locale.ROOT);
        }

        private static String bounded(String value, int maximum) {
            if (value == null) {
                return null;
            }
            return value.length() <= maximum
                    ? value : value.substring(0, maximum) + "…";
        }

        private static Integer nullableInteger(
                ResultSet result, String column) throws SQLException {
            int value = result.getInt(column);
            return result.wasNull() ? null : value;
        }
    }

    // ------------------------------------------------------------------
    // 保守词法分析器：不执行 SQL；无法证明只读时返回 AMBIGUOUS。
    // ------------------------------------------------------------------
    enum Kind {
        READ, WRITE, AMBIGUOUS
    }

    record Analysis(
            Kind kind,
            String operation,
            List<String> resources,
            String reason
    ) {
        Analysis {
            resources = List.copyOf(resources);
        }
    }

    static final class Analyzer {

        private static final Set<String> READ_OPERATIONS = Set.of(
                "SELECT", "VALUES", "SHOW", "DESCRIBE", "DESC");
        private static final Set<String> WRITE_OPERATIONS = Set.of(
                "INSERT", "UPDATE", "DELETE", "MERGE", "REPLACE",
                "CREATE", "ALTER", "DROP", "TRUNCATE", "RENAME",
                "GRANT", "REVOKE", "CALL", "EXEC", "EXECUTE",
                "VACUUM", "ANALYZE", "ATTACH", "DETACH",
                "BEGIN", "COMMIT", "ROLLBACK", "SAVEPOINT", "RELEASE");
        private static final Set<String> RESOURCE_PREFIXES = Set.of(
                "FROM", "JOIN", "INTO", "UPDATE", "TABLE");
        private static final Set<String> READ_ONLY_SQLITE_PRAGMAS = Set.of(
                "TABLE_INFO", "TABLE_XINFO", "INDEX_INFO", "INDEX_XINFO",
                "INDEX_LIST", "FOREIGN_KEY_LIST", "DATABASE_LIST",
                "COLLATION_LIST", "COMPILE_OPTIONS", "FUNCTION_LIST",
                "MODULE_LIST", "PRAGMA_LIST");

        private Analyzer() {
        }

        static Analysis analyze(String sql, String dialect) throws Failure {
            if (sql == null || sql.isBlank()) {
                throw new Failure("sql_empty", "SQL 不能为空");
            }
            if (sql.length() > MAX_SQL_CHARACTERS) {
                throw new Failure("sql_too_large",
                        "SQL 文本不能超过 10 万字符");
            }
            List<Token> tokens = new Lexer(sql).scan();
            List<Token> statement = requireSingleStatement(tokens);
            if (statement.isEmpty()) {
                throw new Failure("sql_empty", "SQL 不包含可执行语句");
            }
            Operation operation = operation(statement, dialect);
            return new Analysis(
                    operation.kind(),
                    operation.label(),
                    resources(statement),
                    operation.reason()
            );
        }

        private static List<Token> requireSingleStatement(
                List<Token> tokens) throws Failure {
            int semicolon = -1;
            for (int index = 0; index < tokens.size(); index++) {
                Token token = tokens.get(index);
                if (token.depth() == 0 && token.symbol(";")) {
                    if (semicolon >= 0) {
                        throw multipleStatements();
                    }
                    semicolon = index;
                }
            }
            if (semicolon < 0) {
                return tokens;
            }
            if (semicolon != tokens.size() - 1) {
                throw multipleStatements();
            }
            return List.copyOf(tokens.subList(0, semicolon));
        }

        private static Failure multipleStatements() {
            return new Failure(
                    "sql_multiple_statements",
                    "一次只能执行一条 SQL 语句");
        }

        private static Operation operation(
                List<Token> tokens, String dialect) {
            int first = firstTopLevelWord(tokens, 0);
            if (first < 0) {
                return ambiguous("unknown", "无法识别 SQL 的首个操作");
            }
            String keyword = tokens.get(first).upper();
            if ("WITH".equals(keyword)) {
                int main = firstOperation(tokens, first + 1);
                if (main < 0) {
                    return ambiguous("with", "WITH 语句缺少可识别的主操作");
                }
                Operation cteWrite = writeInsideCte(tokens, first + 1, main);
                if (cteWrite != null) {
                    return cteWrite;
                }
                return classifyKeyword(
                        tokens, main, tokens.get(main).upper(), dialect);
            }
            if ("EXPLAIN".equals(keyword)) {
                if (containsTopLevelWord(tokens, first + 1, "ANALYZE")) {
                    return ambiguous(
                            "explain_analyze",
                            "EXPLAIN ANALYZE 可能实际执行被分析语句");
                }
                int explained = firstOperation(tokens, first + 1);
                if (explained < 0) {
                    return ambiguous(
                            "explain",
                            "EXPLAIN 后缺少可识别的只读语句");
                }
                Operation nested = classifyKeyword(
                        tokens, explained, tokens.get(explained).upper(),
                        dialect);
                if (nested.kind() != Kind.READ) {
                    return nested;
                }
                return new Operation(
                        Kind.READ,
                        "explain",
                        "EXPLAIN 的目标语句已被确认只读");
            }
            return classifyKeyword(tokens, first, keyword, dialect);
        }

        private static Operation classifyKeyword(
                List<Token> tokens, int index, String keyword, String dialect
        ) {
            if ("PRAGMA".equals(keyword)) {
                return classifyPragma(tokens, index, dialect);
            }
            if ("SELECT".equals(keyword)) {
                return classifySelect(tokens, index);
            }
            if (READ_OPERATIONS.contains(keyword)) {
                return new Operation(
                        Kind.READ,
                        keyword.toLowerCase(Locale.ROOT),
                        "操作已被词法分析器确认为只读");
            }
            if (WRITE_OPERATIONS.contains(keyword)) {
                return new Operation(
                        Kind.WRITE,
                        keyword.toLowerCase(Locale.ROOT),
                        "操作可能改变数据库或事务状态");
            }
            return ambiguous(
                    keyword.toLowerCase(Locale.ROOT),
                    "当前分析器无法证明该操作只读");
        }

        private static Operation classifySelect(
                List<Token> tokens, int selectIndex) {
            if (containsTopLevelWord(tokens, selectIndex + 1, "INTO")) {
                return new Operation(
                        Kind.WRITE,
                        "select_into",
                        "SELECT INTO 可能创建表或写入文件");
            }
            for (int index = selectIndex + 1;
                    index + 1 < tokens.size();
                    index++) {
                Token first = tokens.get(index);
                Token second = tokens.get(index + 1);
                if (first.depth() == 0
                        && second.depth() == 0
                        && first.type() == TokenType.WORD
                        && second.type() == TokenType.WORD
                        && "FOR".equals(first.upper())
                        && ("UPDATE".equals(second.upper())
                        || "SHARE".equals(second.upper()))) {
                    return ambiguous(
                            "locking_select",
                            "锁定式 SELECT 会改变数据库会话中的锁状态");
                }
            }
            return new Operation(
                    Kind.READ,
                    "select",
                    "SELECT 已排除已知写入和锁定结构");
        }

        private static Operation writeInsideCte(
                List<Token> tokens, int start, int mainOperation) {
            for (int index = start; index < mainOperation; index++) {
                Token token = tokens.get(index);
                if (token.type() == TokenType.WORD
                        && WRITE_OPERATIONS.contains(token.upper())) {
                    return new Operation(
                            Kind.WRITE,
                            "write_cte",
                            "WITH 子句包含可能改变数据库状态的 "
                                    + token.upper());
                }
            }
            return null;
        }

        private static boolean containsTopLevelWord(
                List<Token> tokens, int start, String word) {
            for (int index = start; index < tokens.size(); index++) {
                Token token = tokens.get(index);
                if (token.depth() == 0
                        && token.type() == TokenType.WORD
                        && word.equals(token.upper())) {
                    return true;
                }
            }
            return false;
        }

        private static Operation classifyPragma(
                List<Token> tokens, int pragmaIndex, String dialect) {
            if (!"sqlite".equals(dialect)) {
                return ambiguous(
                        "pragma",
                        "PRAGMA 只在声明为 SQLite 的连接上允许分析");
            }
            Token name = nextName(tokens, pragmaIndex + 1);
            if (name == null
                    || !READ_ONLY_SQLITE_PRAGMAS.contains(name.upper())) {
                return ambiguous(
                        "pragma",
                        "该 PRAGMA 不在只读 allowlist 中");
            }
            for (int index = pragmaIndex + 1; index < tokens.size(); index++) {
                if (tokens.get(index).symbol("=")) {
                    return new Operation(
                            Kind.WRITE,
                            "pragma_assignment",
                            "带赋值的 PRAGMA 可能改变连接或数据库状态");
                }
            }
            return new Operation(
                    Kind.READ,
                    "pragma_" + name.upper().toLowerCase(Locale.ROOT),
                    "该 PRAGMA 位于 SQLite 只读 allowlist");
        }

        private static int firstOperation(List<Token> tokens, int start) {
            for (int index = start; index < tokens.size(); index++) {
                Token token = tokens.get(index);
                if (token.depth() != 0 || token.type() != TokenType.WORD) {
                    continue;
                }
                String word = token.upper();
                if (READ_OPERATIONS.contains(word)
                        || WRITE_OPERATIONS.contains(word)
                        || "PRAGMA".equals(word)
                        || "EXPLAIN".equals(word)) {
                    return index;
                }
            }
            return -1;
        }

        private static int firstTopLevelWord(List<Token> tokens, int start) {
            for (int index = start; index < tokens.size(); index++) {
                Token token = tokens.get(index);
                if (token.depth() == 0 && token.type() == TokenType.WORD) {
                    return index;
                }
            }
            return -1;
        }

        private static List<String> resources(List<Token> tokens) {
            Map<String, String> resources = new LinkedHashMap<>();
            for (int index = 0; index < tokens.size(); index++) {
                Token token = tokens.get(index);
                if (token.type() != TokenType.WORD
                        || !RESOURCE_PREFIXES.contains(token.upper())) {
                    continue;
                }
                String resource = readResource(tokens, index + 1);
                if (resource == null || resource.isBlank()) {
                    continue;
                }
                resources.putIfAbsent(
                        resource.toLowerCase(Locale.ROOT), resource);
            }
            return List.copyOf(resources.values());
        }

        private static String readResource(List<Token> tokens, int start) {
            StringBuilder name = new StringBuilder();
            int expectedDepth = start < tokens.size()
                    ? tokens.get(start).depth() : 0;
            for (int index = start; index < tokens.size(); index++) {
                Token token = tokens.get(index);
                if (token.depth() != expectedDepth) {
                    break;
                }
                if (token.symbol("(")) {
                    return null;
                }
                if (token.type() == TokenType.WORD
                        || token.type() == TokenType.IDENTIFIER) {
                    name.append(token.text());
                    continue;
                }
                if (token.symbol(".") && !name.isEmpty()) {
                    name.append('.');
                    continue;
                }
                break;
            }
            return name.isEmpty() ? null : name.toString();
        }

        private static Token nextName(List<Token> tokens, int start) {
            for (int index = start; index < tokens.size(); index++) {
                Token token = tokens.get(index);
                if (token.type() == TokenType.WORD
                        || token.type() == TokenType.IDENTIFIER) {
                    return token;
                }
                if (!token.symbol(".")) {
                    return null;
                }
            }
            return null;
        }

        private static Operation ambiguous(String label, String reason) {
            return new Operation(Kind.AMBIGUOUS, label, reason);
        }

        private record Operation(Kind kind, String label, String reason) {
        }

        private enum TokenType {
            WORD, IDENTIFIER, LITERAL, SYMBOL, NUMBER, PARAMETER
        }

        private record Token(
                TokenType type, String text, int depth, int position) {
            private String upper() {
                return text.toUpperCase(Locale.ROOT);
            }

            private boolean symbol(String value) {
                return type == TokenType.SYMBOL && text.equals(value);
            }
        }

        private static final class Lexer {

            private final String sql;
            private final List<Token> tokens = new ArrayList<>();
            private int position;
            private int depth;

            private Lexer(String sql) {
                this.sql = sql;
            }

            private List<Token> scan() throws Failure {
                while (position < sql.length()) {
                    char current = sql.charAt(position);
                    if (Character.isWhitespace(current)) {
                        position++;
                    } else if (current == '\'') {
                        quoted('\'', TokenType.LITERAL);
                    } else if (current == '"') {
                        quoted('"', TokenType.IDENTIFIER);
                    } else if (current == '`') {
                        quoted('`', TokenType.IDENTIFIER);
                    } else if (current == '[') {
                        bracketIdentifier();
                    } else if (current == '-' && peek(1) == '-') {
                        lineComment();
                    } else if (current == '/' && peek(1) == '*') {
                        blockComment();
                    } else if (current == '(') {
                        tokens.add(new Token(
                                TokenType.SYMBOL, "(", depth, position++));
                        depth++;
                    } else if (current == ')') {
                        if (depth == 0) {
                            throw invalid("多余的右括号", position);
                        }
                        depth--;
                        tokens.add(new Token(
                                TokenType.SYMBOL, ")", depth, position++));
                    } else if (isWordStart(current)) {
                        word();
                    } else if (Character.isDigit(current)) {
                        number();
                    } else if (current == ':'
                            || current == '@'
                            || current == '$'
                            || current == '?') {
                        parameter();
                    } else {
                        tokens.add(new Token(
                                TokenType.SYMBOL,
                                String.valueOf(current),
                                depth,
                                position++));
                    }
                }
                if (depth != 0) {
                    throw invalid("左括号没有闭合", sql.length());
                }
                return List.copyOf(tokens);
            }

            private void word() {
                int start = position++;
                while (position < sql.length()
                        && isWordPart(sql.charAt(position))) {
                    position++;
                }
                tokens.add(new Token(
                        TokenType.WORD,
                        sql.substring(start, position),
                        depth,
                        start));
            }

            private void number() {
                int start = position++;
                while (position < sql.length()) {
                    char value = sql.charAt(position);
                    if (!Character.isDigit(value)
                            && value != '.'
                            && value != 'e'
                            && value != 'E'
                            && value != '+'
                            && value != '-') {
                        break;
                    }
                    position++;
                }
                tokens.add(new Token(
                        TokenType.NUMBER,
                        sql.substring(start, position),
                        depth,
                        start));
            }

            private void parameter() {
                int start = position++;
                while (position < sql.length()
                        && isWordPart(sql.charAt(position))) {
                    position++;
                }
                tokens.add(new Token(
                        TokenType.PARAMETER,
                        sql.substring(start, position),
                        depth,
                        start));
            }

            private void quoted(char delimiter, TokenType type)
                    throws Failure {
                int start = position++;
                StringBuilder value = new StringBuilder();
                while (position < sql.length()) {
                    char current = sql.charAt(position++);
                    if (current != delimiter) {
                        value.append(current);
                        continue;
                    }
                    if (position < sql.length()
                            && sql.charAt(position) == delimiter) {
                        value.append(delimiter);
                        position++;
                        continue;
                    }
                    tokens.add(new Token(type, value.toString(), depth,
                            start));
                    return;
                }
                throw invalid("引用内容没有闭合", start);
            }

            private void bracketIdentifier() throws Failure {
                int start = position++;
                StringBuilder value = new StringBuilder();
                while (position < sql.length()) {
                    char current = sql.charAt(position++);
                    if (current != ']') {
                        value.append(current);
                        continue;
                    }
                    if (position < sql.length()
                            && sql.charAt(position) == ']') {
                        value.append(']');
                        position++;
                        continue;
                    }
                    tokens.add(new Token(
                            TokenType.IDENTIFIER,
                            value.toString(),
                            depth,
                            start));
                    return;
                }
                throw invalid("方括号标识符没有闭合", start);
            }

            private void lineComment() {
                position += 2;
                while (position < sql.length()
                        && sql.charAt(position) != '\n') {
                    position++;
                }
            }

            private void blockComment() throws Failure {
                int start = position;
                position += 2;
                int nesting = 1;
                while (position < sql.length() && nesting > 0) {
                    if (sql.charAt(position) == '/' && peek(1) == '*') {
                        nesting++;
                        position += 2;
                    } else if (sql.charAt(position) == '*'
                            && peek(1) == '/') {
                        nesting--;
                        position += 2;
                    } else {
                        position++;
                    }
                }
                if (nesting != 0) {
                    throw invalid("块注释没有闭合", start);
                }
            }

            private char peek(int offset) {
                int target = position + offset;
                return target >= sql.length() ? '\0' : sql.charAt(target);
            }

            private boolean isWordStart(char value) {
                return Character.isLetter(value)
                        || value == '_'
                        || value == '#';
            }

            private boolean isWordPart(char value) {
                return Character.isLetterOrDigit(value)
                        || value == '_'
                        || value == '#';
            }

            private Failure invalid(String detail, int offset) {
                return new Failure(
                        "invalid_sql",
                        detail + "（位置 " + (offset + 1) + "）");
            }
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

    static String requiredText(Map<?, ?> input, String field, int max)
            throws Failure {
        String value = input.get(field) instanceof String text
                ? text : "";
        if (value.isBlank()) {
            throw new Failure("invalid_tool_input", field + " 不能为空");
        }
        if (value.length() > max) {
            throw new Failure("invalid_tool_input",
                    field + " 长度超过上限 " + max);
        }
        return value;
    }

    static String optionalText(Map<?, ?> input, String field, int max)
            throws Failure {
        if (!(input.get(field) instanceof String text) || text.isBlank()) {
            return null;
        }
        if (text.length() > max) {
            throw new Failure("invalid_tool_input",
                    field + " 长度超过上限 " + max);
        }
        return text;
    }

    static int intAt(Map<?, ?> input, String field, int fallback) {
        return input.get(field) instanceof Number number
                ? number.intValue() : fallback;
    }

    static int bounded(int value, int minimum, int maximum, String field)
            throws Failure {
        if (value < minimum || value > maximum) {
            throw new Failure("invalid_tool_input",
                    field + " 必须在 " + minimum + " 到 " + maximum + " 之间");
        }
        return value;
    }

    @SuppressWarnings("unchecked")
    static Map<String, Object> castMap(Map<?, ?> map) {
        return map == null ? new LinkedHashMap<>() : (Map<String, Object>) map;
    }

    static boolean boolAt(Map<String, Object> node, String field,
            boolean fallback) {
        return node.get(field) instanceof Boolean value ? value : fallback;
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
    // 自足 JSON：无第三方依赖，供帧协议与 connections.json 使用。
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
