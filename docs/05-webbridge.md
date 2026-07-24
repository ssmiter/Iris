# 05 · WebBridge：浏览器自动化

> 个人生活的高价值场景大多在网页里：秋招几百个网申、抢票、政务表单、比价下单。
> 纯 API 工具覆盖不了它们——必须驱动**真实的浏览器**。

## 1. 定位与形态

WebBridge 是一个独立的本地守护进程（daemon），通过 CDP（Chrome DevTools Protocol）驱动一个真实 Chrome 窗口：

```
对话："帮我把简历填到这个网申页面"
  → 模型调用 webbridge_* 工具
  → 后端转发给 daemon（127.0.0.1:9223，仅本机）
  → daemon 操作真实 Chrome
  → 页面状态/截图/结果回流，嵌入对话瀑布流
```

**借窗模式**：启动用户自己的 Chrome（带登录态），或新开一个干净窗口。模型操作，人随时接管——不是无头爬虫，是"借给用户一双手"。

## 2. 原语设计（webbridge_* 工具族）

| 原语 | 说明 |
|---|---|
| `webbridge_open(url)` | 打开/附着页面，返回 pageId |
| `webbridge_state(pageId)` | **页面状态**：可访问性树摘要（交互元素 + 文本 + 表单字段），这是模型的"眼睛" |
| `webbridge_click / fill / select / press` | 动作原语，selector 或语义定位（"姓名字段"） |
| `webbridge_screenshot(pageId)` | 截图（视觉校验：填对了吗） |
| `webbridge_extract(pageId, schema)` | 按 schema 抽取页面结构化数据 |
| `webbridge_takeover(pageId)` | 请求人工接管（登录/验证码/支付） |

设计要点：

- **页面状态 > 截图**：AX 树摘要 token 成本低且可动作；截图用于校验与疑难场景（视觉模型）。
- **动作后必回流状态**：每个动作原语返回新的页面状态摘要，模型不需要额外调用就能确认效果。
- **动作身份不可重造**：Backend 传入 `toolExecutionId + actionAttemptId + idempotencyKey + expectedObservationRef`；daemon 返回 `applied / not_applied / outcome_unknown + evidenceRef`。响应丢失时只能查询同一动作结果，不能生成新 attempt 再点一次。
- **选择器语义化**：优先 role/label/placeholder 定位，CSS/XPath 兜底——页面改版存活率完全不同。
- **风险由实际动作提升**：通用 click/fill/select/press 的 `prepare` 必须结合目标元素、页面语义和动作批次重新分类，风险只能维持或提升，不能把“点击最终提交”按一个普通 click 降级；无法判断时默认需要审批。

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

## 5. 安全模型

- daemon 只监听 `127.0.0.1`，启动时生成本机令牌，后端调用需带令牌；
- 单实例锁（端口 + 锁文件），僵尸进程自动监护回收；
- 所有动作写审计日志（时间/页面/动作/参数摘要）；
- 敏感字段（密码框）的值不进入页面状态摘要与日志。

## 6. 对话中的呈现（过程即内容）

- 运行中：浏览器画面以"舞台"卡片嵌入瀑布流——实时截图字幕（"正在填写：期望薪资"）、就地审批、接管按钮；
- 结束后：舞台收拢为一枚 chip（"操作了 3 个页面 · 42s"），点击可回看；
- 失败：断点截图 + 模型自诊断（"在'上传附件'步骤找不到文件选择器"）。

## 7. 技术选型权衡

| 方案 | 优 | 劣 |
|---|---|---|
| Node.js + CDP（裸协议） | 最轻、无依赖、对 Chrome 控制精细 | 自己实现元素定位/等待逻辑 |
| Node.js + Playwright | API 成熟、等待/定位开箱即用 | 多一层依赖 |
| **Java + Playwright**（并入后端，无独立 daemon） | 少一个进程，统一语言 | 打包体积大（浏览器驱动），Playwright Java 的 CDP 高级用法略绕 |

0.4 只冻结边界：**独立 `webbridge-daemon`、回环监听、本机令牌、Backend Connector 唯一调用方**。Node CDP、Node Playwright 或其他实现细节留到大陆 4 用真实“借窗”、定位与打包实验决定；不能为了少一个进程让 Frontend 直连浏览器，也不能让 daemon 拥有 Conversation、Pipeline 或审批真相。

## 8. 杀手场景：秋招网申流水线

1. 用户把简历/成绩单/证件照放进工作区 `job/`；
2. 对话："这是 50 家公司的网申入口清单（Excel），帮我逐个填写，遇到开放题先草稿给我审"——模型读 Excel → 逐站点执行；
3. 已知站点走录制好的工作流；未知站点模型现场探索（state → 填 → 校验）；
4. 每个站点产出一张结果卡（状态/截图/待人工项），全部写入工作区 `job/结果.md`；
5. 验证码/最终提交一律接管人工完成。

这个场景把工具平台、浏览器、工作区、审批、产物全部串起来——是 Iris 的"北极星用例"。
