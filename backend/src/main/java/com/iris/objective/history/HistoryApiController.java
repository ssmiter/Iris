package com.iris.objective.history;

import com.iris.conversation.application.ConversationCommandService;
import com.iris.conversation.application.ConversationQueryService;
import com.iris.conversation.domain.ConversationCommands.CreateConversationRequest;
import com.iris.conversation.domain.ConversationCommands.CreateConversationResponse;
import com.iris.conversation.domain.ConversationViews.ArchiveConversationRequest;
import com.iris.conversation.domain.ConversationViews.ConversationPage;
import com.iris.conversation.domain.ConversationViews.ConversationSummary;
import com.iris.conversation.domain.ConversationViews.ConversationView;
import com.iris.conversation.domain.ConversationViews.RenameConversationRequest;
import com.iris.conversation.domain.ConversationViews.TurnView;
import com.iris.conversation.infrastructure.ConversationQueryRepository;
import org.springframework.http.HttpStatus;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.DeleteMapping;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.PutMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RequestParam;
import org.springframework.web.bind.annotation.RestController;
import org.springframework.web.server.ResponseStatusException;
import org.springframework.jdbc.core.simple.JdbcClient;
import reactor.core.publisher.Mono;
import reactor.core.scheduler.Schedulers;

import java.util.List;
import java.util.LinkedHashMap;
import java.util.Map;
import java.util.UUID;
import java.sql.Types;

/**
 * 会话历史 API（WonWork 契约形状 /api/history/*，docs/46）。
 *
 * <p>SQLite 权威的会话/消息 CRUD。只读写事实，不做任何编排。
 * 与 /api/v1/conversations 的差异：本端点是 WonWork 前端平铺形状
 * （数值型路径段实为 Iris 的字符串 conversationId，前端只当不透明 id 使用）。</p>
 */
@RestController
@RequestMapping("/api/history")
public class HistoryApiController {

    private final ConversationCommandService commands;
    private final ConversationQueryService queries;
    private final ConversationQueryRepository queryRepository;
    private final HistoryMessageService messages;
    private final JdbcClient jdbc;

    public HistoryApiController(
            ConversationCommandService commands,
            ConversationQueryService queries,
            ConversationQueryRepository queryRepository,
            HistoryMessageService messages,
            JdbcClient jdbc
    ) {
        this.commands = commands;
        this.queries = queries;
        this.queryRepository = queryRepository;
        this.messages = messages;
        this.jdbc = jdbc;
    }

    /** GET /api/history?page=&pageSize= —— 全量列表（WonWork 侧栏不分页）。 */
    @GetMapping
    public Mono<List<Map<String, Object>>> list(
            @RequestParam(value = "page", required = false) Integer page,
            @RequestParam(value = "pageSize", defaultValue = "500") int pageSize
    ) {
        return queries.list(null, pageSize).map(resultPage -> resultPage.items().stream()
                .map(this::toFrontendConversation)
                .toList());
    }

    /** POST /api/history —— 创建会话。 */
    @PostMapping
    public Mono<ResponseEntity<Map<String, Object>>> create(
            @RequestBody(required = false) CreateHistoryRequest request
    ) {
        CreateConversationRequest safe = new CreateConversationRequest(
                request == null ? null : request.title());
        return Mono.fromCallable(() -> {
                    String title = request == null ? null : request.title();
                    return new CreatedWithTitle(
                            commands.createConversation("history-" + UUID.randomUUID(), safe),
                            title == null || title.isBlank() ? "新对话" : title.trim(),
                            java.time.Instant.now());
                })
                .subscribeOn(Schedulers.boundedElastic())
                .map(this::createdView);
    }

    /** GET /api/history/{conversationId} —— 单会话摘要。 */
    @GetMapping("/{conversationId}")
    public Mono<Map<String, Object>> get(@PathVariable String conversationId) {
        return Mono.fromCallable(() -> toFrontendConversation(queryRepository.summary(conversationId)))
                .subscribeOn(Schedulers.boundedElastic());
    }

    /** PUT /api/history/{conversationId} —— 重命名。 */
    @PutMapping("/{conversationId}")
    public Mono<Void> rename(
            @PathVariable String conversationId,
            @RequestBody RenameRequest request
    ) {
        return Mono.fromRunnable(() -> {
                    ConversationSummary current = queryRepository.summary(conversationId);
                    commands.renameConversation(
                            conversationId,
                            "history-rename-" + UUID.randomUUID(),
                            new RenameConversationRequest(current.version(), request.title())
                    );
                })
                .subscribeOn(Schedulers.boundedElastic())
                .then();
    }

    /** DELETE /api/history/{conversationId} —— 删除会话（含消息/turn）。 */
    @DeleteMapping("/{conversationId}")
    public Mono<Void> delete(@PathVariable String conversationId) {
        return Mono.fromRunnable(() -> messages.deleteConversation(conversationId))
                .subscribeOn(Schedulers.boundedElastic())
                .then();
    }

    /** GET /api/history/{conversationId}/messages —— 平铺消息列表（WonWork Message[]）。 */
    @GetMapping(value = "/{conversationId}/messages", params = "!tailTurns")
    public Mono<List<Map<String, Object>>> conversationMessages(
            @PathVariable String conversationId,
            @RequestParam(value = "tailTurns", required = false) Integer tailTurns
    ) {
        return Mono.fromCallable(() -> {
                    List<Map<String, Object>> rows = messages.listMessages(conversationId);
                    return tailTurns == null ? rows : sliceTail(rows, tailTurns);
                })
                .subscribeOn(Schedulers.boundedElastic());
    }

    /** 分层历史：旧轮只给轻量预览，最近 tailTurns 轮保留完整结构。 */
    @GetMapping(value = "/{conversationId}/messages", params = "tailTurns")
    public Mono<Map<String, Object>> layeredMessages(
            @PathVariable String conversationId,
            @RequestParam(value = "tailTurns") int tailTurns
    ) {
        return Mono.fromCallable(() -> {
            List<Map<String, Object>> rows = messages.listMessages(conversationId);
            int turns = countTurns(rows);
            return Map.of("messages", sliceTail(rows, tailTurns), "totalTurns", turns);
        }).subscribeOn(Schedulers.boundedElastic());
    }

    @GetMapping("/{conversationId}/messages/turns")
    public Mono<List<Map<String, Object>>> messageTurnRange(
            @PathVariable String conversationId,
            @RequestParam(value = "fromTurn", defaultValue = "0") int fromTurn,
            @RequestParam(value = "toTurn", defaultValue = "2147483647") int toTurn
    ) {
        return Mono.fromCallable(() -> {
            List<Map<String, Object>> rows = messages.listMessages(conversationId);
            assignTurns(rows);
            return rows.stream().filter(row -> {
                int turn = ((Number) row.getOrDefault("turnIndex", 0)).intValue();
                return turn >= Math.max(0, fromTurn) && turn < Math.max(fromTurn, toTurn);
            }).toList();
        }).subscribeOn(Schedulers.boundedElastic());
    }

    /** POST /api/history/{conversationId}/messages —— 追加一条消息事实。 */
    @PostMapping("/{conversationId}/messages")
    public Mono<Void> appendMessage(
            @PathVariable String conversationId,
            @RequestBody AppendMessageRequest request
    ) {
        return Mono.fromRunnable(() -> messages.appendMessage(conversationId, request))
                .subscribeOn(Schedulers.boundedElastic())
                .then();
    }

    @PutMapping("/{conversationId}/messages/tool/{toolCallId}")
    public Mono<Void> updateToolMessage(
            @PathVariable String conversationId,
            @PathVariable String toolCallId,
            @RequestBody ToolContentRequest request
    ) {
        return Mono.fromRunnable(() -> messages.updateToolMessageContent(
                        conversationId, toolCallId, request == null ? "" : request.content()))
                .subscribeOn(Schedulers.boundedElastic()).then();
    }

    @PutMapping("/{conversationId}/task-state")
    public Mono<Void> updateTaskState(
            @PathVariable String conversationId,
            @RequestBody TaskStateRequest request
    ) {
        return Mono.fromRunnable(() -> {
            requireConversation(conversationId);
            jdbc.sql("UPDATE iris_conversation SET task_state = :state, updated_at = CURRENT_TIMESTAMP, version = version + 1 WHERE conversation_id = :id")
                    .param("state", request == null ? null : request.taskState(), Types.VARCHAR)
                    .param("id", conversationId).update();
        }).subscribeOn(Schedulers.boundedElastic()).then();
    }

    @PutMapping("/{conversationId}/project")
    public Mono<Void> updateProject(
            @PathVariable String conversationId,
            @RequestBody ProjectRequest request
    ) {
        return Mono.fromRunnable(() -> {
            requireConversation(conversationId);
            jdbc.sql("UPDATE iris_conversation SET project_path = :path, updated_at = CURRENT_TIMESTAMP, version = version + 1 WHERE conversation_id = :id")
                    .param("path", request == null ? null : request.path(), Types.VARCHAR)
                    .param("id", conversationId).update();
        }).subscribeOn(Schedulers.boundedElastic()).then();
    }

    private ResponseEntity<Map<String, Object>> createdView(CreatedWithTitle created) {
        return ResponseEntity.status(HttpStatus.CREATED).body(Map.of(
                "id", created.response().conversationId(),
                "userId", 0,
                "title", created.title(),
                "createdAt", created.createdAt().toString(),
                "updatedAt", created.createdAt().toString()
        ));
    }

    private Map<String, Object> toFrontendConversation(ConversationSummary summary) {
        Map<String, Object> value = new LinkedHashMap<>();
        value.put("id", summary.conversationId());
        value.put("userId", 0);
        value.put("title", summary.title() == null || summary.title().isBlank() ? "新对话" : summary.title());
        value.put("createdAt", summary.updatedAt().toString());
        value.put("updatedAt", summary.updatedAt().toString());
        jdbc.sql("SELECT task_state, project_path FROM iris_conversation WHERE conversation_id = :id")
                .param("id", summary.conversationId())
                .query((rs, n) -> {
                    value.put("taskState", rs.getString("task_state"));
                    value.put("projectPath", rs.getString("project_path"));
                    return value;
                }).optional();
        return value;
    }

    private void requireConversation(String id) {
        if (!messagesConversationExists(id)) {
            throw new ResponseStatusException(HttpStatus.NOT_FOUND, "conversation not found");
        }
    }

    private boolean messagesConversationExists(String id) {
        return jdbc.sql("SELECT COUNT(*) FROM iris_conversation WHERE conversation_id = :id")
                .param("id", id).query(Integer.class).single() > 0;
    }

    private int countTurns(List<Map<String, Object>> rows) {
        assignTurns(rows);
        return rows.isEmpty() ? 0 : ((Number) rows.get(rows.size() - 1).get("turnIndex")).intValue() + 1;
    }

    private List<Map<String, Object>> sliceTail(List<Map<String, Object>> rows, int tailTurns) {
        assignTurns(rows);
        int total = countTurns(rows);
        int cutoff = Math.max(0, total - Math.max(1, tailTurns));
        for (Map<String, Object> row : rows) {
            int turn = ((Number) row.getOrDefault("turnIndex", 0)).intValue();
            if (turn < cutoff) {
                String content = String.valueOf(row.getOrDefault("content", ""));
                row.keySet().removeIf(key -> List.of("toolCalls", "toolCallId", "toolCallName", "toolCallStatus", "structuredData", "thinkingProcess", "webBridgeState", "renderNodes", "reasoningContent", "extras").contains(key));
                if (content.length() > 200) row.put("content", content.substring(0, 200) + "…");
                row.put("light", true);
            }
        }
        return rows;
    }

    private void assignTurns(List<Map<String, Object>> rows) {
        int turn = -1;
        for (int index = 0; index < rows.size(); index++) {
            Map<String, Object> row = rows.get(index);
            if ("user".equals(row.get("role")) && !Boolean.TRUE.equals(row.get("isSupplement"))) turn++;
            row.put("index", index);
            row.put("turnIndex", Math.max(turn, 0));
        }
    }

    public record CreateHistoryRequest(String title, Long parentConversationId) { }
    public record RenameRequest(String title) { }
    public record AppendMessageRequest(
            String role,
            String content,
            String reasoningContent,
            Object toolCalls,
            String toolCallId,
            String toolCallName,
            String toolCallStatus,
            Object structuredData,
            Object renderNodes,
            Map<String, Object> extras
    ) { }
    public record ToolContentRequest(String content) { }
    public record TaskStateRequest(String taskState) { }
    public record ProjectRequest(String path) { }
    private record CreatedWithTitle(CreateConversationResponse response, String title, java.time.Instant createdAt) { }
}
