package com.iris.objective.system;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import org.springframework.http.HttpStatus;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PutMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RestController;
import org.springframework.web.server.ResponseStatusException;

import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.HashMap;
import java.util.Map;

/**
 * 模型供应商配置 /api/providerprofiles（WonWork 契约形状，对照
 * ProviderProfilesController.cs，docs/46）。
 *
 * <p>数据源 = {@code ~/.wonwork/providers.json}；后端只存取文本原文，schema 归前端
 * （types/providerProfile.ts）。GET 读原文（不存在则 content=null），PUT 整段覆写
 * （仅校验是合法 JSON 对象），成功返回 204 No Content。纯文件读写，不做任何编排。</p>
 */
@RestController
@RequestMapping("/api/providerprofiles")
public class ProviderProfilesApiController {

    private static final ObjectMapper JSON = new ObjectMapper();

    private final Path profilesFile;

    public ProviderProfilesApiController(UserHomeService userHome) {
        this.profilesFile = userHome.providersFile();
    }

    /** GET /api/providerprofiles —— 读 providers.json 原文（不存在 content=null）。 */
    @GetMapping
    public Map<String, Object> get() {
        Map<String, Object> result = new HashMap<>();
        result.put("path", profilesFile.toString());
        if (!Files.exists(profilesFile)) {
            result.put("content", null);
            return result;
        }
        try {
            result.put("content", Files.readString(profilesFile, StandardCharsets.UTF_8));
        } catch (IOException e) {
            throw new ResponseStatusException(
                    HttpStatus.INTERNAL_SERVER_ERROR, "读取 providers.json 失败: " + e.getMessage(), e);
        }
        return result;
    }

    /** PUT /api/providerprofiles —— 整段覆写（仅校验是合法 JSON 对象），204 无内容。 */
    @PutMapping
    public ResponseEntity<Void> put(@RequestBody PutRequest request) {
        if (request == null || request.content() == null || request.content().isBlank()) {
            throw new ResponseStatusException(HttpStatus.BAD_REQUEST, "content 不能为空");
        }
        String content = request.content();
        try {
            JsonNode node = JSON.readTree(content);
            if (node == null || !node.isObject()) {
                throw new ResponseStatusException(HttpStatus.BAD_REQUEST, "content 必须是 JSON 对象");
            }
        } catch (ResponseStatusException e) {
            throw e;
        } catch (Exception e) {
            throw new ResponseStatusException(HttpStatus.BAD_REQUEST, "content 不是合法 JSON");
        }
        try {
            // UTF-8 无 BOM（Files.writeString 默认不写 BOM），与 memory/skills 文件化同一约定
            Files.createDirectories(profilesFile.getParent());
            Files.writeString(profilesFile, content, StandardCharsets.UTF_8);
        } catch (IOException e) {
            throw new ResponseStatusException(
                    HttpStatus.INTERNAL_SERVER_ERROR, "写入 providers.json 失败: " + e.getMessage(), e);
        }
        return ResponseEntity.noContent().build();
    }

    public record PutRequest(String content) {}
}
