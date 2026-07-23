# 08 · API 契约（REST + SSE）

> 前后端唯一约定。照此实现 Java 后端即可与前端对接。
> 风格：全部 JSON；错误统一 `{ ok:false, error:"人话" }`；列表/详情直接返回数据。
> 个人版无强制鉴权（本机）；预留 `Authorization: Bearer <token>` 头位。

## 1. 模型代理（核心）

### `POST /api/chat/proxy` — SSE 流式对话

请求：
```json
{
  "provider": "openai-compatible",
  "model": "glm-4-plus",
  "baseUrl": "https://open.bigmodel.cn/api/paas/v4",
  "messages": [{ "role": "system|user|assistant|tool", "content": "...", "toolCalls": [], "toolCallId": "" }],
  "tools": [{ "name": "", "description": "", "parameters": { "type": "object" } }],
  "stream": true
}
```

响应：`text/event-stream`，事件序列：

| event | data | 时机 |
|---|---|---|
| `delta` | `{ "text": "…" }` | 文本增量 |
| `thinking` | `{ "text": "…" }` | 思考增量（推理模型） |
| `tool_call` | `{ "id", "name", "arguments" }` | 模型请求调工具（arguments 为完整 JSON） |
| `usage` | `{ "inputTokens", "outputTokens" }` | 结束前一帧 |
| `done` | `{ "finishReason": "stop|tool_calls|length|error", "error?": "" }` | 终帧 |

要求：
- 上游（OpenAI 兼容/Anthropic 系）差异在代理层归一化，前端只见上表；
- 上游断流自动重试（指数退避 ≤3 次），对前端透明；
- 密钥只存服务端配置，不出现在任何响应里。

## 2. 工具平台

### `GET /api/capabilities/tree`
→ `{ ok, systemCode, totalToolCount, loadedDomains[], tree: CapabilityNode }`
CapabilityNode：`{ path, name, toolCount, children[] }`（统计语义见 docs/03 §5）

### `GET /api/capabilities/tool?path=/finance/express/query_express`
→ `{ ok, tool: { name, description, path, riskLevel, parameters } }`

### `GET /api/capabilities/search?q=快递&limit=20`
→ `{ ok, total, items: [{ name, description, path, riskLevel }] }`

### `POST /api/tools/invoke`
```json
{ "toolCallId": "uuid", "name": "write_file", "arguments": { }, "sessionId": "conv-1" }
```
- 只读 → 直接执行：`{ ok, toolCallId, status:"done", result, durationMs }`
- 需审批 → `202 { ok, status:"pending_approval", approval:{ toolCallId, toolName, impactStatement, riskLevel, expiresAt } }`

### `POST /api/tools/approve` / `POST /api/tools/reject`
`{ toolCallId, reason? }` → 执行/作废，随后结果经 `GET /api/tools/events`（SSE）推送：
`event: tool_result → { toolCallId, status:"done|error|rejected|expired", result?, error? }`

## 3. 工作区与沙箱

| 端点 | 说明 |
|---|---|
| `GET /api/workspace/list?path=` | 列目录（围栏内） |
| `GET /api/workspace/read?path=` | 读文件（截断标注） |
| `POST /api/workspace/write` | 写文件（自动检查点） |
| `POST /api/workspace/checkpoint/restore` | `{ msgId }` 回滚到锚点 |
| `POST /api/sandbox/python` | `{ code, timeoutSec? }` → `{ ok, stdout, stderr, truncated, artifacts[] }` |

## 4. 历史与配置

| 端点 | 说明 |
|---|---|
| `GET/POST /api/history/conversations` | 会话列表/新建 |
| `GET/PUT/DELETE /api/history/conversations/{id}` | 详情（含消息+renderNodes）/改名/删除（级联清理视图状态） |
| `GET /api/config/providers` | 可用模型源 `[{ provider, model, baseUrl? }]` |
| `PUT /api/config/providers` | 保存 BYOK 配置（密钥只写服务端） |
| `GET /api/auth/runtime-config` | 运行时开关 `{ byokEnabled, paymentEnabled, ... }` |

## 5. WebBridge（daemon，127.0.0.1:9223）

| 端点 | 说明 |
|---|---|
| `GET /status` | 存活/版本/当前页（构建冒烟用） |
| `POST /open { url }` | → `{ pageId }` |
| `GET /state?pageId=` | 页面状态摘要 |
| `POST /action { pageId, type:click|fill|..., selector, value? }` | → 新页面状态 |
| `POST /screenshot { pageId }` | → png（base64） |
| `POST /workflow/run { id, vars }` | 工作流执行（SSE 进度） |

## 6. 错误模型

- 4xx：用户/参数问题（error 可直接展示）；
- 502：上游模型故障（error 带"模型服务暂时不可用"，前端可重试）；
- 503：daemon 不在（提示"浏览器助手未启动，点击启动"——前端可代为拉起）。
