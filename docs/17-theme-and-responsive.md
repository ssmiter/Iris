# 17 · 主题与响应式骨架

> 状态：大陆 1 / 节点 1.5 已实现，等待大陆 1 统一验证
>
> 依赖：`docs/11-design-system.md`、`docs/16-frontend-state-management.md`

## 1. 目标

收口大陆 1 的界面环境适配：

- theme 只有 `viewStateStore.theme` 一份前端真相；
- 首次进入尊重已保存偏好，否则读取系统主题；
- desktop、compact desktop 和 narrow 三种布局连续缩放；
- 窄屏保留 Turn、过程、Attention 和 Composer 的完整语义；
- sidebar 在桌面占布局空间，在窄屏成为可关闭 overlay；
- reduced-motion 下所有位移与揭示即时完成。

## 2. 断点不是设备分类

```text
wide     ≥ 1180px  sidebar + conversation pane
compact  768–1179  收窄 sidebar，conversation 保持 780px 上限
narrow   < 768px   sidebar overlay，Turn/Composer 使用安全边距
```

不根据 user-agent 判断设备。Windows 窄窗口与移动宽度使用同一 CSS 行为。

## 3. App Shell

```text
ConversationShell
├── Sidebar
├── MainPane
│   ├── Header
│   ├── ConversationTimeline
│   └── ComposerDock
└── MobileOverlay
```

大陆 1 的 Sidebar 只显示模拟会话导航和状态，不实现后端 CRUD。它减少“当前在哪个对话”的寻找，同时为节点 1.4 的 `conversationStore` 提供真实消费点。

## 4. 窄屏规则

- 用户请求最大宽度由 86% 放宽到 92%，但不贴边；
- `--conversation-pad` 从 24px 降到 14px；
- Composer footer 次要提示可隐藏，发送和停止保持可见；
- permission mode 保留短标签，附件按钮不消失；
- 长 Attention 动作允许换行；
- header 只保留 sidebar、Iris、状态和主题动作；
- Toast 避开 header，并限制宽度；
- sidebar overlay 使用 Modal 同等级焦点与遮罩语义，不和页面同时可交互。

## 5. 主题

- theme 应用由单个 effect 完成；
- 切换时写入小粒度持久化状态；
- CSS 组件只引用语义 token；
- `color-scheme` 与 `data-theme` 同步；
- 暗色不是亮色反相，不额外增加发光阴影；
- 系统主题变化只在用户尚未明确保存偏好时跟随。首版保存后以用户选择为准。

## 6. 验证合并

节点 1.5 实现后统一测试大陆 1：

- 1.1 令牌与基础组件；
- 1.2 瀑布流、虚拟滚动和折叠；
- 1.3 Composer、IME、补充和停止；
- 1.4 hydration、selector 与视图状态；
- 1.5 主题、sidebar overlay 和三档宽度。

## 7. 实现记录（2026-07-24）

- 新增 `ConversationShell`，统一 sidebar、header、timeline 与 Composer 的高度边界；
- desktop sidebar 消费真实 `conversationStore` 摘要；
- 窄屏 sidebar 使用 Radix Dialog，具备遮罩、焦点管理、Esc 与触发点归还；
- desktop sidebar 开合与 mobile overlay 分开保存，避免断点切换互相污染；
- theme 只从 `viewStateStore` 读取，并由 Shell 单一 effect 应用；
- `<768px` 使用 14px conversation padding、12px page gutter 与 52px header；
- 窄屏隐藏次要快捷键提示，但保留附件、权限、停止和发送；
- 用户请求宽度在窄屏放宽到 92%，桌面仍使用更克制上限；
- sidebar 动画和所有揭示继续服从 reduced-motion。

真实断点、overlay、主题与 Toast 位置等待统一浏览器验收。

## 8. 大陆 1 统一验证记录（2026-07-24）

通过：

- `npm run build`，包含 TypeScript 与 Vite production build；
- 1842 个模块完成打包；
- Vite 本地服务真实启动，`GET /` 返回 200 且包含 root mount；
- 非 token 文件的原始 hex / Tailwind 原始色阶扫描；
- light/dark primary、正文与 danger 六组关键对比度，范围 `5.41–16.75`；
- `git diff --check` 无 whitespace error。

观察项：

- 单入口 JS 为 513.20 kB，超过 Vite 500 kB 提示线；当前主要由 React Markdown、Radix、Virtuoso 和 Preview 同入口造成。没有性能证据前不预先拆包，大陆 2 接入真实路由或加载边界时再测量；
- 当前 Codex 桌面会话没有提供 Browser 控制连接，因此 1440 / 1024 / 390 三档视觉、IME、焦点、sidebar overlay、长列表滚动与 reduced-motion 尚未自动验收；
- 该缺口被保留为大陆 1 follow-up，不把它写成通过。用户已授权在代码验证后继续后续实现。

## 8. 大陆 1 统一验证记录（2026-07-24）

通过：

- `npm run build`，包含 TypeScript 与 Vite production build；
- 1842 个模块完成打包；
- Vite 本地服务真实启动，`GET /` 返回 200 且包含 root mount；
- 非 token 文件的原始 hex / Tailwind 原始色阶扫描；
- light/dark primary、正文与 danger 六组关键对比度，范围 `5.41–16.75`；
- `git diff --check` 无 whitespace error。

观察项：

- 单入口 JS 为 513.20 kB，超过 Vite 500 kB 提示线；当前主要由 React Markdown、Radix、Virtuoso 和 Preview 同入口造成。没有性能证据前不预先拆包，大陆 2 接入真实路由或加载边界时再测量；
- 当前 Codex 桌面会话没有提供 Browser 控制连接，因此 1440 / 1024 / 390 三档视觉、IME、焦点、sidebar overlay、长列表滚动与 reduced-motion 尚未自动验收；
- 该缺口被保留为大陆 1 follow-up，不把它写成通过。用户已授权在代码验证后继续后续实现。
