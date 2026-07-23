# 07 · 前端架构与设计语言

> 视觉由你自己设计（这是你的追求与强项）。本文给骨架：模块、数据流、必须守住的不变量，
> 以及经过验证的设计语言提炼——照着能还原 90% 的"为什么"。

## 1. 模块骨架

```
frontend/src/
├── agent/                  对话内核（与 UI 无关，可单测）
│   ├── agenticLoop.ts      循环：轮次/补充注入/审批挂起/停止
│   ├── toolExecutor.ts     工具路由：本地工具 or 后端 invoke
│   ├── renderNodeBuilder.ts 消息 → renderNodes（渲染的唯一数据源）
│   └── tools/              前端本地工具（文件/发现原语/web）
├── stores/
│   ├── chatStore.ts        对话状态：消息/分支/压缩/审批/队列/补充
│   ├── conversationStore.ts 会话列表与切换
│   └── viewState.ts        IndexedDB 叶子模块（分支/压缩持久化，无重依赖！）
├── api/                    后端契约客户端（docs/08），SSE 解析器
├── components/Chat/
│   ├── MessageList.tsx     虚拟列表（react-virtuoso）+ 滚动跟随状态机 + 浮动审批栏
│   ├── WaterfallTurn.tsx   轮次渲染：摘要行/过程流/答案/轮次分组
│   ├── FlowNode.tsx        单节点渲染（thinking/tool/attention）
│   ├── InputArea.tsx       composer：输入/斜杠菜单/幽灵补全/权限模式
│   ├── ComposerTray.tsx    排队/待注入 chips
│   ├── ComposerRibbon.tsx  运行缎带（● 正在执行 · 12s）
│   └── CompactBar.tsx      压缩进度条
└── index.css               全部 wf-* 样式（设计令牌集中在此）
```

## 2. 数据流铁律

1. **renderNodes 是渲染的唯一真相**：UI 不解析消息文本推断状态；流式事件先更新 renderNodes，组件只读。
2. **折叠状态纯手动**：过程区展开/收起只由用户点击改变；流式 delta、phase 变化、轮次切换**绝不**触碰折叠状态（视线锚定）。
3. **滚动跟随状态机**：跟随（新内容推历史向上）↔ 翻阅（上翻暂停跟随，出现"回到最新"胶囊 + N 轮新内容计数）。
4. **叶子模块防 TDZ**：viewState 这类被 store 顶层 import 的工具模块不得 import 任何重依赖（api 链/store 链），否则生产构建循环引用白屏。

## 3. 设计语言提炼（通用令牌）

| 令牌 | 值 | 用于 |
|---|---|---|
| 墨 | #1c1c1e / #23252b | 正文、主按钮、强调 |
| 灰阶 | #6b7280 / #9ca3af / #aeaeb2 | 次要文字、提示 |
| 细线 | #ececee | 边框、分隔 |
| 底 | #fafafa / rgba(255,255,255,.88)+blur | 页面、浮层 |
| 风险点 | 灰/琥珀#d97706/红#dc2626（仅 6px 圆点） | 审批风险暗示 |
| 字 | 正文 14px/1.5；提示 10.5-12px；数字用 mono | — |

**交互范式**（可直接复用的七个）：

1. **摘要行**：`▶ 第 1-2 轮 · 思考 3s · 调用 4 个工具 · 共 12s`——折叠态的信息密度极限。
2. **两阶段退场**：先原地淡化（0.45s），再收拢高度（0.3s）——反馈即时，布局后动。
3. **chip 化反馈**：补充/排队不占气泡层级，chip 入场→淡出即完成告知。
4. **整条可点**：审批条整条 = 主操作，图标按钮 = 次操作，快捷键提示收敛为首条一枚 kbd。
5. **细轨道进度**：压缩/加载用 2px 轨道微光流动，不用转圈 spinner。
6. **幽灵补全**：斜杠命令首候选剩余字符以浅灰 inline 呈现。
7. **垂直堆叠新在底**：多条浮层（审批）追加在最靠近 composer 处，注意力不追远。

## 4. composer 区域结构（从上到下）

```
ComposerTray    排队/待注入 chips（有内容才出现）
ComposerRibbon  运行缎带（运行中才出现，中性墨色，停止只在输入框内）
CompactBar      压缩进度条（压缩中才出现）
引用 chip       选中正文引用（有引用才出现）
输入胶囊        cp-mirror 幽灵补全 + textarea + 权限模式 + 附件 + 发送/停止
hintbar         左：当期提示；右：上下文水位 + 列宽档位
```

## 5. 性能红线

- 长列表必须虚拟化；单条消息 memo（content 不变跳过重渲染）；
- 流式渲染用"逐字揭示 + 前缘动画"而非整体重排；
- IndexedDB 写入 600ms 防抖；读取水合异步不阻塞首屏；
- 生产构建警惕循环 import（见 §2.4）。
