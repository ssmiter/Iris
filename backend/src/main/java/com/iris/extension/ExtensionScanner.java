package com.iris.extension;

import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.dataformat.yaml.YAMLFactory;
import com.iris.tools.core.ToolManifest;
import org.springframework.stereotype.Component;

import java.io.IOException;
import java.io.UncheckedIOException;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.security.MessageDigest;
import java.security.NoSuchAlgorithmException;
import java.util.ArrayList;
import java.util.Comparator;
import java.util.HexFormat;
import java.util.List;
import java.util.regex.Pattern;
import java.util.stream.Stream;

/**
 * 拓展根扫描器（docs/31 §2/§6）：识别 {@code *.tool.yml}、
 * {@code *.mcp.yml} 与 {@code _directory.yml}，能力路径由相对目录派生
 * （映射禁令）。校验 fail-closed：非法插件整体进入 problems，合法插件不受影响。
 */
@Component
public class ExtensionScanner {

    private static final Pattern TOOL_MANIFEST_NAME =
            Pattern.compile(".+\\.tool\\.yml");
    private static final Pattern MCP_MANIFEST_NAME =
            Pattern.compile(".+\\.mcp\\.yml");
    private static final Pattern DIRECTORY_META_NAME =
            Pattern.compile("_directory\\.yml");
    private static final Pattern SNAKE_CASE =
            Pattern.compile("[a-z][a-z0-9]*(?:_[a-z0-9]+)*");
    private static final Pattern ENVIRONMENT_NAME =
            Pattern.compile("[A-Z_][A-Z0-9_]*");
    private static final Pattern PATH_SEGMENT =
            Pattern.compile("[a-z0-9_][a-z0-9_-]*");
    private static final Pattern SPAWN_PLACEHOLDER =
            Pattern.compile("\\{([a-zA-Z][a-zA-Z0-9_]*)}");
    private static final int MAX_DEPTH = 10;

    private final ObjectMapper yaml = new ObjectMapper(new YAMLFactory());

    public ScanResult scan(Path root) {
        List<ScannedTool> tools = new ArrayList<>();
        List<ScannedDirectory> directories = new ArrayList<>();
        List<ScannedMcpServer> mcpServers = new ArrayList<>();
        List<String> problems = new ArrayList<>();
        if (root == null || !Files.isDirectory(root)) {
            return new ScanResult(root, tools, directories, mcpServers,
                    problems);
        }
        try (Stream<Path> walk = Files.walk(root, MAX_DEPTH)) {
            List<Path> files = walk
                    .filter(Files::isRegularFile)
                    .filter(path -> !isHiddenRelative(root, path))
                    .sorted(Comparator.comparing(Path::toString))
                    .toList();
            for (Path file : files) {
                String fileName = file.getFileName().toString();
                if (TOOL_MANIFEST_NAME.matcher(fileName).matches()) {
                    scanTool(root, file, tools, problems);
                } else if (MCP_MANIFEST_NAME.matcher(fileName).matches()) {
                    scanMcpServer(file, mcpServers, problems);
                } else if (DIRECTORY_META_NAME.matcher(fileName).matches()) {
                    scanDirectory(root, file, directories, problems);
                }
            }
        } catch (IOException | UncheckedIOException exception) {
            problems.add("扫描拓展根失败 " + root + ": " + exception.getMessage());
        }
        return new ScanResult(root, List.copyOf(tools),
                List.copyOf(directories), List.copyOf(mcpServers),
                List.copyOf(problems));
    }

    private void scanTool(
            Path root,
            Path file,
            List<ScannedTool> tools,
            List<String> problems
    ) {
        ProcessToolDefinition definition;
        try {
            definition = yaml.readValue(
                    file.toFile(),
                    ProcessToolDefinition.class
            );
        } catch (IOException exception) {
            problems.add("清单解析失败 " + file + ": " + exception.getMessage());
            return;
        }
        String problem = validate(definition, file);
        if (problem != null) {
            problems.add(problem);
            return;
        }
        String capabilityPath = capabilityPath(root, file, definition.name());
        if (capabilityPath == null) {
            problems.add("目录段含非法字符，无法派生能力路径: " + file.getParent());
            return;
        }
        tools.add(new ScannedTool(
                file.getParent(),
                file,
                definition,
                capabilityPath,
                contentHash(file)
        ));
    }

    private void scanMcpServer(
            Path file,
            List<ScannedMcpServer> servers,
            List<String> problems
    ) {
        McpServerDeclaration declaration;
        try {
            declaration = yaml.readValue(
                    file.toFile(),
                    McpServerDeclaration.class
            );
        } catch (IOException exception) {
            problems.add("MCP 声明解析失败 " + file + ": "
                    + exception.getMessage());
            return;
        }
        String problem = validateMcp(declaration, file);
        if (problem != null) {
            problems.add(problem);
            return;
        }
        servers.add(new ScannedMcpServer(file, declaration));
    }

    /** 返回诊断文本；null 表示合法。结构性校验在此，slug 冲突裁决在 McpServerService。 */
    private String validateMcp(McpServerDeclaration declaration, Path file) {
        if (declaration.slug() == null
                || !SNAKE_CASE.matcher(declaration.slug()).matches()) {
            return "MCP slug 必须是 snake_case " + file;
        }
        if (declaration.displayName() == null
                || declaration.displayName().isBlank()) {
            return "MCP 声明缺少 display_name " + file;
        }
        boolean stdio = "stdio".equals(declaration.transport());
        if (!stdio && !"streamable_http".equals(declaration.transport())) {
            return "MCP transport 只能是 stdio | streamable_http "
                    + file + ": " + declaration.transport();
        }
        if (stdio) {
            if (declaration.command() == null
                    || declaration.command().isEmpty()
                    || declaration.command().stream()
                            .anyMatch(element -> element == null
                                    || element.isBlank())) {
                return "stdio MCP 声明的 command 不能为空 " + file;
            }
        } else if (declaration.endpoint() == null
                || declaration.endpoint().isBlank()) {
            return "streamable_http MCP 声明缺少 endpoint " + file;
        }
        if (declaration.env() != null) {
            for (String name : declaration.env()) {
                if (name == null
                        || !ENVIRONMENT_NAME.matcher(name).matches()) {
                    return "MCP env 只声明环境变量名（大写 snake）"
                            + file + ": " + name;
                }
            }
        }
        return null;
    }

    private void scanDirectory(
            Path root,
            Path file,
            List<ScannedDirectory> directories,
            List<String> problems
    ) {
        DirectoryMetadata metadata;
        try {
            metadata = yaml.readValue(file.toFile(), DirectoryMetadata.class);
        } catch (IOException exception) {
            problems.add("目录元数据解析失败 " + file + ": "
                    + exception.getMessage());
            return;
        }
        String directoryPath = capabilityDirectory(root, file.getParent());
        if (directoryPath == null) {
            problems.add("目录段含非法字符，无法派生目录路径: " + file.getParent());
            return;
        }
        directories.add(new ScannedDirectory(directoryPath, metadata));
    }

    /** 返回诊断文本；null 表示合法。 */
    private String validate(ProcessToolDefinition definition, Path file) {
        if (definition.name() == null
                || !SNAKE_CASE.matcher(definition.name()).matches()) {
            return "工具名必须是 snake_case " + file;
        }
        if (definition.description() == null
                || definition.description().isBlank()) {
            return "工具缺少一句话 description " + file;
        }
        if (definition.description().length() > 500) {
            return "description 超过 500 字符 " + file;
        }
        if (definition.inputSchema() == null
                || !definition.inputSchema().isObject()) {
            return "input_schema 必须是 JSON Schema 对象 " + file;
        }
        if (!"template".equals(definition.kind())
                && !"process".equals(definition.kind())) {
            return "未知 kind（支持 process | template）"
                    + file + ": " + definition.kind();
        }
        if (definition.runtime() == null
                || definition.runtime().entry() == null
                || definition.runtime().entry().isEmpty()) {
            return "runtime.entry 不能为空 " + file;
        }
        if ("process".equals(definition.kind())) {
            // 常驻形态的参数走 invoke 帧；spawn argv 只允许内核供给占位符。
            for (String element : definition.runtime().entry()) {
                var matcher = SPAWN_PLACEHOLDER.matcher(element);
                while (matcher.find()) {
                    String key = matcher.group(1);
                    if (!"pluginDir".equals(key) && !"javaBin".equals(key)) {
                        return "kind=process 的 runtime.entry 只允许内核供给"
                                + "占位符 {pluginDir}/{javaBin}（参数经 "
                                + "invoke 帧传递）" + file + ": {" + key + "}";
                    }
                }
            }
        }
        String mode = definition.approval() == null
                ? null
                : definition.approval().mode();
        if (mode != null && !"auto".equals(mode) && !"explicit".equals(mode)) {
            return "approval.mode 只能是 auto | explicit " + file;
        }
        if ("explicit".equals(mode)
                && (definition.approval().impactStatement() == null
                        || definition.approval().impactStatement().isBlank())) {
            return "审批模式 explicit 必须提供 impact_statement 模板 " + file;
        }
        ToolManifest.SideEffect sideEffect;
        try {
            TemplateProcessTool.riskLevel(definition);
            sideEffect = TemplateProcessTool.sideEffect(definition);
        } catch (RuntimeException exception) {
            return exception.getMessage() + " " + file;
        }
        if ("explicit".equals(mode)
                && sideEffect == ToolManifest.SideEffect.NONE) {
            return "只读工具无需 explicit 审批 " + file;
        }
        return null;
    }

    private String capabilityPath(Path root, Path file, String toolName) {
        String directory = capabilityDirectory(root, file.getParent());
        if (directory == null) {
            return null;
        }
        return (directory.equals("/") ? "" : directory) + "/" + toolName;
    }

    private String capabilityDirectory(Path root, Path directory) {
        Path relative = root.relativize(directory);
        StringBuilder path = new StringBuilder("/");
        for (Path segment : relative) {
            String text = segment.toString();
            if (!PATH_SEGMENT.matcher(text).matches()) {
                return null;
            }
            path.append(text).append('/');
        }
        if (path.length() > 1) {
            path.setLength(path.length() - 1);
        }
        return path.toString();
    }

    private boolean isHiddenRelative(Path root, Path file) {
        for (Path segment : root.relativize(file)) {
            String text = segment.toString();
            if (text.startsWith(".") && !text.equals(".")) {
                return true;
            }
        }
        return false;
    }

    private String contentHash(Path file) {
        try {
            MessageDigest digest = MessageDigest.getInstance("SHA-256");
            byte[] hash = digest.digest(Files.readAllBytes(file));
            return HexFormat.of().formatHex(hash, 0, 8);
        } catch (NoSuchAlgorithmException exception) {
            throw new IllegalStateException(exception);
        } catch (IOException exception) {
            throw new UncheckedIOException(exception);
        }
    }

    public record ScanResult(
            Path root,
            List<ScannedTool> tools,
            List<ScannedDirectory> directories,
            List<ScannedMcpServer> mcpServers,
            List<String> problems
    ) {
    }

    public record ScannedTool(
            Path pluginDir,
            Path manifestFile,
            ProcessToolDefinition definition,
            String capabilityPath,
            String contentVersion
    ) {
    }

    public record ScannedDirectory(
            String directoryPath,
            DirectoryMetadata metadata
    ) {
    }

    /** {@code *.mcp.yml} 声明（docs/31 §5.3）；冲突裁决与落库在 McpServerService。 */
    public record ScannedMcpServer(
            Path declarationFile,
            McpServerDeclaration declaration
    ) {
    }

    /** {@code _directory.yml}（docs/31 §2.2）。 */
    public record DirectoryMetadata(
            String label,
            String summary,
            Integer order,
            List<String> tags,
            String visibility
    ) {
        public boolean hidden() {
            return "hidden".equals(visibility);
        }
    }
}
