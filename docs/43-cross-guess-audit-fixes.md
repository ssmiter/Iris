# 43 · 隔离互猜审计：确认缺陷清单与修复分期（设计稿）

> 状态：**全部落地**（2026-08-27：行为缺陷 H1/H2/M1-M7/L1-L5 全部修复，
> 契约文档 D1-D5 已对齐 docs/08，M8 预览字段已落地，
> S1 孤儿端点已删除；后端 135 测试 0 失败、历史遗留基线不变，
> 前端 typecheck 干净；H1/M5/M6 带钉死测试）。
> 剩余：docs/42 §4-10 三层结果预算其余部分。
> 方法：6 个隔离视角互猜（前端↔后端、Agent↔工具、上下文↔工具生命周期、
> 流式时序对账），36 个子代理，30 条疑点经对抗式验证（默认怀疑、
> 证据不足驳回），**确认 18 条、证伪 12 条**。方法文档见
> `WonWork/learn/05/strategy/隔离互猜审计法-workflow.md`。
> 证伪的 12 条同样有价值——它们是「这个地方是对的以及为什么」的豁免
> 清单，附录 A 保留备查。
> 与 docs/42（参照系提升）互补：42 回答「怎样更好」，本稿回答
> 「哪里错了」。

## 1. 确认缺陷总览（18 条）

分级：**行为缺陷**（改代码，13 条）、**契约文档漂移**（改 docs/08 与
docs/22，4 组）、**结构性裁决**（进设计讨论，1 条）。

### 行为缺陷 · 高危

**H1 窗口裁剪优先级倒挂：预算紧张时丢用户消息、保工具轨迹**
（上下文猜工具生命周期，验证 confirmed/high）
`ModelContextWindowPlanner.java:164-178` 候选按 dropPriority ordinal
**升序**贪心装入——TOOL_OBSERVATION_TRAJECTORY(0) 先占预算，
USER_MESSAGE(5) 最后考虑最先淘汰，与类注释「Lower ordinal = dropped
first」和 docs/22 §3「用户消息是对话骨架，最后才丢」完全相反。
平时预算够不显现，越界时才发作，所以难被发现。既有测试两种排序下
结果相同，没钉死行为。
修法：排序反转（高保留优先级先装入），同优先级内新组优先；补一个
「预算恰能装下 user 组装不下 tool 组」的单测钉死。

**H2 invalidated 重水合不 abort 旧 SSE 流：版本回退与重水合风暴**
（流式时序，confirmed/high）
恢复 effect（ConversationApp.tsx:460-480）只 getConversationView +
hydrateView，旧流继续推；快照水位后到达的 live 事件被整树擦除 →
节点 version 回退 → 下一条 delta 失配 → 再次 invalidated。
放大器：事件回调无条件 setConnectionState('connected')（:420）使
恢复 effect 每拍重 fires，并行发起多个全量拉取无 in-flight 去重；
eventCursor 无条件回写（chatStore.ts:76）可回退，重连后重放已应用
事件再撞失配。对照组：410 路径安全是因为旧流已 error 终止。
修法：invalidated 恢复先断流再以快照游标重连；eventCursor 只单调
递增；恢复加 in-flight 去重。
（2026-08-27 已修复：SSE effect 依赖 connectionState，invalidated 时
清理并暂停重连；事件回调不再覆盖 invalidated；恢复请求加 ref 去重；
chatStore 新增 lastEventSequence 保证游标单调递增。）

### 行为缺陷 · 中危

**M1 SSE hub 背压溢出静默丢 live 事件，丢终态事件则状态机永久卡死**
（流式时序，confirmed/medium）
ConversationEventHub.java:28 onBackpressureBuffer(256,false)，溢出仅
计数日志、事件永久丢弃，注释自认「前端靠 Last-Event-ID 重连补」——
但那只覆盖断线重连，健康在线连接上被丢的事件无任何通知。丢
run.settled/turn.updated/attention.updated 则 run 永远 active、
审批卡永远 waiting。envelope.sequence 已一路带到前端却无人校验。
修法（fail-close 替代静默丢）：溢出时对该 sink emitError 终止 SSE，
客户端走既有重连补齐全量；或前端做 sequence 间隙检测发现缺号即
invalidated。前者更小。

**M2 delta 重复 chunk 未按契约忽略：重连重放即触发全量重水合**
（前端猜后端，confirmed/medium）
chatStore.ts:122-139 delta 分支只认 version===baseVersion，否则一律
invalidated；docs/08 §10.4 明确「重复 chunk 忽略」，重连重放是契约
内常态。前端也无 eventId 去重（契约要求至少一次投递 + 前端去重）。
修法：targetVersion <= current.version 判重复直接忽略（校验
field==='content'）；applyEvent 前按 eventId 维护近期已见集合；
断线/重连时 flush 或清空 50ms 合批队列。（2026-08-27 已修复：delta reducer 忽略 content 重复 chunk；chatStore
维护有界 seenEventIds 去重；ConversationApp 重连前 flush 合批队列。）

**M3 未知工具名/注册表漂移让取消路径与整轮执行崩溃**
（Agent 猜工具，confirmed/medium）
ToolRuntime.invoke 对未注册名抛 ToolRuntimeException（:123-128，
在 insertClaim 之前，无 execution 落库）；RoundToolCoordinator
invoke 无 try/catch → 整轮炸进 failRun，其余 ToolCall 无
observation。更脆的是 recordCancelledPendingCalls 对无 executionId
的调用 orElseThrow——MCP 卸载/扩展重载后用户点「停止」=
内核异常。
修法：RoundToolCoordinator 捕获 tool_not_found 类异常，为该 call
合成 failed 终态 execution+observation 而不是中止 advance；
recordCancelledPendingCalls 在 registry.find 为空时降级为无 binding
的 synthetic 终态记录（仅持 toolName）。停止路径永不因注册表漂移
抛异常。

**M4 Observation 恢复协议把工具层 errorCode 词表硬编码在 agent 侧，
且多个真实码已脱钩**
（Agent 猜工具，confirmed/medium）
ToolObservationService.java:289-430 全靠 startsWith/endsWith 字符串
匹配，无单一事实源、无漂移守卫。今天已脱钩的真实码：
pipeline_not_inspected（InvokePipelineTool:101，只认
capability_not_inspected）、workspace_checkpoint_not_applied
（not_applied 规则强制 browser_ 前缀）、cancelled/process_cancelled
（isCancellation 不认）、process_timeout（不匹配 tool_timeout*）。
脱钩后果：恢复 SOP 失效，静默落兜底 replan。
修法：最小修补先行——isCancellation 补 cancelled/process_cancelled、
not_inspected 族补 pipeline_not_inspected、not_applied 去掉 browser_
前缀限制、timeout 族补 process_timeout；长期把 errorCode→recovery 族
映射收为单一事实源 + 测试断言每个被产出的码落入已知族（结构性，
见 §3）。

**M5 轮内预算驱逐绕过 PINNED/REFETCHABLE 校验**
（Agent 猜工具，confirmed/medium）
RoundToolCoordinator.referenceOnlyExecutionIds 只按 token 大小选
受害者，无 canReplace 门（micro-compact 路径有）。ToolManifest
PINNED 契约明文「Observation 不可自动替换为引用」，轮内预算路径
无视它——AskUserTool 的用户回答可被换成引用。数据不丢（payload
必落库，read_tool_result 可兑现），是契约违反。
修法：选受害者时经 ToolResultContextProjector.canReplace 过滤，
至少跳过 PINNED；不可替换的大结果保留内联。

**M6 attempt 已 commit 后 complete() 失败留下永久 streaming 孤儿
节点，两条恢复机制都捞不到**
（流式时序，confirmed/medium，**已修复**）
AgenticRoundCoordinator 的 commit→complete 同 callable，commit 成功
后 complete 抛错（乐观锁/重试耗尽）时 handleAttemptFailure 只
discard（清内存态，不删投影行、不发 invalidated）；
recoverInterrupted 只捞 phase='interrupted'，该 attempt 是
'completed'。前端 AnswerBlock 对 streaming 恒为 true——半截答案
永久残留，刷新依旧。
修法（组合）：
1. `handleAttemptFailure` 的 `attemptCommitted` 分支改用
   `answerStreams.invalidateIfStreaming(...)`——仅当投影行仍在
   `streaming` 时才删除并发送 `render_node.invalidated`，避免误删
   已冻结节点；
2. `recoverInterrupted` 的 SQL 放宽为「`answer` 节点仍在
   `streaming` 且 attempt 或 round 已经离开 `streaming` 状态」一并
   清扫，覆盖 commit 成功后进程崩溃的残留场景。

**M7 扩展过程工具 risk 缺省 fail-open 成 read_only（审批旁路）**
（工具猜 Agent，confirmed/medium，安全相关）
TemplateProcessTool risk.level/sideEffect 缺省 READ_ONLY/NONE，
连锁派生 IDEMPOTENT + PARALLEL_SAFE；ExtensionScanner.validate 不
强制 risk；ExtensionScanner:470-472 甚至反向禁止「只读工具显式挂
审批」。结果：一个省略 risk 块的 shell 类 .tool.yml 在
approvalMode=REQUIRED 下绕过审批，还获得流式投机执行资格。
对照 MCP 侧未声明 readOnlyHint 默认 ELEVATED（fail-closed）——
两侧不对称，docs/31「不依赖插件自觉」被代码违背。
修法：ExtensionScanner.validate 把 risk.level 与 risk.side_effect
列为必填（缺失整插件拒绝进 problems，对齐 MCP 口径）；若保持可选，
缺省翻转为 ELEVATED/EXTERNAL_WRITE。

**M8 reference 投影无预览、与 docs/22 §3.1 漂移**
（上下文猜工具生命周期，confirmed/medium）
ToolResultContextProjector.toReference 只有
resultReference/contentHash/guidance，没有预览文本；docs/22 §3.1
要求「预览 + hash + tool-result:// 引用 + 读回方法」四要素。
「可能无 contentHash」被证伪（payload 必同事务落库），但预览缺失
属实。
修法：toReference 加 bounded 预览字段（如前 300 字符），对齐
docs/22。与 docs/42 §4-10「大结果落盘指针」合流实现。

**已落地（2026-08-27）**：toReference 输出 `preview`（前 300 字符纯文本，
截断时尾部带省略标记）+ `previewTruncated`；referenceOnly 捕获与
micro-compact 两条路径统一经投影器获得预览，冻结决策不变；
docs/22 §3.1 措辞同步对齐。docs/42 §4-10 的①③层预算仍属后续分期。

### 行为缺陷 · 低危（顺手修）

- **L1** invoke_capability 的 description 补一句「read_capability
  必须发生在更早轮次，同轮批量调用必然被拒」——消除模型同轮批量
  的诱因（现在靠一轮浪费 + 恢复引导自愈）。
- **L2** read_capability 两处裸 IllegalArgumentException 换成
  ToolRuntimeException：空 path → invalid_tool_input，找不到能力 →
  capability_not_found。现在模型拿到误导性的 execution_interrupted。
- **L3** list_files 的 pattern 与 search_files 的 glob 同义不同名，
  additionalProperties=false 下互传即硬校验失败。统一为 glob
  （或内部归一化别名）。
- **L4** micro-compact 三个常量（KEEP_RECENT=6、水位 0.70/0.60）
  硬编码，docs/22 §3.1 明令「不能把参考实现的常量写成产品真理」。
  提为配置项，默认值即现值，docs/22 登记「待标定初值」。
- **L5** emitAttention 把同一 ObjectNode 塞 payload.attention 和
  payload.node 两个键，JSON 体积翻倍且前端从不读 attention 键。
  删掉 payload.set("attention", node)。

### 契约文档漂移（改文档不改代码）

- **D1** docs/08 §7.1/§7.4：status 词表 pending → waiting（代码与
  前端一致，是文档落后）；actions 示例从 string[] 改为
  [{id,label,tone}]；§3.6 字段表补 input 内嵌对象；§7.4 澄清数据
  位置从 payload.* 改为 node.input.*。
- **D2** docs/08 §7.3/§7.5 三个 GET 端点（approvals/{id}、
  conversations/{id}/approvals、tool-executions/{id}）未实现，
  标注「后续里程碑」——刷新恢复实际走 ConversationView 投影。
- **D3** docs/08 §8.1-8.3 capabilities 发现读 API 与 §9.1-9.2
  workspace 浏览 API 整族未实现且无消费者，标注未实现或改写为现行
  capability-admin 契约。
- **D4** docs/08 §5.6 GET /runs/{id} 未实现；实现侧
  GET /pipeline-runs/{id} 未登记且内联全量步骤输出（违反 §2.2
  引用式原则）——处理见 §3 结构性裁决。
- **D5** docs/08 §11.1 示范序列（render_node.updated 先于
  run.settled）与实际相反，前端无依赖，改文档对齐实现。

### 结构性裁决（进设计讨论，不在本批修）

- **S1** /pipeline-runs/{id} 是孤儿出口（前端零调用）且响应尺寸无界：
  删除，或收敛为引用式投影（steps 只回 id/kind/phase/failureCode +
  output 引用）。建议删除——有真实消费者再按引用式补。
  **已落地（2026-08-27）**：按删除执行，PipelineController 只留
  POST invoke；docs/08 改为已移除注记。
- **S2** errorCode→recovery 族映射收为单一事实源（ToolOutcome 携带
  recovery 类别，或 tools/core 一处常量表），加测试断言每个被产出
  的码落入已知族。M4 的最小修补先行，本项进 docs/42 P1。
  **已落地（2026-08-28）**：选方案 B——
  `tools/core/ToolErrorRecoveryCatalog` 一处常量表，ToolObservationService
  的恢复判定改为查表消费。不选 A 的理由：ToolOutcome 携带恢复族要求
  每个产码点（全部工具文件 + ToolRuntimeException 构造点）逐一改造，
  且扩展进程经插件协议透传任意码（ResidentProcessTool 转发插件 JSON
  的 code，内建浏览器扩展即走此路），生产侧自报无法约束第三方扩展；
  而方案 B 配合守卫测试正好满足「新造码不入表就在开发期炸」。
  表分三层：开放词法规则族（invalid_*、*_not_applied、*_version_changed
  等前缀/后缀）、精确登记（含显式登记为 replan 的已盘点码）、动态前缀
  （process_exit_、cancelled_before_）。守卫测试
  `ToolErrorRecoveryCatalogTest` 扫描 backend main 与 extensions/ 全部
  产码点（ToolRuntimeException / ToolOutcome.failed / completeFailure /
  合成终态 / 浏览器扩展 Failure 等），未登记的新码直接红灯；行为钉死
  测试保证判定结果与 M4 最小修补后逐点一致。第三方扩展运行期透传的
  未知码仍落 replan 兜底，属设计内容错。新造 errorCode 的规矩登记在
  docs/03 §2.2 与 docs/21 §6。
  **补齐（2026-08-28 复核）**：初版登记表漏了 19 个真实产码（守卫一跑
  即红）——backend 2 个（workspace_atomic_copy_unavailable、
  task_evidence_ref_invalid）与 extensions 17 个（python/sql/mes 族，
  含 dataFailure 的 industrial_demo_sql_unavailable）；全部按现运行期
  行为显式登记为 replan。守卫的产码点模式从 `new Failure(` 放宽为
  `new \w*Failure(`，覆盖 Calculate 的 CalcFailure 变体。

## 2. 修复分期

**第一批（正确性，后端为主）**：H1 窗口裁剪倒挂、M3 未知工具韧性、
M4 errorCode 最小修补、M5 PINNED 校验、M6 孤儿节点、M7 扩展 risk
fail-open、L1-L4。
验收：129 测试基线 + 新增钉死测试（H1 必带），无回归。

**第二批（流式链路，前端为主）**：H2 重水合断流与游标单调、M1 hub
溢出 fail-close、M2 delta 重复忽略 + eventId 去重、L5 payload 去重。
验收：前端 typecheck 通过；模拟重连/溢出路径人工验证。

**第三批（文档对齐）**：D1-D5 全部，顺手一批。

**后续批次**：M8 预览字段与 docs/42 §4-10 合流；S1/S2 按裁决执行。

## 附录 A：证伪豁免清单（12 条，备查）

以下疑点经对侧代码证据驳回，确认现状正确，下次审计免于重复检查：

1. SSE 干净关闭不重连——后端流是无限 Flux 从不 complete，done 路径
   不可达；projection.invalidated 事件未实现，契约内死路不存在。
2. attention actions 字符串数组导致审批反转——后端唯一构造点恒为
   {id,label,tone} 对象数组。
3. 后端发 pending 导致审批卡不出现——实际发 waiting，前后端词表
   逐字一致。
4. 澄清数据不在 node.input——后端投影真实内嵌完整 input，
   payload.attention 与 node 同对象。
5. 投机执行双执行/审批泄漏——toolCallId 条纹锁 + 早退对账 +
   eligible 判定用解析后真实目标 manifest，三层都成立。
6. 工具超时只是文档承诺——withDeadline 汇入实时取消信号，进程
   Runner 50ms 轮询 + 30 分钟硬上限。
7. run.settled 后尾随 render_node.updated 丢状态——前端 reducer
   无 settled 密封，版本闸 upsert 必然应用迟到事件。
8. 50ms 合批窗口 cursor 滞后——重连退避下限 1000ms，窗口不可达。
9. invoke_capability 代理 READ_ONLY 错标——模型可见 ToolDefinition
   无 riskLevel 字段；审批/并发/投机全部用解析后真实 manifest。
10. tool_result 缺 phase 过滤产生孤儿——tool_call 行与 attempt
    completed 同事务原子写入，孤儿无法产生。
11. micro-compact 装配期冻结脱钩 attempt 成败——freeze 与 Context
    Frame 快照同事务，正是 docs/22 §3.1 语义且保前缀稳定。
12. reference 投影可能无 contentHash——payload 与终态 execution
    同事务落库，orElse(null) 只是保险丝。
