package com.iris.objective.system;

import org.springframework.http.HttpStatus;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.DeleteMapping;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.PutMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RestController;
import org.springframework.web.server.ResponseStatusException;

import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.time.Instant;
import java.util.ArrayList;
import java.util.Comparator;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.regex.Matcher;
import java.util.regex.Pattern;
import java.util.stream.Stream;

/**
 * 文件级记忆 API（WonWork 契约形状 /api/usermemory/*，对照 UserMemoryController.cs +
 * UserMemoryService.cs）。
 *
 * <p>数据源 = {@code ~/.wonwork/memory/} 下的 .md 文件（对齐 claude-code memdir）：
 * MEMORY.md 是索引（200 行/25KB 上限，超出截断+警告），每条记忆一个 topic 文件
 * （frontmatter: name/description/type），可放子目录（递归扫描）。</p>
 */
@RestController
@RequestMapping("/api/usermemory")
public class UserMemoryApiController {

    private static final int MAX_INDEX_LINES = 200;
    private static final int MAX_INDEX_BYTES = 25_000;
    private static final int MAX_MEMORY_FILES = 200;
    private static final int FRONTMATTER_MAX_LINES = 30;
    private static final Pattern FRONTMATTER =
            Pattern.compile("^---\\s*\n([\\s\\S]*?)\n---\\s*\n?([\\s\\S]*)$");

    private final Path memoryDir;
    private final Path indexPath;

    public UserMemoryApiController(UserHomeService userHome) {
        this.memoryDir = userHome.memoryDir();
        this.indexPath = memoryDir.resolve("MEMORY.md");
    }

    /** GET /api/usermemory/index —— 读 MEMORY.md 索引（系统提示词注入用）。 */
    @GetMapping("/index")
    public Map<String, Object> getIndex() {
        return Map.of("content", readIndex(), "path", indexPath.toString());
    }

    /** PUT /api/usermemory/index —— 写 MEMORY.md 索引。 */
    @PutMapping("/index")
    public ResponseEntity<Void> putIndex(@RequestBody ContentRequest request) {
        if (request == null || request.content() == null) {
            throw new ResponseStatusException(HttpStatus.BAD_REQUEST, "content 不能为空");
        }
        try {
            Files.createDirectories(memoryDir);
            Files.writeString(indexPath, request.content(), StandardCharsets.UTF_8);
        } catch (IOException e) {
            throw new ResponseStatusException(
                    HttpStatus.INTERNAL_SERVER_ERROR, "写入索引失败: " + e.getMessage(), e);
        }
        return ResponseEntity.noContent().build();
    }

    /** GET /api/usermemory/files —— 扫描全部记忆文件（清单+frontmatter）。 */
    @GetMapping("/files")
    public List<Map<String, Object>> listFiles() {
        List<Map<String, Object>> results = new ArrayList<>();
        if (!Files.isDirectory(memoryDir)) {
            return results;
        }
        try (Stream<Path> walk = Files.walk(memoryDir)) {
            List<Path> files = walk
                    .filter(Files::isRegularFile)
                    .filter(p -> p.getFileName().toString().endsWith(".md"))
                    .filter(p -> !p.getFileName().toString()
                            .equalsIgnoreCase("MEMORY.md"))
                    .sorted(Comparator.comparing(
                            this::lastModified, Comparator.reverseOrder()))
                    .limit(MAX_MEMORY_FILES)
                    .toList();
            for (Path file : files) {
                Map<String, Object> entry = parseMemoryFile(file);
                if (entry != null) {
                    results.add(entry);
                }
            }
        } catch (IOException e) {
            throw new ResponseStatusException(
                    HttpStatus.INTERNAL_SERVER_ERROR, "扫描记忆目录失败: " + e.getMessage(), e);
        }
        return results;
    }

    /** GET /api/usermemory/files/{*path} —— 读单条记忆全文。 */
    @GetMapping("/files/{*path}")
    public Map<String, Object> getFile(@PathVariable String path) {
        Path fullPath = safePath(path);
        if (fullPath == null || !Files.isRegularFile(fullPath)) {
            throw new ResponseStatusException(
                    HttpStatus.NOT_FOUND, "记忆文件 '" + path + "' 不存在");
        }
        try {
            return Map.of(
                    "path", path,
                    "content", Files.readString(fullPath, StandardCharsets.UTF_8));
        } catch (IOException e) {
            throw new ResponseStatusException(
                    HttpStatus.INTERNAL_SERVER_ERROR, "读取记忆失败: " + e.getMessage(), e);
        }
    }

    /** PUT /api/usermemory/files/{*path} —— 写单条记忆（两步走第一步）。 */
    @PutMapping("/files/{*path}")
    public Map<String, Object> putFile(
            @PathVariable String path,
            @RequestBody ContentRequest request
    ) {
        if (request == null || request.content() == null || request.content().isBlank()) {
            throw new ResponseStatusException(HttpStatus.BAD_REQUEST, "content 不能为空");
        }
        Path fullPath = safePath(path);
        if (fullPath == null) {
            throw new ResponseStatusException(HttpStatus.BAD_REQUEST, "路径非法");
        }
        try {
            Files.createDirectories(fullPath.getParent());
            Files.writeString(fullPath, request.content(), StandardCharsets.UTF_8);
        } catch (IOException e) {
            throw new ResponseStatusException(
                    HttpStatus.INTERNAL_SERVER_ERROR, "写入记忆失败: " + e.getMessage(), e);
        }
        return Map.of("path", path, "fullPath", fullPath.toString());
    }

    /** DELETE /api/usermemory/files/{*path} —— 删单条记忆。 */
    @DeleteMapping("/files/{*path}")
    public ResponseEntity<Void> deleteFile(@PathVariable String path) {
        Path fullPath = safePath(path);
        if (fullPath == null || !Files.isRegularFile(fullPath)) {
            throw new ResponseStatusException(
                    HttpStatus.NOT_FOUND, "记忆文件 '" + path + "' 不存在");
        }
        try {
            Files.delete(fullPath);
        } catch (IOException e) {
            throw new ResponseStatusException(
                    HttpStatus.INTERNAL_SERVER_ERROR, "删除记忆失败: " + e.getMessage(), e);
        }
        return ResponseEntity.noContent().build();
    }

    /** 读取索引内容（不存在返回空串，超限截断+警告，对齐 WonWork TruncateIndex）。 */
    private String readIndex() {
        if (!Files.exists(indexPath)) {
            return "";
        }
        try {
            return truncateIndex(Files.readString(indexPath, StandardCharsets.UTF_8));
        } catch (IOException e) {
            return "";
        }
    }

    private String truncateIndex(String content) {
        String[] lines = content.split("\n", -1);
        if (lines.length <= MAX_INDEX_LINES
                && content.getBytes(StandardCharsets.UTF_8).length <= MAX_INDEX_BYTES) {
            return content;
        }
        StringBuilder truncated = new StringBuilder();
        int limit = Math.min(lines.length, MAX_INDEX_LINES);
        for (int i = 0; i < limit; i++) {
            if (i > 0) {
                truncated.append('\n');
            }
            truncated.append(lines[i]);
        }
        while (truncated.toString().getBytes(StandardCharsets.UTF_8).length
                > MAX_INDEX_BYTES) {
            int lastNewline = truncated.lastIndexOf("\n");
            if (lastNewline <= 0) {
                break;
            }
            truncated.delete(lastNewline, truncated.length());
        }
        return truncated
                + "\n\n> WARNING: MEMORY.md 超出限制（200行/25KB），只加载了部分内容。请精简索引。\n";
    }

    /** 解析记忆文件 frontmatter（name/description/type）；无 frontmatter 的 .md 也能用。 */
    private Map<String, Object> parseMemoryFile(Path file) {
        try {
            String text = Files.readString(file, StandardCharsets.UTF_8);
            String relative = memoryDir.relativize(file).toString().replace('\\', '/');
            Map<String, Object> entry = new LinkedHashMap<>();
            entry.put("relativePath", relative);
            entry.put("lastModified", lastModified(file).toString());
            Matcher m = FRONTMATTER.matcher(text);
            if (!m.matches()) {
                entry.put("name", stripExtension(file.getFileName().toString()));
                entry.put("description", "");
                entry.put("type", "");
                entry.put("content", text.trim());
                return entry;
            }
            Map<String, String> fm = parseSimpleYaml(m.group(1));
            entry.put("name", fm.getOrDefault(
                    "name", stripExtension(file.getFileName().toString())));
            entry.put("description", fm.getOrDefault("description", ""));
            entry.put("type", fm.getOrDefault("type", ""));
            entry.put("content", m.group(2).trim());
            return entry;
        } catch (IOException e) {
            return null;
        }
    }

    /** 极简 YAML frontmatter 解析（只取平铺 key: value，前 30 行）。 */
    private Map<String, String> parseSimpleYaml(String yaml) {
        Map<String, String> result = new LinkedHashMap<>();
        String[] lines = yaml.split("\n");
        for (int i = 0; i < Math.min(lines.length, FRONTMATTER_MAX_LINES); i++) {
            String line = lines[i];
            if (line.isBlank()) {
                continue;
            }
            int colon = line.indexOf(':');
            if (colon <= 0) {
                continue;
            }
            String key = line.substring(0, colon).trim();
            String value = line.substring(colon + 1).trim()
                    .replaceAll("^\"(.*)\"$", "$1")
                    .replaceAll("^'(.*)'$", "$1");
            result.put(key.toLowerCase(), value);
        }
        return result;
    }

    /** 路径安全：相对路径必须落在 memory/ 根内，防路径穿越。 */
    private Path safePath(String relativePath) {
        if (relativePath == null || relativePath.isBlank()) {
            return null;
        }
        if (relativePath.contains("..")) {
            return null;
        }
        Path fullPath = memoryDir.resolve(relativePath).normalize().toAbsolutePath();
        if (!fullPath.startsWith(memoryDir.toAbsolutePath())) {
            return null;
        }
        return fullPath;
    }

    private Instant lastModified(Path file) {
        try {
            return Files.getLastModifiedTime(file).toInstant();
        } catch (IOException e) {
            return Instant.EPOCH;
        }
    }

    private String stripExtension(String fileName) {
        int dot = fileName.lastIndexOf('.');
        return dot > 0 ? fileName.substring(0, dot) : fileName;
    }

    public record ContentRequest(String content) {}
}
