package com.iris.tools.catalog;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.node.ObjectNode;
import com.fasterxml.jackson.dataformat.yaml.YAMLFactory;
import com.iris.conversation.domain.ApiProblemException;
import com.iris.extension.ExtensionProviderService;
import com.iris.extension.ShadowedCapability;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.http.HttpStatus;
import org.springframework.stereotype.Service;

import java.io.IOException;
import java.io.UncheckedIOException;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.StandardCopyOption;
import java.util.List;
import java.util.Locale;
import java.util.Optional;
import java.util.Set;
import java.util.regex.Pattern;

/**
 * 能力管理面文件操作（docs/37 §2.3）：移动/重命名/复制/删除拓展根内的
 * 文件真相对象。所有操作走拓展根围栏，成功后触发该根热重扫。
 */
@Service
public class CapabilityAdminFileService {

    private static final Logger log =
            LoggerFactory.getLogger(CapabilityAdminFileService.class);

    private static final Pattern SNAKE_CASE =
            Pattern.compile("[a-z][a-z0-9]*(?:_[a-z0-9]+)*");
    private static final Pattern CAPABILITY_PATH = Pattern.compile(
            "^/(?:[a-z0-9_][a-z0-9_-]*/)*[a-z][a-z0-9_]*$"
    );
    private static final String COPY_SUFFIX = "_copy";
    private static final String TOOL_SUFFIX = ".tool.yml";
    private static final String SKILL_BUNDLE_FILE = "SKILL.md";
    private static final String SKILL_FLAT_SUFFIX = ".SKILL.md";
    private static final String DIRECTORY_META = "_directory.yml";
    private static final String MCP_SUFFIX = ".mcp.yml";
    private static final String KNOWLEDGE_SEGMENT = "knowledge";

    private final ExtensionProviderService extensions;
    private final ObjectMapper yamlMapper = new ObjectMapper(new YAMLFactory());

    public CapabilityAdminFileService(ExtensionProviderService extensions) {
        this.extensions = extensions;
    }

    /**
     * 移动：把源文件/束目录移动到目标目录。能力路径随目录结构重新派生。
     */
    public OperationResult move(String sourcePath, String targetDir) {
        SourceFile source = resolveSource(sourcePath);
        Path targetDirectory = resolveTargetDir(targetDir);
        rejectKernelOrDbTruth(source.capabilityPath());

        Path sourceRoot = owningRoot(source.file())
                .orElseThrow(() -> outOfBounds(sourcePath));
        Path targetRoot = owningRoot(targetDirectory)
                .orElseThrow(() -> outOfBounds(targetDir));

        Path moved = targetDirectory.resolve(source.file().getFileName());
        FileKind kind = classify(source.file());
        if (kind == FileKind.SKILL_BUNDLE) {
            moved = targetDirectory.resolve(source.file().getParent().getFileName());
        }
        if (Files.exists(moved)) {
            throw conflict("目标目录已存在同名对象");
        }

        try {
            ensureParentExists(moved);
            if (kind == FileKind.SKILL_BUNDLE) {
                Files.move(source.file().getParent(), moved);
            } else {
                Files.move(source.file(), moved);
            }
        } catch (IOException exception) {
            throw new IllegalStateException("移动失败: " + exception.getMessage(),
                    exception);
        }

        Path pathInferenceFile = (kind == FileKind.SKILL_BUNDLE)
                ? moved.resolve(SKILL_BUNDLE_FILE)
                : moved;
        String newCapabilityPath = inferCapabilityPath(pathInferenceFile, targetRoot);
        log.info("capability-file-op: move source={} target={} affected=[{}, {}]",
                source.capabilityPath(), targetDir, source.capabilityPath(),
                newCapabilityPath);

        rescanRoots(sourceRoot, targetRoot);
        return new OperationResult("move", source.capabilityPath(), targetDir,
                List.of(source.capabilityPath(), newCapabilityPath));
    }

    /**
     * 重命名：改文件名/目录名并同步 manifest/frontmatter 中的 name。
     */
    public OperationResult rename(String path, String newName) {
        if (newName == null || !SNAKE_CASE.matcher(newName).matches()) {
            throw badRequest("newName 必须是 snake_case");
        }
        SourceFile source = resolveSource(path);
        rejectKernelOrDbTruth(source.capabilityPath());

        Path root = owningRoot(source.file())
                .orElseThrow(() -> outOfBounds(path));
        Path parent = source.file().getParent();
        if (parent == null) {
            throw unprocessable("根级对象无法重命名");
        }

        FileKind kind = classify(source.file());
        if (kind == FileKind.MCP || kind == FileKind.DIRECTORY) {
            throw unprocessable("该对象类型不支持重命名");
        }

        Path renamed = computeRenamedPath(source.file(), newName, kind);
        if (Files.exists(renamed)) {
            throw conflict("该名称已存在");
        }

        try {
            if (kind == FileKind.SKILL_BUNDLE) {
                Path oldBundleDir = source.file().getParent();
                Path newBundleDir = oldBundleDir.resolveSibling(
                        snakeToKebab(newName));
                Files.move(oldBundleDir, newBundleDir);
            } else {
                Files.move(source.file(), renamed);
            }
            updateNameInContent(renamed, newName, kind);
        } catch (IOException exception) {
            throw new IllegalStateException("重命名失败: " + exception.getMessage(),
                    exception);
        }

        String newCapabilityPath = inferCapabilityPath(renamed, root);
        log.info("capability-file-op: rename source={} newName={} affected=[{}, {}]",
                source.capabilityPath(), newName, source.capabilityPath(),
                newCapabilityPath);

        rescanRoots(root);
        return new OperationResult("rename", source.capabilityPath(), null,
                List.of(source.capabilityPath(), newCapabilityPath));
    }

    /**
     * 复制：在目标目录创建副本，能力名加 _copy 后缀（scanner 可识别的
     * "副本"机器形态）。冲突即拒绝，不自动加序号。
     */
    public OperationResult copy(String sourcePath, String targetDir) {
        SourceFile source = resolveSource(sourcePath);
        rejectKernelOrDbTruth(source.capabilityPath());

        Path targetDirectory = resolveTargetDir(targetDir);
        Path sourceRoot = owningRoot(source.file())
                .orElseThrow(() -> outOfBounds(sourcePath));
        Path targetRoot = owningRoot(targetDirectory)
                .orElseThrow(() -> outOfBounds(targetDir));

        FileKind kind = classify(source.file());
        if (kind == FileKind.MCP || kind == FileKind.DIRECTORY) {
            throw unprocessable("该对象类型不支持复制");
        }

        String sourceName = baseName(source.file(), kind);
        String copyName = sourceName + COPY_SUFFIX;
        Path copied = computeCopyPath(source.file(), targetDirectory, copyName,
                kind);
        if (Files.exists(copied)) {
            throw conflict("副本目标已存在");
        }

        try {
            if (kind == FileKind.SKILL_BUNDLE) {
                copyDirectory(source.file().getParent(), copied.getParent());
            } else {
                ensureParentExists(copied);
                Files.copy(source.file(), copied,
                        StandardCopyOption.COPY_ATTRIBUTES);
            }
            updateNameInContent(copied, copyName, kind);
        } catch (IOException exception) {
            throw new IllegalStateException("复制失败: " + exception.getMessage(),
                    exception);
        }

        String newCapabilityPath = inferCapabilityPath(copied, targetRoot);
        log.info("capability-file-op: copy source={} target={} affected=[{}]",
                source.capabilityPath(), targetDir, newCapabilityPath);

        rescanRoots(targetRoot);
        return new OperationResult("copy", source.capabilityPath(), targetDir,
                List.of(newCapabilityPath));
    }

    /**
     * 删除：单文件或技能束目录。process/template 删清单，skill 删束目录，
     * knowledge 删文档。
     */
    public OperationResult delete(String path) {
        SourceFile source = resolveSource(path);
        rejectKernelOrDbTruth(source.capabilityPath());

        Path root = owningRoot(source.file())
                .orElseThrow(() -> outOfBounds(path));

        FileKind kind = classify(source.file());
        if (kind == FileKind.MCP || kind == FileKind.DIRECTORY) {
            throw unprocessable("该对象类型不支持删除");
        }

        try {
            if (kind == FileKind.SKILL_BUNDLE) {
                deleteDirectory(source.file().getParent());
            } else {
                Files.deleteIfExists(source.file());
            }
        } catch (IOException exception) {
            throw new IllegalStateException("删除失败: " + exception.getMessage(),
                    exception);
        }

        log.info("capability-file-op: delete source={} affected=[{}]",
                source.capabilityPath(), source.capabilityPath());

        rescanRoots(root);
        return new OperationResult("delete", source.capabilityPath(), null,
                List.of(source.capabilityPath()));
    }

    // ---------- 解析与围栏 ----------

    private SourceFile resolveSource(String rawPath) {
        if (rawPath == null || rawPath.isBlank()) {
            throw badRequest("path 不能为空");
        }

        // 1. 若像 sourceFile 绝对路径则优先按文件解析（兼容 Windows 盘符路径）
        if (looksLikeFilePath(rawPath)) {
            Path asFile = Path.of(rawPath).toAbsolutePath().normalize();
            Optional<Path> root = owningRoot(asFile);
            if (root.isEmpty()) {
                throw outOfBounds(rawPath);
            }
            if (Files.exists(asFile)) {
                String inferred = inferCapabilityPath(asFile, root.get());
                return new SourceFile(inferred, asFile);
            }
            // 文件不存在但落在登记根内：继续尝试能力路径解析
        }

        // 2. 再按能力路径解析（管理页常规形态）
        String normalized = normalizeCapabilityPath(rawPath);
        if (!"/".equals(normalized)) {
            Path fromRegistry = findFileByCapabilityPath(normalized);
            if (fromRegistry != null) {
                return new SourceFile(normalized, fromRegistry);
            }
        }

        if (normalized.startsWith("/system/")) {
            throw unprocessable("内核目录 /system/** 不可通过文件操作修改");
        }
        throw unprocessable(
                "该能力没有物理文件，或不在已登记拓展根内；无法执行文件操作"
        );
    }

    private boolean looksLikeFilePath(String rawPath) {
        return (rawPath.length() > 2 && rawPath.charAt(1) == ':')
                || (rawPath.startsWith("/") && !CAPABILITY_PATH.matcher(rawPath).matches());
    }

    private Path findFileByCapabilityPath(String capabilityPath) {
        String file = extensions.fileOf(capabilityPath);
        if (file != null) {
            return Path.of(file);
        }
        for (ShadowedCapability shadow : extensions.shadowed()) {
            if (shadow.capabilityPath().equals(capabilityPath)
                    && shadow.file() != null) {
                return Path.of(shadow.file());
            }
        }
        return null;
    }

    private Path resolveTargetDir(String rawTargetDir) {
        if (rawTargetDir == null || rawTargetDir.isBlank()) {
            throw badRequest("targetDir 不能为空");
        }

        Path asPath = Path.of(rawTargetDir).toAbsolutePath().normalize();
        if (Files.isDirectory(asPath)) {
            if (owningRoot(asPath).isEmpty()) {
                throw outOfBounds(rawTargetDir);
            }
            return asPath;
        }

        String capPath = normalizeCapabilityPath(rawTargetDir);
        String relative = capPath.substring(1).replace('/', java.io.File.separatorChar);
        for (Path root : extensions.registeredRoots()) {
            Path candidate = root.resolve(relative);
            if (Files.isDirectory(candidate)) {
                return candidate;
            }
        }
        throw badRequest("目标目录不存在: " + rawTargetDir);
    }

    private Optional<Path> owningRoot(Path path) {
        String normalized = path.toAbsolutePath().normalize().toString();
        for (Path root : extensions.registeredRoots()) {
            String rootStr = root.toAbsolutePath().normalize().toString();
            if (normalized.equalsIgnoreCase(rootStr)
                    || normalized.regionMatches(true, 0, rootStr, 0, rootStr.length())
                            && normalized.length() > rootStr.length()
                            && (rootStr.endsWith("/") || rootStr.endsWith("\\")
                                    || normalized.charAt(rootStr.length()) == '/'
                                    || normalized.charAt(rootStr.length()) == '\\')) {
                return Optional.of(root);
            }
        }
        return Optional.empty();
    }

    private void rejectKernelOrDbTruth(String capabilityPath) {
        if (capabilityPath.startsWith("/system/")) {
            throw unprocessable("内核目录 /system/** 不可通过文件操作修改");
        }
        // 若路径能被 ExtensionProviderService 解析出文件，则必为 extension 来源；
        // 其余未解析出的情况已在 resolveSource 中拒绝。
    }

    // ---------- 能力路径派生 ----------

    private String inferCapabilityPath(Path file, Path root) {
        Path relative = root.relativize(file.toAbsolutePath().normalize());
        String parent = parentCapabilitySegment(relative);
        FileKind kind = classify(file);
        return switch (kind) {
            case TOOL -> parent + "/" + baseName(relative.getFileName().toString());
            case KNOWLEDGE -> parent + "/" + knowledgeName(file);
            case SKILL_BUNDLE, SKILL_FLAT -> {
                String name = readSkillName(file);
                yield parent.isEmpty() ? "/" + name : parent + "/" + name;
            }
            case DIRECTORY -> parent.isEmpty() ? "/" : parent;
            case MCP -> throw new IllegalStateException("MCP 不应进入能力路径派生");
        };
    }

    private String knowledgeName(Path file) {
        String base = baseName(file.getFileName().toString(), ".md");
        String slug = base.toLowerCase(Locale.ROOT)
                .replaceAll("[^a-z0-9]+", "_")
                .replaceAll("^_+|_+$", "")
                .replaceAll("_+", "_");
        if (slug.isBlank() || !Character.isLetter(slug.charAt(0))) {
            slug = "doc_" + contentHash(file).substring(0, 8);
        }
        return slug;
    }

    private String contentHash(Path file) {
        try {
            java.security.MessageDigest digest =
                    java.security.MessageDigest.getInstance("SHA-256");
            byte[] hash = digest.digest(Files.readAllBytes(file));
            return java.util.HexFormat.of().formatHex(hash, 0, 8);
        } catch (java.security.NoSuchAlgorithmException exception) {
            throw new IllegalStateException(exception);
        } catch (IOException exception) {
            throw new UncheckedIOException(exception);
        }
    }

    private String parentCapabilitySegment(Path relative) {
        Path parent = relative.getParent();
        if (parent == null) {
            return "";
        }
        StringBuilder path = new StringBuilder();
        for (Path segment : parent) {
            path.append('/').append(segment.toString());
        }
        return path.toString();
    }

    // ---------- 文件类型与命名 ----------

    private enum FileKind {
        TOOL, KNOWLEDGE, SKILL_BUNDLE, SKILL_FLAT, DIRECTORY, MCP
    }

    private FileKind classify(Path file) {
        String name = file.getFileName().toString();
        if (name.endsWith(TOOL_SUFFIX)) {
            return FileKind.TOOL;
        }
        if (name.endsWith(MCP_SUFFIX)) {
            return FileKind.MCP;
        }
        if (DIRECTORY_META.equals(name)) {
            return FileKind.DIRECTORY;
        }
        if (SKILL_BUNDLE_FILE.equals(name)) {
            return FileKind.SKILL_BUNDLE;
        }
        if (name.endsWith(SKILL_FLAT_SUFFIX)) {
            return FileKind.SKILL_FLAT;
        }
        if (name.endsWith(".md") && isKnowledgeDirectory(file.getParent())) {
            return FileKind.KNOWLEDGE;
        }
        throw unprocessable("未知或不支持的对象文件类型: " + name);
    }

    private boolean isKnowledgeDirectory(Path directory) {
        if (directory == null) {
            return false;
        }
        for (Path segment : directory) {
            if (KNOWLEDGE_SEGMENT.equals(segment.toString())) {
                return true;
            }
        }
        return false;
    }

    private String baseName(Path file, FileKind kind) {
        String name = file.getFileName().toString();
        return switch (kind) {
            case TOOL -> baseName(name, TOOL_SUFFIX);
            case KNOWLEDGE -> baseName(name, ".md");
            case SKILL_FLAT -> baseName(name, SKILL_FLAT_SUFFIX);
            case SKILL_BUNDLE -> {
                Path parent = file.getParent();
                yield parent == null ? name : parent.getFileName().toString();
            }
            default -> name;
        };
    }

    private String baseName(String fileName) {
        if (fileName.endsWith(".md")) {
            return baseName(fileName, ".md");
        }
        if (fileName.endsWith(TOOL_SUFFIX)) {
            return baseName(fileName, TOOL_SUFFIX);
        }
        if (fileName.endsWith(SKILL_FLAT_SUFFIX)) {
            return baseName(fileName, SKILL_FLAT_SUFFIX);
        }
        return fileName;
    }

    private String baseName(String fileName, String suffix) {
        return fileName.substring(0, fileName.length() - suffix.length());
    }

    private Path computeRenamedPath(Path source, String newName,
            FileKind kind) {
        Path parent = source.getParent();
        return switch (kind) {
            case TOOL -> parent.resolve(newName + TOOL_SUFFIX);
            case KNOWLEDGE -> parent.resolve(newName + ".md");
            case SKILL_BUNDLE -> parent.resolveSibling(snakeToKebab(newName))
                    .resolve(SKILL_BUNDLE_FILE);
            case SKILL_FLAT -> parent.resolve(newName + SKILL_FLAT_SUFFIX);
            default -> throw new IllegalStateException("不支持重命名的类型");
        };
    }

    private Path computeCopyPath(Path source, Path targetDir, String copyName,
            FileKind kind) {
        return switch (kind) {
            case TOOL -> targetDir.resolve(copyName + TOOL_SUFFIX);
            case KNOWLEDGE -> targetDir.resolve(copyName + ".md");
            case SKILL_BUNDLE -> targetDir.resolve(snakeToKebab(copyName))
                    .resolve(SKILL_BUNDLE_FILE);
            case SKILL_FLAT -> targetDir.resolve(copyName + SKILL_FLAT_SUFFIX);
            default -> throw new IllegalStateException("不支持复制的类型");
        };
    }

    private String snakeToKebab(String value) {
        return value.replace('_', '-');
    }

    // ---------- 内容修改 ----------

    private void updateNameInContent(Path file, String newName, FileKind kind)
            throws IOException {
        switch (kind) {
            case TOOL -> updateToolName(file, newName);
            case SKILL_BUNDLE, SKILL_FLAT -> updateSkillName(file, newName);
            case KNOWLEDGE -> {
                    // 能力名完全由文件名派生，无需改内容
            }
            default -> throw new IllegalStateException("无需修改内容");
        }
    }

    private void updateToolName(Path file, String newName) throws IOException {
        JsonNode manifest = yamlMapper.readTree(file.toFile());
        if (!(manifest instanceof ObjectNode objectNode)) {
            throw new IllegalStateException("工具清单不是对象: " + file);
        }
        objectNode.put("name", newName);
        yamlMapper.writeValue(file.toFile(), manifest);
    }

    private void updateSkillName(Path file, String newName) throws IOException {
        String content = Files.readString(file, StandardCharsets.UTF_8);
        String[] parts = splitSkillDocument(content);
        if (parts == null) {
            throw new IllegalStateException("SKILL.md 缺少 frontmatter: " + file);
        }
        String frontmatter = parts[0];
        String body = parts[1];
        String kebab = snakeToKebab(newName);
        String updated = frontmatter.replaceFirst(
                "(?m)^name:\\s*\\S+", "name: " + kebab
        );
        if (updated.equals(frontmatter)) {
            // 兼容 name 后无空格或引号的情况
            updated = frontmatter.replaceFirst(
                    "(?m)^name:.*$", "name: " + kebab
            );
        }
        Files.writeString(file, "---\n" + updated + "---\n" + body,
                StandardCharsets.UTF_8);
    }

    private String readSkillName(Path file) {
        try {
            String content = Files.readString(file, StandardCharsets.UTF_8);
            String[] parts = splitSkillDocument(content);
            if (parts == null) {
                return fallbackSkillName(file);
            }
            for (String line : parts[0].split("\\r?\\n")) {
                String trimmed = line.trim();
                if (trimmed.startsWith("name:")) {
                    String value = trimmed.substring("name:".length()).trim();
                    return value.replace('-', '_');
                }
            }
            return fallbackSkillName(file);
        } catch (IOException exception) {
            throw new UncheckedIOException(exception);
        }
    }

    private String fallbackSkillName(Path file) {
        String name = file.getFileName().toString();
        if (name.endsWith(SKILL_FLAT_SUFFIX)) {
            return baseName(name, SKILL_FLAT_SUFFIX);
        }
        return name;
    }

    private String[] splitSkillDocument(String content) {
        if (content == null) {
            return null;
        }
        String[] lines = content.split("\\r?\\n", -1);
        if (lines.length == 0 || !"---".equals(lines[0].trim())) {
            return null;
        }
        StringBuilder frontmatter = new StringBuilder();
        for (int index = 1; index < lines.length; index++) {
            if ("---".equals(lines[index].trim())) {
                StringBuilder body = new StringBuilder();
                for (int rest = index + 1; rest < lines.length; rest++) {
                    body.append(lines[rest]);
                    if (rest + 1 < lines.length) {
                        body.append('\n');
                    }
                }
                return new String[]{frontmatter.toString(), body.toString()};
            }
            frontmatter.append(lines[index]).append('\n');
        }
        return null;
    }

    // ---------- 工具方法 ----------

    private void copyDirectory(Path source, Path target) throws IOException {
        try (var walk = Files.walk(source)) {
            walk.forEach(path -> {
                try {
                    Path relative = source.relativize(path);
                    Path dest = target.resolve(relative);
                    if (Files.isDirectory(path)) {
                        Files.createDirectories(dest);
                    } else {
                        ensureParentExists(dest);
                        Files.copy(path, dest,
                                StandardCopyOption.COPY_ATTRIBUTES);
                    }
                } catch (IOException exception) {
                    throw new UncheckedIOException(exception);
                }
            });
        }
    }

    private void deleteDirectory(Path directory) throws IOException {
        try (var walk = Files.walk(directory)) {
            walk.sorted((a, b) -> -a.compareTo(b))
                    .forEach(path -> {
                        try {
                            Files.deleteIfExists(path);
                        } catch (IOException exception) {
                            throw new UncheckedIOException(exception);
                        }
                    });
        }
    }

    private void ensureParentExists(Path path) throws IOException {
        Path parent = path.getParent();
        if (parent != null) {
            Files.createDirectories(parent);
        }
    }

    private void rescanRoots(Path... roots) {
        Set<Path> unique = java.util.Arrays.stream(roots)
                .map(p -> p.toAbsolutePath().normalize())
                .collect(java.util.HashSet::new, Set::add, Set::addAll);
        for (Path root : unique) {
            extensions.rescanRoot(root);
        }
    }

    private String normalizeCapabilityPath(String path) {
        if (path == null || path.isBlank() || "/".equals(path.trim())) {
            return "/";
        }
        String normalized = path.trim().replace('\\', '/');
        if (!normalized.startsWith("/")
                || normalized.endsWith("/")
                || normalized.contains("//")
                || normalized.contains("..")
                || !CAPABILITY_PATH.matcher(normalized).matches()) {
            throw badRequest("能力路径格式无效: " + path);
        }
        return normalized;
    }

    private ApiProblemException badRequest(String message) {
        return new ApiProblemException(HttpStatus.BAD_REQUEST,
                "invalid_request", "validation", message);
    }

    private ApiProblemException unprocessable(String message) {
        return new ApiProblemException(HttpStatus.UNPROCESSABLE_ENTITY,
                "not_file_truth", "capability", message);
    }

    private ApiProblemException conflict(String message) {
        return new ApiProblemException(HttpStatus.CONFLICT,
                "already_exists", "conflict", message);
    }

    private ApiProblemException outOfBounds(String path) {
        return new ApiProblemException(HttpStatus.FORBIDDEN,
                "out_of_extension_root", "security",
                "路径超出已登记拓展根范围: " + path);
    }

    public record OperationResult(
            String operation,
            String sourcePath,
            String targetDir,
            List<String> affectedPaths
    ) {
    }

    private record SourceFile(String capabilityPath, Path file) {
    }
}
