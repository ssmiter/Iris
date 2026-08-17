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
import java.util.Map;
import java.util.Set;
import java.util.regex.Pattern;
import java.util.stream.Stream;

/**
 * 拓展根扫描器（docs/31 §2/§6）：格式识别 {@code *.tool.yml}、
 * {@code *.mcp.yml}、{@code _directory.yml}、SKILL.md（束与扁平，
 * §5.1）与 knowledge 段下的 {@code *.md}（§3），能力路径由相对目录
 * 派生（映射禁令）。校验 fail-closed：非法插件整体进入 problems，
 * 合法插件不受影响。
 */
@Component
public class ExtensionScanner {

    private static final Pattern TOOL_MANIFEST_NAME =
            Pattern.compile(".+\\.tool\\.yml");
    private static final Pattern MCP_MANIFEST_NAME =
            Pattern.compile(".+\\.mcp\\.yml");
    private static final Pattern KNOWLEDGE_DOC_NAME =
            Pattern.compile(".+\\.md");
    private static final String KNOWLEDGE_SEGMENT = "knowledge";
    private static final Pattern DIRECTORY_META_NAME =
            Pattern.compile("_directory\\.yml");
    /** 束形态的固定文件名（docs/31 §5.1），大小写敏感。 */
    private static final String SKILL_BUNDLE_FILE = "SKILL.md";
    private static final Pattern SKILL_FLAT_NAME =
            Pattern.compile(".+\\.SKILL\\.md");
    private static final Pattern KEBAB_CASE =
            Pattern.compile("[a-z0-9]+(?:-[a-z0-9]+)*");
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
        List<ScannedKnowledge> knowledge = new ArrayList<>();
        List<ScannedSkill> skills = new ArrayList<>();
        Map<String, Set<String>> usedKnowledgeNames = new java.util.HashMap<>();
        List<String> problems = new ArrayList<>();
        if (root == null || !Files.isDirectory(root)) {
            return new ScanResult(root, tools, directories, mcpServers,
                    knowledge, skills, problems);
        }
        try (Stream<Path> walk = Files.walk(root, MAX_DEPTH)) {
            List<Path> files = walk
                    .filter(Files::isRegularFile)
                    .filter(path -> !isHiddenRelative(root, path))
                    .sorted(Comparator.comparing(Path::toString))
                    .toList();
            for (Path file : files) {
                String fileName = file.getFileName().toString();
                if (isKnowledgeDoc(root, file)
                        && KNOWLEDGE_DOC_NAME.matcher(fileName).matches()) {
                    // knowledge 段优先：语料目录下的 SKILL.md 仍按知识投影（§5.1）
                    scanKnowledge(root, file, knowledge, usedKnowledgeNames,
                            problems);
                } else if (SKILL_BUNDLE_FILE.equals(fileName)
                        || SKILL_FLAT_NAME.matcher(fileName).matches()) {
                    scanSkill(root, file, fileName, skills, problems);
                } else if (TOOL_MANIFEST_NAME.matcher(fileName).matches()) {
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
                List.copyOf(knowledge), List.copyOf(skills),
                List.copyOf(problems));
    }

    /** knowledge 目录下的 .md 文件即知识文档（docs/31 §3 投影规则）。 */
    private boolean isKnowledgeDoc(Path root, Path file) {
        for (Path segment : root.relativize(file.getParent())) {
            if (KNOWLEDGE_SEGMENT.equals(segment.toString())) {
                return true;
            }
        }
        return false;
    }

    private void scanKnowledge(
            Path root,
            Path file,
            List<ScannedKnowledge> knowledge,
            Map<String, Set<String>> usedNames,
            List<String> problems
    ) {
        String directory = capabilityDirectory(root, file.getParent());
        if (directory == null) {
            problems.add("目录段含非法字符，无法派生知识库路径: "
                    + file.getParent());
            return;
        }
        String fileName = file.getFileName().toString();
        String base = fileName.substring(0, fileName.length() - 3);
        String name = knowledgeName(base, file);
        Set<String> taken = usedNames.computeIfAbsent(
                directory, key -> new java.util.HashSet<>()
        );
        if (!taken.add(name)) {
            name = name + "_" + contentHash(file).substring(0, 8);
            taken.add(name);
        }
        String capabilityPath =
                (directory.equals("/") ? "" : directory) + "/" + name;
        knowledge.add(new ScannedKnowledge(
                file, name, knowledgeTitle(file, base), capabilityPath,
                contentHash(file)
        ));
    }

    /** ascii 转 snake_case；纯非 ascii 名退化为 doc_<内容hash前8位>（确定性）。 */
    private String knowledgeName(String base, Path file) {
        String slug = base.toLowerCase(java.util.Locale.ROOT)
                .replaceAll("[^a-z0-9]+", "_")
                .replaceAll("^_+|_+$", "")
                .replaceAll("_+", "_");
        if (slug.isBlank() || !Character.isLetter(slug.charAt(0))) {
            slug = "doc_" + contentHash(file).substring(0, 8);
        }
        return slug;
    }

    /** 首个 `#` 标题行，无则首个非空行，再退化为文件名；≤120 字符。 */
    private String knowledgeTitle(Path file, String base) {
        List<String> lines;
        try {
            lines = Files.readAllLines(file, StandardCharsets.UTF_8);
        } catch (IOException exception) {
            return base;
        }
        String fallback = null;
        for (String line : lines) {
            String trimmed = line.trim();
            if (trimmed.isBlank()) {
                continue;
            }
            if (trimmed.startsWith("#")) {
                String heading = trimmed.replaceAll("^#+\\s*", "");
                if (!heading.isBlank()) {
                    return heading.length() <= 120
                            ? heading : heading.substring(0, 120);
                }
            }
            if (fallback == null) {
                fallback = trimmed;
            }
        }
        String title = fallback == null ? base : fallback;
        return title.length() <= 120 ? title : title.substring(0, 120);
    }

    /**
     * 技能识别（docs/31 §5.1）：束 {@code <name>/SKILL.md} 或扁平
     * {@code <name>.SKILL.md}。frontmatter 白名单校验，非法即整件丢弃。
     */
    private void scanSkill(
            Path root,
            Path file,
            String fileName,
            List<ScannedSkill> skills,
            List<String> problems
    ) {
        String content;
        try {
            content = Files.readString(file, StandardCharsets.UTF_8);
        } catch (IOException exception) {
            problems.add("技能读取失败 " + file + ": " + exception.getMessage());
            return;
        }
        String[] parts = SkillDocument.split(content);
        if (parts == null) {
            problems.add("技能缺少 --- 开合的 frontmatter " + file);
            return;
        }
        SkillDefinition definition;
        try {
            definition = yaml.readValue(parts[0], SkillDefinition.class);
        } catch (IOException exception) {
            problems.add("技能 frontmatter 非法（含白名单外字段或类型错误）"
                    + file + ": " + exception.getMessage());
            return;
        }
        if (definition.name() == null
                || !KEBAB_CASE.matcher(definition.name()).matches()) {
            problems.add("技能 name 必须是 kebab-case " + file);
            return;
        }
        if (definition.description() == null
                || definition.description().isBlank()) {
            problems.add("技能缺少 description " + file);
            return;
        }
        String name = definition.name().replace('-', '_');
        if (!SNAKE_CASE.matcher(name).matches()) {
            problems.add("技能名转换为 snake_case 后非法（须字母开头）"
                    + file + ": " + definition.name());
            return;
        }
        Path bundleDir = null;
        Path parentDir;
        if (SKILL_BUNDLE_FILE.equals(fileName)) {
            bundleDir = file.getParent();
            if (bundleDir.equals(root)) {
                problems.add("SKILL.md 必须位于命名束目录内，不能直接挂在根上 "
                        + file);
                return;
            }
            parentDir = bundleDir.getParent();
        } else {
            parentDir = file.getParent();
        }
        // 束与扁平同形：父目录 + 转换后能力名（叶段必须 snake_case，
        // ToolRegistry.requireExternalPath 约束）。
        String directory = capabilityDirectory(root, parentDir);
        if (directory == null) {
            problems.add("目录段含非法字符，无法派生技能路径: " + parentDir);
            return;
        }
        String capabilityPath =
                (directory.equals("/") ? "" : directory) + "/" + name;
        skills.add(new ScannedSkill(
                file, bundleDir, name, definition, capabilityPath,
                contentHash(file)
        ));
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
            List<ScannedKnowledge> knowledge,
            List<ScannedSkill> skills,
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

    /** knowledge 目录下的 .md 知识文档（docs/31 §3 投影规则）。 */
    public record ScannedKnowledge(
            Path file,
            String name,
            String title,
            String capabilityPath,
            String contentVersion
    ) {
    }

    /**
     * SKILL.md 技能（docs/31 §5.1）。{@code bundleDir} 为束目录；扁平形态
     * 为 null（无束内资源可读）。
     */
    public record ScannedSkill(
            Path file,
            Path bundleDir,
            String name,
            SkillDefinition definition,
            String capabilityPath,
            String contentVersion
    ) {
    }

    /** {@code _directory.yml}（docs/31 §2.2）。 */
    public record DirectoryMetadata(
            String label,
            String summary,
            Integer order,
            List<String> tags,
            String visibility,
            StatsSpec stats
    ) {
        public boolean hidden() {
            return "hidden".equals(visibility);
        }

        /** 只声明口径，值由内核实时算（docs/31 §2.2）。 */
        @com.fasterxml.jackson.annotation.JsonIgnoreProperties(
                ignoreUnknown = false)
        public record StatsSpec(List<String> expose) {
            public List<String> exposeOrEmpty() {
                return expose == null ? List.of() : expose;
            }
        }
    }
}
