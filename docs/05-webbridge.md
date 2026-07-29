# 05 · WebBridge：浏览器自动化

> 个人生活的高价值场景大多在网页里：秋招几百个网申、抢票、政务表单、比价下单。
> 纯 API 工具覆盖不了它们——必须驱动**真实的浏览器**。

## 1. 定位与形态

WebBridge 是一个独立的本地守护进程（daemon），通过 CDP（Chrome DevTools Protocol）驱动一个真实 Chrome 窗口：

```
对话："帮我把简历填到这个网申页面"
  → 模型调用 webbridge_* 工具
  → 后端转发给 daemon（127.0.0.1:19223，仅本机）
  → daemon 操作真实 Chrome
  → 页面状态/截图/结果回流，嵌入对话瀑布流
```

**借窗模式**：启动用户自己的 Chrome（带登录态），或新开一个干净窗口。模型操作，人随时接管——不是无头爬虫，是"借给用户一双手"。

## 2. 对象、观察与动作

浏览器能力先建立一条很短的对象链，而不是先铺开几十种动作：

```text
BrowserRuntime（可配置、可失效）
→ BrowserSession（短期租约，由 daemon 拥有）
→ BrowserPage（会话内身份）
→ Observation（不可变页面快照）
→ Action（声明期望的上一份 Observation）
→ 新 Observation + Evidence
```

这些对象主要用于内核保持身份、生命周期和恢复语义。普通单机任务由 Backend 在
`open_browser_session` 的 preflight 中确定默认可用 Runtime；模型通常只需记住
`session_id / page_id`，以及结果中用于证据和恢复的 `runtime_id` 与最近一次观察返回的
短期元素引用，不要求理解 CDP target、WebSocket、进程 handle 或凭据。元素引用只在对应 Observation revision
内有效，页面变化后重新观察，不把脆弱 CSS selector 当作长期对象身份。
同一默认 Runtime 上的后续页面工具也可省略 `runtime_id`；只有会话被显式创建在非默认
Runtime 或多环境间切换时才继续携带它，避免把基础设施路由变成每一步的模型负担。

首个纵切提供运行时发现、会话创建、页面观察、导航、视口滚动和基于 Observation
元素引用的点击、非敏感文本填写。观察同时返回页面事实、当前视口以及一组有界的交互
元素；视口内元素优先进入预算。动作成功后自动附带新观察，使模型的自然循环保持为
“看见 → 操作 → 确认”，不以动作数量衡量完成度。

### 2.1 原语设计（webbridge_* 工具族）

| 原语 | 说明 |
|---|---|
| `list_browser_runtimes()` | 发现已配置 Runtime 及其当前可用性，不暴露地址或令牌 |
| `open_browser_session(url?, runtimeId?)` | 创建短期浏览器会话和页面；通常自动选择默认 Runtime，多 Runtime 定向时才显式传入 |
| `observe_browser_page(sessionId, pageId?)` | **页面状态**：有界正文、交互元素与 revision，这是模型的“眼睛” |
| `navigate_browser_page(sessionId, pageId, url, expectedObservationRef?)` | 导航并返回新页面状态；同一 idempotency key 不重复执行 |
| `scroll_browser_page(sessionId, pageId, observationRef, direction, amount?)` | 从当前观察向上/向下或到达顶部/底部，返回新的视口观察；不改变远端业务数据 |
| `click_browser_element(sessionId, pageId, observationRef, elementRef)` | 点击当前观察中的元素；准备时解析人类描述，页面变化则不执行 |
| `fill_browser_field(sessionId, pageId, observationRef, elementRef, value)` | 填写普通文本字段并重读确认；首版拒绝 password/file 等敏感类型 |
| `select_browser_option(sessionId, pageId, observationRef, elementRef, value)` | 使用观察中真实 option value 选择原生下拉项，不让模型猜 label |
| `capture_browser_screenshot(sessionId, pageId)` | 截取当前页面为二进制 Managed Object，只回传对象引用和图像 metadata |
| `wait_browser_page(sessionId, pageId, afterObservationRef, condition)` | 在 daemon 内等待异步页面条件，只返回最终观察，避免轮询污染上下文 |
| `inspect_browser_action(sessionId, toolExecutionId)` | 响应丢失后读取同一幂等动作结果，绝不生成第二次点击 |
| `close_browser_session(sessionId)` | 显式回收会话与页面 handle；历史观察仍由 Backend 保存 |
| `webbridge_click / fill / select / press` | 动作原语，selector 或语义定位（"姓名字段"） |
| `webbridge_screenshot(pageId)` | 截图（视觉校验：填对了吗） |
| `webbridge_extract(pageId, schema)` | 按 schema 抽取页面结构化数据 |
| `webbridge_takeover(pageId)` | 请求人工接管（登录/验证码/支付） |

设计要点：

- **页面状态 > 截图**：AX 树摘要 token 成本低且可动作；截图用于校验与疑难场景（视觉模型）。
- **动作后必回流状态**：每个动作原语返回新的页面状态摘要，模型不需要额外调用就能确认效果。
- **观察引用是水位线**：动作可以声明 `expectedObservationRef`；若页面已经变化，daemon
  返回 `not_applied`，模型重新观察，不在旧页面认知上盲目点击。
- **动作身份不可重造**：Backend 传入 `toolExecutionId + actionAttemptId + idempotencyKey + expectedObservationRef`；daemon 返回 `applied / not_applied / outcome_unknown + evidenceRef`。响应丢失时只能查询同一动作结果，不能生成新 attempt 再点一次。
- **选择器语义化**：优先 role/label/placeholder 定位，CSS/XPath 兜底——页面改版存活率完全不同。
- **风险由实际动作提升**：通用 click/fill/select/press 的 `prepare` 必须结合目标元素、页面语义和动作批次重新分类，风险只能维持或提升，不能把“点击最终提交”按一个普通 click 降级；无法判断时默认需要审批。
- **敏感输入不是普通字符串**：当前内核还没有 secret handle 时，`fill_browser_field`
  明确拒绝 password、file 和不可安全重读的字段。以后由凭据对象/人工接管提供值，不能
  先把密码作为 Tool 参数写进对话和 Operation Snapshot。
- **截图不走 Base64 JSON**：daemon 返回原始图像字节，Backend 直接写入 Managed Object
  Store；Tool observation 只含 `objectRef/contentHash/mediaType/byteCount`。这样大图不会
  穿过模型文本上下文，也不会被 Frontend 重复缓存。

## 3. 录制与工作流

- **录制**：人操作一遍，daemon 记录动作序列（含语义定位器与变量占位），保存为工作流 JSON；
- **参数化**：表单值、日期、账号抽成变量；
- **回放**：Backend 以指定版本和变量创建该 Pipeline Run，daemon 仍只接收页面观察和动作原语；
- **自愈**：定位失败时降级链（语义定位 → CSS → 视觉坐标），仍失败则请求人工接管并记录断点。

录制结果先成为版本化 Pipeline 草稿，经检查输入、资源、审批点、证据和失败边界后再发布为 `/web/flows/<name>` Pipeline Capability。它不是一个隐藏全部中间动作的巨大 Tool；每个真实浏览器动作仍通过 Backend Tool Runtime。

## 4. 人工接管（Takeover）

- 模型遇到登录/验证码/支付确认时，发起 takeover 请求 → Backend 持久化 Attention → 对话中出现"需要人工操作"卡片 → 用户在真实窗口完成 → 提交明确“已完成”命令 → Backend 重新观察后继续；
- 用户界面不轮询；如果模型需要判断页面变化，调用受预算的只读页面观察原语，daemon 进度先进入 Backend 事件再经 Conversation SSE 投影；
- **支付/提交类最终按钮永远默认走接管**，即使在工作流里（可在工作流中标记哪些步骤必须人工确认）。

接管不是 daemon 内部的等待循环，也不是一个返回 `success=true` 的同步 Tool。Browser
ToolExecution 进入 `awaiting_attention` 后释放执行线程；用户完成操作并响应
`takeover_completed`，Backend 以同一 execution 恢复并立即创建一份新 Observation。用户
可能改变任意页面状态，因此接管前的 element ref、fingerprint 和 expected observation
全部作废。

在持久 Attention 真正接通前，产品先采用可用的轻量路径：Iris 保留可见 Session，在
回答中请用户直接操作浏览器并在完成后回复；下一 Turn 通过 `list_browser_sessions →
observe_browser_page` 续接。这个方案不是最终状态，但已经允许登录/验证码后继续完成任务，
且不会用一个假的 takeover Tool 宣称系统正在等待。

## 5. 安全模型

- daemon 只监听 `127.0.0.1`，启动时生成本机令牌，后端调用需带令牌；
- 单实例锁（端口 + 锁文件），僵尸进程自动监护回收；
- 所有动作写审计日志（时间/页面/动作/参数摘要）；
- 敏感字段（密码框）的值不进入页面状态摘要与日志。

## 6. 对话中的呈现（过程即内容）

- 运行中：浏览器画面以"舞台"卡片嵌入瀑布流——实时截图字幕（"正在填写：期望薪资"）、就地审批、接管按钮；
- 结束后：舞台收拢为一枚 chip（"操作了 3 个页面 · 42s"），点击可回看；
- 失败：断点截图 + 模型自诊断（"在'上传附件'步骤找不到文件选择器"）。

第一步不引入一条绕过对话内核的实时画面通道。截图仍先经过 Tool Runtime 写入
Managed Object Store，再由后端把安全的预览地址和少量 metadata 投影到对应 ToolNode。
Frontend 只有在用户展开该节点时才请求、解码图像；折叠状态与历史轮次只保留引用。
预览接口必须用 `conversationId + toolExecutionId` 校验归属，不向前端暴露对象仓物理路径
或可任意读取的 `objectRef`。这样视觉证据、历史回放和懒加载共用一套持久语义，同时不让
Frontend 成为第二个浏览器执行器。

## 7. 技术选型权衡

| 方案 | 优 | 劣 |
|---|---|---|
| Node.js + CDP（裸协议） | 最轻、无依赖、对 Chrome 控制精细 | 自己实现元素定位/等待逻辑 |
| Node.js + Playwright | API 成熟、等待/定位开箱即用 | 多一层依赖 |
| **Java + Playwright**（并入后端，无独立 daemon） | 少一个进程，统一语言 | 打包体积大（浏览器驱动），Playwright Java 的 CDP 高级用法略绕 |

当前冻结边界：**独立 `webbridge-daemon`、回环监听、本机令牌、Backend Connector
唯一调用方**。首个 adapter 使用 Node + CDP 验证真实“借窗”、状态与幂等动作；实现仍可
替换，Backend 私有协议和 Tool 语义不依赖 CDP。不能为了少一个进程让 Frontend 直连
浏览器，也不能让 daemon 拥有 Conversation、Pipeline 或审批真相。

## 8. Runtime 生命周期与持久化边界

- Runtime Definition 来自本机配置，稳定 `runtime_id` 进入 Capability observation，地址与
  bearer token 永不进入模型上下文；
- 单一可用 Runtime 自动成为默认；多 Runtime 场景由本机配置声明默认对象。只有默认缺失、
  用户要求定向或需要诊断时，模型才读取 Runtime 目录；健康检查始终由 Backend preflight
  执行，不占用普通 Agentic Round；
- daemon 进程、CDP client 与 BrowserSession 是 ephemeral runtime object；TTL、关闭或
  进程重启后可以失效，不伪装成永久业务对象；
- Backend 持久化 ToolCall、Operation Snapshot、session/page 引用、Observation/Evidence
  内容引用与最终状态，不尝试序列化 CDP handle；
- availability probe 有短缓存，区分“未配置、daemon 不可达、协议不兼容、浏览器不可用”；
- daemon 重启后历史仍可读，但旧 Session 明确失效；模型发现 unavailable reason 后可以
  重开会话或请求用户启动浏览器，而不是无限重试；
- 页面正文、元素和截图受预算约束；完整大对象经 Tool Runtime 落 Managed Object Store，
  Frontend 默认只渲染摘要，需要时再按引用读取。

本地开发时，daemon 和 Backend 使用同一个高熵 token，但分别从进程环境和被 Git 忽略
的本机配置读取：

```powershell
$env:IRIS_BRIDGE_TOKEN = '<至少 24 字符的本机随机值>'
cd webbridge-daemon
npm install
npm start
```

```yaml
# backend/src/main/resources/application-local.yml（不提交）
iris:
  webbridge:
    default-runtime-id: local_browser
    runtimes:
      local_browser:
        title: 本机浏览器
        description: Iris 专用的可见 Edge 会话，可由用户随时接管
        base-url: http://127.0.0.1:19223
        token: ${IRIS_BRIDGE_TOKEN}
        protocol-version: 2
```

Backend 启动时还需激活 `local` profile。Windows 产品化后由 launcher 创建并向两个进程
注入同一秘密；Frontend 不读取、不签发也不缓存 Runtime token。

## 9. 杀手场景：秋招网申流水线

1. 用户把简历/成绩单/证件照放进工作区 `job/`；
2. 对话："这是 50 家公司的网申入口清单（Excel），帮我逐个填写，遇到开放题先草稿给我审"——模型读 Excel → 逐站点执行；
3. 已知站点走录制好的工作流；未知站点模型现场探索（state → 填 → 校验）；
4. 每个站点产出一张结果卡（状态/截图/待人工项），全部写入工作区 `job/结果.md`；
5. 验证码/最终提交一律接管人工完成。

这个场景把工具平台、浏览器、工作区、审批、产物全部串起来——是 Iris 的"北极星用例"。
