package com.iris.objective.system;

import com.fasterxml.jackson.databind.ObjectMapper;
import org.springframework.http.HttpStatus;
import org.springframework.http.MediaType;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.DeleteMapping;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.PutMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestHeader;
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
 * 技能 API（WonWork 契约形状 /api/skills*，对照 SkillsController.cs +
 * SkillStorageService.cs）。
 *
 * <p>数据源 = {@code ~/.wonwork/skills/<id>/SKILL.md}（目录格式）。单个技能的读写
 * 使用 text/markdown（SKILL.md）格式，列表返回 JSON 元数据。SKILL v2 frontmatter：
 * id/name/description/whenToUse/domain/keywords/version/author/icon/enabled/
 * userInvocable/installedAt/updatedAt/source。</p>
 */
@RestController
@RequestMapping("/api/skills")
public class SkillsApiController {

    private static final ObjectMapper JSON = new ObjectMapper();
    private static final long MAX_SKILL_BYTES = 128 * 1024;
    private static final Pattern FRONTMATTER =
            Pattern.compile("^---\\s*\n([\\s\\S]*?)\n---\\s*\n?([\\s\\S]*)$");
    private static final MediaType MARKDOWN =
            MediaType.parseMediaType("text/markdown;charset=UTF-8");

    private final Path skillsDir;

    public SkillsApiController(UserHomeService userHome) {
        this.skillsDir = userHome.skillsDir();
    }

    /** GET /api/skills —— 技能清单（JSON 元数据，按 name 排序）。 */
    @GetMapping
    public List<Map<String, Object>> list() {
        List<Map<String, Object>> skills = new ArrayList<>();
        if (!Files.isDirectory(skillsDir)) {
            return skills;
        }
        try (Stream<Path> dirs = Files.list(skillsDir)) {
            for (Path dir : dirs.filter(Files::isDirectory).toList()) {
                Path skillFile = dir.resolve("SKILL.md");
                if (!Files.isRegularFile(skillFile)
                        || Files.size(skillFile) > MAX_SKILL_BYTES) {
                    continue;
                }
                Map<String, Object> manifest = parseSkillMd(
                        Files.readString(skillFile, StandardCharsets.UTF_8),
                        dir.getFileName().toString());
                if (manifest != null) {
                    skills.add(manifest);
                }
            }
        } catch (IOException e) {
            throw new ResponseStatusException(
                    HttpStatus.INTERNAL_SERVER_ERROR, "读取技能目录失败: " + e.getMessage(), e);
        }
        skills.sort(Comparator.comparing(s -> String.valueOf(s.get("name"))));
        return skills;
    }

    /** GET /api/skills/dir —— 技能根目录绝对路径。 */
    @GetMapping("/dir")
    public Map<String, String> dir() {
        return Map.of("dir", skillsDir.toString());
    }

    /** GET /api/skills/{id} —— Accept: text/markdown 时回原文，否则回 JSON manifest。 */
    @GetMapping("/{id}")
    public ResponseEntity<?> get(
            @PathVariable String id,
            @RequestHeader(value = "Accept", required = false) String accept
    ) {
        Path skillFile = skillFile(id);
        if (!Files.isRegularFile(skillFile)) {
            throw new ResponseStatusException(
                    HttpStatus.NOT_FOUND, "Skill '" + id + "' not found.");
        }
        try {
            String text = Files.readString(skillFile, StandardCharsets.UTF_8);
            if (wantsMarkdown(accept)) {
                return ResponseEntity.ok().contentType(MARKDOWN).body(text);
            }
            Map<String, Object> manifest = parseSkillMd(text, id);
            if (manifest == null) {
                throw new ResponseStatusException(
                        HttpStatus.NOT_FOUND, "Skill '" + id + "' not found.");
            }
            return ResponseEntity.ok(manifest);
        } catch (IOException e) {
            throw new ResponseStatusException(
                    HttpStatus.INTERNAL_SERVER_ERROR, "读取技能失败: " + e.getMessage(), e);
        }
    }

    /** PUT /api/skills/{id} —— 写技能（text/markdown 原文直存；JSON manifest 序列化）。 */
    @PutMapping("/{id}")
    public Map<String, Object> update(
            @PathVariable String id,
            @RequestBody String body,
            @RequestHeader(value = "Content-Type", required = false) String contentType
    ) {
        String markdown;
        Map<String, Object> manifest;
        if (contentType != null
                && contentType.toLowerCase().startsWith("application/json")) {
            manifest = parseJsonManifest(body);
            String manifestId = String.valueOf(manifest.getOrDefault("id", ""));
            if (!id.equals(manifestId)) {
                throw new ResponseStatusException(HttpStatus.BAD_REQUEST, "Skill id mismatch.");
            }
            manifest.put("updatedAt", Instant.now().toString());
            markdown = serializeToMarkdown(manifest);
        } else {
            manifest = parseSkillMd(body, "");
            if (manifest == null) {
                throw new ResponseStatusException(
                        HttpStatus.BAD_REQUEST, "Failed to parse SKILL.md frontmatter.");
            }
            // markdown 原文直存，保留用户排版
            markdown = body;
        }
        saveSkill(id, markdown);
        // 回读解析（markdown 直存时 manifest 以解析结果为准，installedAt/updatedAt 沿用 frontmatter）
        Map<String, Object> stored = parseSkillMd(markdown, id);
        return stored != null ? stored : manifest;
    }

    /** DELETE /api/skills/{id} —— 删除技能目录（递归）。 */
    @DeleteMapping("/{id}")
    public ResponseEntity<Void> delete(@PathVariable String id) {
        Path dir = safeSkillDir(id);
        if (!Files.isDirectory(dir)) {
            throw new ResponseStatusException(
                    HttpStatus.NOT_FOUND, "Skill '" + id + "' not found.");
        }
        deleteRecursively(dir);
        return ResponseEntity.noContent().build();
    }

    /** POST /api/skills/import —— 导入：JSON SkillPackage {manifest,schemaVersion} 或 SKILL.md 文本。 */
    @PostMapping("/import")
    public Map<String, Object> importSkill(
            @RequestBody String body,
            @RequestHeader(value = "Content-Type", required = false) String contentType
    ) {
        Map<String, Object> manifest;
        if (contentType != null
                && contentType.toLowerCase().startsWith("application/json")) {
            try {
                var node = JSON.readTree(body);
                var manifestNode = node.has("manifest") ? node.get("manifest") : node;
                manifest = JSON.convertValue(manifestNode, Map.class);
            } catch (Exception e) {
                throw new ResponseStatusException(
                        HttpStatus.BAD_REQUEST, "Invalid skill package.");
            }
            if (manifest == null
                    || String.valueOf(manifest.getOrDefault("id", "")).isBlank()) {
                throw new ResponseStatusException(
                        HttpStatus.BAD_REQUEST, "Invalid skill package.");
            }
            manifest.put("installedAt", Instant.now().toString());
            manifest.put("updatedAt", manifest.get("installedAt"));
            String id = String.valueOf(manifest.get("id"));
            saveSkill(id, serializeToMarkdown(manifest));
            Map<String, Object> stored = parseSkillMd(serializeToMarkdown(manifest), id);
            return stored != null ? stored : manifest;
        }
        manifest = parseSkillMd(body, "");
        if (manifest == null) {
            throw new ResponseStatusException(
                    HttpStatus.BAD_REQUEST, "Invalid SKILL.md.");
        }
        String id = String.valueOf(manifest.getOrDefault("id", ""));
        if (id.isBlank()) {
            throw new ResponseStatusException(HttpStatus.BAD_REQUEST, "Skill id is required.");
        }
        saveSkill(id, body);
        Map<String, Object> stored = parseSkillMd(body, id);
        return stored != null ? stored : manifest;
    }

    // ---------- 解析与序列化（对照 SkillStorageService.ParseSkillMd / SerializeFrontmatter） ----------

    /** 解析 SKILL.md 为 manifest Map；无 frontmatter 返回 null。 */
    private Map<String, Object> parseSkillMd(String text, String dirName) {
        // 剥 BOM（带 BOM 的文件 ^--- 匹配不到）
        if (text.startsWith("﻿")) {
            text = text.substring(1);
        }
        Matcher m = FRONTMATTER.matcher(text);
        if (!m.matches()) {
            return null;
        }
        Map<String, Object> fm = parseYamlFrontmatter(m.group(1));
        String body = m.group(2).trim();
        Map<String, Object> manifest = new LinkedHashMap<>();
        String now = Instant.now().toString();
        manifest.put("id", stringOr(fm.get("id"), dirName));
        manifest.put("name", stringOr(fm.get("name"), dirName));
        manifest.put("description", stringOr(fm.get("description"), ""));
        manifest.put("whenToUse", stringOr(fm.get("whenToUse"), ""));
        manifest.put("domain", stringOr(fm.get("domain"), "general"));
        Object keywords = fm.get("keywords");
        manifest.put("keywords", keywords instanceof List<?> list ? list : List.of());
        manifest.put("version", stringOr(fm.get("version"), "1.0.0"));
        manifest.put("author", stringOr(fm.get("author"), "User"));
        manifest.put("icon", stringOr(fm.get("icon"), "Puzzle"));
        manifest.put("prompt", body);
        // 缺省启用/可调用：只有显式 false 才关闭
        manifest.put("enabled", boolOr(fm.get("enabled"), true));
        manifest.put("userInvocable", boolOr(fm.get("userInvocable"), true));
        manifest.put("installedAt", stringOr(fm.get("installedAt"), now));
        manifest.put("updatedAt", stringOr(fm.get("updatedAt"), now));
        manifest.put("source", stringOr(fm.get("source"), "local"));
        return manifest;
    }

    /** 平铺 YAML frontmatter 解析（对照 ParseScalarValue：bool/数组/引号）。 */
    private Map<String, Object> parseYamlFrontmatter(String yaml) {
        Map<String, Object> result = new LinkedHashMap<>();
        for (String line : yaml.split("\n")) {
            if (line.isBlank()) {
                continue;
            }
            int colon = line.indexOf(':');
            if (colon <= 0) {
                continue;
            }
            String key = line.substring(0, colon).trim();
            String value = line.substring(colon + 1).trim();
            result.put(key, parseScalar(value));
        }
        return result;
    }

    private Object parseScalar(String value) {
        if (value.equals("true")) {
            return true;
        }
        if (value.equals("false")) {
            return false;
        }
        if (value.equals("null") || value.equals("~")) {
            return null;
        }
        if (value.equals("[]")) {
            return List.of();
        }
        if (value.startsWith("\"") && value.endsWith("\"") && value.length() >= 2) {
            // 双引号反转义（先 \" 后 \\，与 YamlValue 转义对偶）
            String inner = value.substring(1, value.length() - 1);
            return inner.replace("\\\"", "\"").replace("\\\\", "\\");
        }
        if (value.startsWith("'") && value.endsWith("'") && value.length() >= 2) {
            return value.substring(1, value.length() - 1);
        }
        if (value.startsWith("[") && value.endsWith("]")) {
            String inner = value.substring(1, value.length() - 1).trim();
            if (inner.isEmpty()) {
                return List.of();
            }
            List<String> items = new ArrayList<>();
            for (String part : inner.split(",")) {
                String trimmed = part.trim();
                if (!trimmed.isEmpty()) {
                    items.add(trimmed);
                }
            }
            return items;
        }
        return value;
    }

    /** manifest 序列化为 SKILL.md（对照 SerializeFrontmatter）。 */
    private String serializeToMarkdown(Map<String, Object> skill) {
        StringBuilder fm = new StringBuilder();
        fm.append("id: ").append(skill.get("id")).append('\n');
        fm.append("name: ").append(yamlValue(stringOr(skill.get("name"), ""))).append('\n');
        fm.append("description: ")
                .append(yamlValue(stringOr(skill.get("description"), ""))).append('\n');
        String whenToUse = stringOr(skill.get("whenToUse"), "");
        if (!whenToUse.isEmpty()) {
            fm.append("whenToUse: ").append(yamlValue(whenToUse)).append('\n');
        }
        fm.append("domain: ").append(stringOr(skill.get("domain"), "general")).append('\n');
        Object keywords = skill.get("keywords");
        if (keywords instanceof List<?> list && !list.isEmpty()) {
            fm.append("keywords: ").append(yamlArrayValue(list)).append('\n');
        }
        fm.append("version: ").append(yamlValue(stringOr(skill.get("version"), "1.0.0"))).append('\n');
        fm.append("author: ").append(yamlValue(stringOr(skill.get("author"), "User"))).append('\n');
        fm.append("icon: ").append(stringOr(skill.get("icon"), "Puzzle")).append('\n');
        fm.append("enabled: ").append(boolOr(skill.get("enabled"), true)).append('\n');
        if (!boolOr(skill.get("userInvocable"), true)) {
            fm.append("userInvocable: false").append('\n');
        }
        fm.append("installedAt: ").append(stringOr(skill.get("installedAt"), Instant.now().toString())).append('\n');
        fm.append("updatedAt: ").append(stringOr(skill.get("updatedAt"), Instant.now().toString())).append('\n');
        fm.append("source: ").append(stringOr(skill.get("source"), "local")).append('\n');
        return "---\n" + fm + "---\n\n" + stringOr(skill.get("prompt"), "");
    }

    private String yamlValue(String value) {
        if (value == null || value.isEmpty()) {
            return "\"\"";
        }
        if (value.contains("\n") || value.contains(":") || value.contains("#")
                || value.contains("\"") || value.contains("'") || value.contains(",")
                || value.equals("true") || value.equals("false")
                || value.startsWith("[") || value.startsWith("\"") || value.startsWith("'")) {
            return "\"" + value.replace("\\", "\\\\").replace("\"", "\\\"") + "\"";
        }
        return value;
    }

    private String yamlArrayValue(List<?> values) {
        if (values.isEmpty()) {
            return "[]";
        }
        StringBuilder sb = new StringBuilder("[");
        for (int i = 0; i < values.size(); i++) {
            if (i > 0) {
                sb.append(", ");
            }
            sb.append(yamlValue(String.valueOf(values.get(i))));
        }
        return sb.append(']').toString();
    }

    // ---------- 存储 ----------

    private void saveSkill(String id, String markdown) {
        Path dir = safeSkillDir(id);
        try {
            Files.createDirectories(dir);
            Files.writeString(dir.resolve("SKILL.md"), markdown, StandardCharsets.UTF_8);
        } catch (IOException e) {
            throw new ResponseStatusException(
                    HttpStatus.INTERNAL_SERVER_ERROR, "保存技能失败: " + e.getMessage(), e);
        }
    }

    /**
     * id 安全闸（对照 SkillStorageService.GetSafeSkillDir）：拒绝空白/路径穿越/分隔符/
     * 盘符，并二次校验解析结果落在技能根目录内。
     */
    private Path safeSkillDir(String id) {
        if (id == null || id.isBlank()
                || id.contains("..") || id.contains("/") || id.contains("\\")) {
            throw new ResponseStatusException(HttpStatus.BAD_REQUEST, "非法技能 id: " + id);
        }
        Path dir = skillsDir.resolve(id).normalize().toAbsolutePath();
        if (!dir.startsWith(skillsDir.toAbsolutePath())) {
            throw new ResponseStatusException(HttpStatus.BAD_REQUEST, "非法技能 id: " + id);
        }
        return dir;
    }

    private Path skillFile(String id) {
        return safeSkillDir(id).resolve("SKILL.md");
    }

    private void deleteRecursively(Path dir) {
        try (Stream<Path> walk = Files.walk(dir)) {
            for (Path p : walk.sorted(Comparator.reverseOrder()).toList()) {
                Files.delete(p);
            }
        } catch (IOException e) {
            throw new ResponseStatusException(
                    HttpStatus.INTERNAL_SERVER_ERROR, "删除技能失败: " + e.getMessage(), e);
        }
    }

    // ---------- 辅助 ----------

    private boolean wantsMarkdown(String accept) {
        if (accept == null || accept.isBlank()) {
            return true;
        }
        return !accept.contains("application/json");
    }

    @SuppressWarnings("unchecked")
    private Map<String, Object> parseJsonManifest(String body) {
        try {
            Map<String, Object> manifest = JSON.readValue(body, Map.class);
            if (manifest == null) {
                throw new ResponseStatusException(
                        HttpStatus.BAD_REQUEST, "Failed to parse JSON skill manifest.");
            }
            return manifest;
        } catch (ResponseStatusException e) {
            throw e;
        } catch (Exception e) {
            throw new ResponseStatusException(
                    HttpStatus.BAD_REQUEST, "Failed to parse JSON skill manifest.");
        }
    }

    private String stringOr(Object value, String fallback) {
        return value == null ? fallback : String.valueOf(value);
    }

    private boolean boolOr(Object value, boolean fallback) {
        if (value instanceof Boolean b) {
            return b;
        }
        if (value instanceof String s) {
            return Boolean.parseBoolean(s);
        }
        return fallback;
    }
}
