package com.iris.objective.system;

import org.springframework.http.HttpStatus;
import org.springframework.http.ResponseEntity;
import org.springframework.jdbc.core.simple.JdbcClient;
import org.springframework.web.bind.annotation.DeleteMapping;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.PutMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RestController;
import org.springframework.web.server.ResponseStatusException;

import java.time.Instant;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

/**
 * 快捷指令收藏 API（WonWork 契约形状 /api/favorite，对照 FavoriteController.cs）。
 *
 * <p>数据源 = favorite 表（SQLite 单用户本地；WonWork 按 userId+systemCode 分区，
 * Iris 省略——前端 FavoriteItem 的 userId/systemCode 字段回常量占位）。形状对齐
 * WonWork：GET 返回 FavoriteItem[]；POST 回 {id,title,prompt}；PUT/DELETE 204。</p>
 */
@RestController
@RequestMapping("/api/favorite")
public class FavoriteApiController {

    /** WonWork FavoriteItem.userId 是 long，本地单用户固定 1。 */
    private static final long LOCAL_USER_ID = 1L;
    /** WonWork FavoriteItem.systemCode 分区在 Iris 无对应物，回空串占位。 */
    private static final String LOCAL_SYSTEM_CODE = "";

    private final JdbcClient jdbc;

    public FavoriteApiController(JdbcClient jdbc) {
        this.jdbc = jdbc;
    }

    /** GET /api/favorite —— 全部收藏（按创建时间升序）。 */
    @GetMapping
    public List<Map<String, Object>> getFavorites() {
        return jdbc.sql("SELECT id, title, prompt, created_at, updated_at"
                        + " FROM favorite ORDER BY created_at, id")
                .query((rs, rowNum) -> toItem(
                        rs.getLong("id"),
                        rs.getString("title"),
                        rs.getString("prompt"),
                        rs.getString("created_at"),
                        rs.getString("updated_at")))
                .list();
    }

    /** POST /api/favorite —— 新增（标题/内容空则 400，对齐 WonWork BadRequest）。 */
    @PostMapping
    public Map<String, Object> addFavorite(@RequestBody FavoriteRequest request) {
        if (request == null || isBlank(request.title()) || isBlank(request.prompt())) {
            throw new ResponseStatusException(
                    HttpStatus.BAD_REQUEST, "标题和指令内容不能为空");
        }
        Instant now = Instant.now();
        jdbc.sql("INSERT INTO favorite(title, prompt, created_at, updated_at)"
                        + " VALUES (:title, :prompt, :now, :now)")
                .param("title", request.title().trim())
                .param("prompt", request.prompt())
                .param("now", now.toString())
                .update();
        Long id = jdbc.sql("SELECT last_insert_rowid()")
                .query(Long.class)
                .single();
        // WonWork POST 回 {Id,Title,Prompt}
        Map<String, Object> m = new LinkedHashMap<>();
        m.put("id", id);
        m.put("title", request.title().trim());
        m.put("prompt", request.prompt());
        return m;
    }

    /** PUT /api/favorite/{id} —— 更新（不存在 404，对齐 WonWork NotFound）。 */
    @PutMapping("/{id}")
    public ResponseEntity<Void> updateFavorite(
            @PathVariable long id,
            @RequestBody FavoriteRequest request
    ) {
        if (request == null || isBlank(request.title()) || isBlank(request.prompt())) {
            throw new ResponseStatusException(
                    HttpStatus.BAD_REQUEST, "标题和指令内容不能为空");
        }
        int updated = jdbc.sql("UPDATE favorite SET title = :title,"
                        + " prompt = :prompt, updated_at = :now WHERE id = :id")
                .param("title", request.title().trim())
                .param("prompt", request.prompt())
                .param("now", Instant.now().toString())
                .param("id", id)
                .update();
        if (updated != 1) {
            throw new ResponseStatusException(
                    HttpStatus.NOT_FOUND, "快捷指令不存在或无权修改");
        }
        return ResponseEntity.noContent().build();
    }

    /** DELETE /api/favorite/{id} —— 删除（WonWork 不管存在与否都 204，幂等）。 */
    @DeleteMapping("/{id}")
    public ResponseEntity<Void> deleteFavorite(@PathVariable long id) {
        jdbc.sql("DELETE FROM favorite WHERE id = :id")
                .param("id", id)
                .update();
        return ResponseEntity.noContent().build();
    }

    private Map<String, Object> toItem(
            long id, String title, String prompt, String createdAt, String updatedAt) {
        Map<String, Object> m = new LinkedHashMap<>();
        m.put("id", id);
        m.put("userId", LOCAL_USER_ID);
        m.put("title", title);
        m.put("prompt", prompt);
        m.put("systemCode", LOCAL_SYSTEM_CODE);
        m.put("createdAt", createdAt);
        m.put("updatedAt", updatedAt);
        return m;
    }

    private static boolean isBlank(String s) {
        return s == null || s.trim().isEmpty();
    }

    public record FavoriteRequest(String title, String prompt) { }
}
