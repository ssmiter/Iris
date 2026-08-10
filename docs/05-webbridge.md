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

**借窗模式**：默认启动一个持久化的 Iris 专用 Edge profile。用户可在该窗口登录微软账号，
同步密码、书签与常用账号；模型操作，人随时接管——不是无头爬虫，是“借给用户一双手”。
Chromium 136+ 已限制默认用户数据目录上的远程调试，因此 Iris 不强行接管用户正在使用的
日常 Edge profile，也不复制该目录；专用 profile 与同步机制才是可持续的产品边界。

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
一个 Session 可以拥有多个 Page，但只有一个活动页。点击打开新标签时，新 Page 成为活动页，
旧 Page 的 client、最近 Observation 和短期元素表仍由 daemon 保存；切回时必须显式使用
`switch_browser_page` 并取得该页的新 Observation。`page_id` 因此不是展示字段，而是元素 ref、
截图、动作幂等与人工接管共同使用的作用域。切页不能复用另一页的 observation ref。
同一默认 Runtime 上的后续页面工具也可省略 `runtime_id`；只有会话被显式创建在非默认
Runtime 或多环境间切换时才继续携带它，避免把基础设施路由变成每一步的模型负担。

首个纵切提供运行时发现、会话创建、页面观察、导航、视口滚动和基于 Observation
元素引用的点击、非敏感文本填写。观察同时返回页面事实、当前视口以及一组有界的交互
元素；视口内元素优先进入预算。动作成功后自动附带新观察，使模型的自然循环保持为
“看见 → 操作 → 确认”，不以动作数量衡量完成度。

元素 ref 在 daemon 内解析为结构化 locator path，而不是把 CSS selector 暴露给模型。
locator 可以穿过开放 Shadow Root 与同源 iframe；元素摘要同时携带有限的语义上下文、
frame/shadow 深度，降低重复“确定/下一步/编辑”按钮的歧义。跨源 iframe 会作为不可直接
读取的 frame 边界出现在观察中，首版要求截图或人工接管，不能假装顶层 JavaScript 已经
看见其内部。后续若启用独立 frame CDP session，也仍保持同一个 Observation/ref 契约。

### 2.1 感知阶梯：结构优先，视觉按需

第 9 章、Browser Use 与 Claude browser/computer-use 示例共同说明，浏览器 Agent
不是“截图后猜坐标”这一条路，而是一组按任务选择的观察方式：

```text
交互观察（当前视口 + DOM/AX 语义 + 短期 ref）
  → 阅读观察（页面正文，按字符预算）
  → 视觉观察（截图 / 局部放大，解决布局、Canvas 和语义缺失）
  → 坐标或人工接管（结构化定位确实不可用时）
```

Iris 不把四层同时塞进每一轮。`observe_browser_page` 明确声明 `purpose`：

- `interact`：默认；返回当前视口文字、交互元素、滚动范围和状态，不重复携带整页正文；
- `search`：在当前页面正文和元素语义中查找关键词，只返回有界命中片段和相关元素；
  它仍产生标准 Observation，因此命中的元素引用可直接进入下一步动作；
- `read`：需要阅读文章、结果页或核对页面中非视口内容时，按预算返回正文；之后若要操作，
  再取得新的 `interact` observation；
- 视觉 observation 仍由截图对象承载，只有模型能力和任务确实需要时才进入多模态上下文；
  当前文本模型不会因为前端能显示截图就假装自己看过图片。

动作后的自动 observation 固定使用 `interact`，因为它的职责是验证刚才发生了什么并给出
下一步可用引用，而不是再次复制整篇网页。Observation 还应标记：

- `new=true`：相对上一份观察新出现的元素，帮助识别自动补全、弹窗和动作后的局部变化；
- `previousObservationRef / change`：说明本观察从哪一份已交付观察演进而来，以及 URL、
  视口、可交互元素和可见正文是否变化。`fingerprint` 只描述页面事实，不得因为本次选择
  `interact / search / read` 而变化；否则一次阅读会被误判为一次页面变化；
- `pixelsAbove / pixelsBelow`：说明视口之外还有多少内容，避免无目的滚动；
- `trust=untrusted_external_data`：网页文字永远是数据，不因看起来像系统指令而获得权限。

等待不是连续制造 Observation。daemon 可以在预算内探测页面，但中间探测不推进 revision、
不替换元素 ref，也不把自动补全刚出现的元素提前“消费”掉；条件满足或超时后只提交一份
最终 Observation。这样 `new`、水位线和前端看到的状态演进与模型实际收到的事实一致。

页面有两种指纹：用于判断页面内容变化的 `page fingerprint`，以及用于阻止旧引用动作的
`action fingerprint`。前者可包含可见正文，后者只包含 URL、视口和可交互元素契约，避免
页面时钟或广告文字刷新让一个本来安全的点击无故过期。两者都不依赖观察预算和输出格式。

这不是把 Browser Use 的专用 Loop 搬进 Iris。其 DOM 索引、新元素、截图按需和动作中断
思想进入 WebBridge；任务历史、工具发现、审批、压缩与恢复仍由 Iris 的通用 Agentic
内核统一拥有。

### 2.2 原语设计（webbridge_* 工具族）

| 原语 | 说明 |
|---|---|
| `list_browser_runtimes()` | 发现已配置 Runtime 及其当前可用性，不暴露地址或令牌 |
| `open_browser_session(url?, runtimeId?)` | 创建短期浏览器会话和页面；通常自动选择默认 Runtime，多 Runtime 定向时才显式传入 |
| `list_browser_sessions()` | 列出存活 Session、活动 Page 与会话拥有的页面摘要，用于刷新或人工接管后恢复 |
| `open_browser_page(sessionId, url)` | 在现有 Session 中打开并激活一个新页面，保留旧页面；用于多来源检索与比较 |
| `switch_browser_page(sessionId, pageId)` | 切换到 Session 已拥有的页面并返回一份新观察；不接受任意外部 CDP target |
| `observe_browser_page(sessionId, pageId?)` | **页面状态**：有界正文、交互元素与 revision，这是模型的“眼睛” |
| `navigate_browser_page(sessionId, pageId, url, expectedObservationRef?)` | 导航并返回新页面状态；同一 idempotency key 不重复执行 |
| `navigate_browser_history(sessionId, pageId, observationRef, direction)` | 使用真实页面历史后退、前进或刷新，并返回新观察；不让模型猜上一个 URL |
| `scroll_browser_page(sessionId, pageId, observationRef, direction, amount?)` | 从当前观察向上/向下或到达顶部/底部，返回新的视口观察；不改变远端业务数据 |
| `click_browser_element(sessionId, pageId, observationRef, elementRef)` | 点击当前观察中的元素；准备时解析人类描述，页面变化则不执行 |
| `fill_browser_field(sessionId, pageId, observationRef, elementRef, value)` | 填写普通文本字段并重读确认；首版拒绝 password/file 等敏感类型 |
| `upload_browser_file(sessionId, pageId, observationRef, elementRef, workspacePath)` | 将工作区围栏内的现有文件设置到真实 file input；模型与历史只保留逻辑路径 |
| `select_browser_option(sessionId, pageId, observationRef, elementRef, value)` | 使用观察中真实 option value 选择原生下拉项，不让模型猜 label |
| `press_browser_key(sessionId, pageId, observationRef, key, elementRef?)` | 向当前页或观察中的字段发送一个受限键盘键；用于 Enter、Escape、Tab 和方向键，不接受任意快捷键脚本 |
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
- **失败必须表达副作用边界**：元素已消失、已禁用、字段类型不支持等可在动作前确定的失败
  返回 `not_applied`；只有动作已经派发而后续确认中断时才返回 `outcome_unknown`。模型据此
  决定纠参还是先核对，不能把所有异常都当成“可能已经点击”。
- **观察引用是水位线**：动作可以声明 `expectedObservationRef`；若页面已经变化，daemon
  返回 `not_applied`，模型重新观察，不在旧页面认知上盲目点击。
- **动作身份不可重造**：Backend 传入 `toolExecutionId + actionAttemptId + idempotencyKey + expectedObservationRef`；daemon 返回 `applied / not_applied / outcome_unknown + evidenceRef`。响应丢失时只能查询同一动作结果，不能生成新 attempt 再点一次。
- **定位器留在 Runtime**：模型只消费 ref 与 role/label/context；daemon 在该 Observation
  内保存可穿过开放 Shadow Root/同源 frame 的 locator path。页面改版后重新观察，不让模型
  猜 CSS/XPath，也不把 locator 当成跨 revision 的永久身份。
- **风险由实际动作提升**：通用 click/fill/select/press 的 `prepare` 必须结合目标元素、页面语义和动作批次重新分类，风险只能维持或提升，不能把“点击最终提交”按一个普通 click 降级；无法判断时默认需要审批。
- **敏感输入不是普通字符串**：当前内核还没有 secret handle 时，`fill_browser_field`
  明确拒绝 password、file 和不可安全重读的字段。以后由凭据对象/人工接管提供值，不能
  先把密码作为 Tool 参数写进对话和 Operation Snapshot。
- **上传跨两个客观环境**：`upload_browser_file` 的参数只接受工作区逻辑路径。Backend 在
  prepare 与 execute 时分别经过 `WorkspacePathGuard`，Operation Snapshot 不保存绝对路径；
  daemon 只在已审批动作中取得物理路径，用 CDP 设置当前 Observation 的 file input，并以
  文件名、大小和动作后观察验证。网页永远不能反向指定本机任意路径。
- **截图不走 Base64 JSON**：daemon 返回原始图像字节，Backend 直接写入 Managed Object
  Store；Tool observation 只含 `objectRef/contentHash/mediaType/byteCount`。这样大图不会
  穿过模型文本上下文，也不会被 Frontend 重复缓存。
- **批处理不是默认捷径**：只有多个动作共享同一份已验证 observation、前置条件彼此独立，
  且 Runtime 能在页面变化时停止剩余动作，才可形成有界 batch。首版仍保持一个动作一份
  新观察，先保证正确性与可恢复性。
- **循环检测是运行时反馈，不是第二个规划器**：Backend 可根据最近动作 identity 与页面
  fingerprint 判断“相似动作重复且页面无进展”，向下一 Round 追加一条有界恢复提示；它不
  替模型选择新路径，也不能阻止确实在分页或重复录入中持续产生新证据的动作。

研究参照：

- `browser-use/browser-use`：结构化元素索引、变化元素、Shadow DOM/iframe 与滚动容器表达；
- `anthropics/claude-quickstarts`：显式 browser tool、截图裁剪、缓存友好的图片清理和
  页面变化即停止 batch；
- [Opus 5 系统提示词结构分析](reference-opus5-system-prompt-architecture-2026-07-29.md)：
  三层工具注入、工具即 UI 契约与不可信数据流标记。它是研究材料，不是实现规范。

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

Windows 默认浏览器实现优先发现 Microsoft Edge，再回退到 Chrome/Chromium；用户显式配置
`IRIS_WEBBRIDGE_BROWSER_PATH` 时才覆盖该选择。profile 默认位于 Iris 本机数据目录并长期
复用，不能使用临时目录，也不能和 Browser Use、日常 Edge 等另一个正在运行的实例共享
同一 `user-data-dir`。这样登录态有生命周期，Runtime 仍归 Iris 自己管理。

## 8. Runtime 生命周期与持久化边界

- Runtime Definition 来自本机配置，稳定 `runtime_id` 进入 Capability observation，地址与
  bearer token 永不进入模型上下文；
- 单一可用 Runtime 自动成为默认；多 Runtime 场景由本机配置声明默认对象。只有默认缺失、
  用户要求定向或需要诊断时，模型才读取 Runtime 目录；健康检查始终由 Backend preflight
  执行，不占用普通 Agentic Round；
- daemon 进程、CDP client 与 BrowserSession 是 ephemeral runtime object；TTL、关闭或
  进程重启后可以失效，不伪装成永久业务对象；
- 默认空闲租约为 60 分钟，给登录、人工接管和长页面阅读留出真实时间；每次观察、动作、
  切页都会续租；单纯列举不会让所有旧会话续命。产品完成持久 Attention 后可由等待态显式持有租约，不能用
  高频轮询假装保活；
- Backend 持久化 ToolCall、Operation Snapshot、session/page 引用、Observation/Evidence
  内容引用与最终状态，不尝试序列化 CDP handle；
- availability probe 有短缓存，区分“未配置、daemon 不可达、协议不兼容、浏览器不可用”；
- `browserRunning` 必须由 CDP liveness 得出，不能只检查内存里是否还保存着 launcher
  对象；Edge 在最后一个页面关闭后可能自行退出，下一次创建 Session 应清理失效 handle
  并按同一 profile 自动重启，不能让健康接口长期报告假 ready；
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

### 9.1 搜集账本与进度黑板

“岗位 Excel/HTML”不能同时承担事实、任务状态和界面三个角色，否则一次渲染失败就像
任务丢失，用户手工改 HTML 也会污染 Agent 的判断。北极星场景采用三层对象：

```text
Evidence：网页 Observation、URL、时间和原始摘录（不可变）
Candidate Ledger：公司/岗位/方向/地区/截止日/链接/证据引用/处理状态（结构化事实）
Blackboard：进度、待确认项、表格和超链接的 HTML/前端投影（可重建视图）
```

- 浏览器每发现一个候选就增量写 Ledger，不等全部搜索结束才一次生成；
- 代码从 Ledger 计算“已检查来源、候选数、缺字段、失败来源、待人工项”，模型不从长轨迹
  重新数数；
- HTML 是适合持续沟通的可视化黑板，Excel 是适合筛选和交付的导出，两者共享同一份
  结构化事实；任何一个都不是唯一真相；
- 对话压缩只改变模型视野，不删除 Evidence 或 Ledger；恢复时注入一小段代码计算的状态，
  需要细节再按引用读取；
- 首版不预定义“招聘工作流平台”。先用浏览器观察 + 工作区文件验证纵向体验，重复成功后
  再决定哪些步骤值得沉淀成 Pipeline 或领域能力。

### 9.2 长程任务中的上下文隔离

长期搜集容易被误解为“给主 Agent 更长上下文”或“再加一个记忆 Agent”。Iris 先隔离
信息职责，而不预设必须有几个模型：

```text
用户任务定义：方向、地区、组织类型、时间范围、排除项（稳定约束）
采集上下文：当前网页、局部动作、原始摘录（短期且不可信）
任务工作状态：Ledger 计数、去重键、缺字段、失败来源、待确认项（代码维护）
决策上下文：稳定约束 + 有界状态快照 + 当前最相关证据（每轮求解视野）
```

原始 Evidence 和完整 Ledger 可以落盘，但不全量回灌模型。主 Agent 每轮只看到代码从
Ledger 计算出的状态快照；需要核对某条候选时再按稳定引用读取原始证据。对话压缩不负责
保存任务状态，它只压缩叙事历史；任务状态有自己的持久对象和版本。

只有“从口语和历史中归纳偏好”这类无法确定性计算的工作，才值得以后进入隔离的
Pipeline/child Run。它的输出也必须是带来源和置信度的候选偏好，由主决策上下文消费；
不能让第二个自由运行的 Agent 直接改写用户目标。这样保留双角色设计的价值，同时避免
双倍模型成本、相互漂移和难以恢复的隐式共享记忆。

这里的核心不是选择“单 Agent”还是“多 Agent”，而是先建立可靠的 harness。目标版本、
Ledger、证据引用、并行上限、超时、重试、停止条件和上下文装配都由代码维护；模型只处理
语义理解、未知环境决策和无法确定性计算的取舍。单 Agent、双 Agent 或固定 Pipeline 是
harness 针对具体场景选择的执行拓扑。例如偏好多样、口语表达强的任务可以隔离出偏好归纳
角色，与决策角色并行协作；换一个确定性更强的任务，则不必支付第二个 Agent 的延迟和成本。
