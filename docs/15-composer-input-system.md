# 15 · Composer 与输入系统

> 状态：大陆 1 / 节点 1.3 已实现，等待验证
>
> 依赖：`docs/07-frontend-architecture.md`、`docs/08-api-contract.md`、`docs/11-design-system.md`
>
> 参考切片：WonWork SVN working copy r188 的 `InputArea`。复用 IME 安全、Enter/Shift+Enter、自动增高、运行中补充与停止入口等交互结论；不复制斜杠菜单、文件业务、幽灵补全和前端 Agent Loop。

## 1. 节点目标

实现一个只负责“表达人的意图”的 Composer：

- 多行 textarea，1–8 行自动增高；
- 空闲时 Enter 提交新 Turn，Shift+Enter 换行；
- Turn 活跃时 Enter 提交 Supplement，不伪装成新 Turn；
- 运行中提供唯一停止入口；
- 附件按钮只做视觉占位，不读取文件；
- 提供 `bypass / auto / confirm / sandbox` 四种运行偏好；
- pending Supplement 以可撤回 chip 呈现在 Composer 上方；
- 所有动作通过回调交给命令层，不直接修改 Turn/Run/Attention 事实。

## 2. 安全语义

权限模式是用户对“询问频率”的偏好，不是客户端授权，也不能覆盖后端策略。

| 协议值 | UI 名称 | 首版语义 |
|---|---|---|
| `bypass` | 尽量自动 | 无副作用操作尽量自动；任何外部写入仍确认 |
| `auto` | 平衡 | 常规只读自动；高影响读取与所有写入确认 |
| `confirm` | 每步确认 | 包括只读工具在内，每一步都确认 |
| `sandbox` | 只读 | 只允许只读能力，写入直接拒绝 |

这四个值只随用户设置或 Turn command 作为偏好传递。真正的 risk、side effect、Approval 与 Commit Gate 由后端根据 Tool Manifest 和 Operation Snapshot 决定；Frontend 不能发送 `approved=true`。

## 3. 输入规则

- `Enter`：空闲时发送 Turn；运行时发送 Supplement；
- `Shift+Enter`：换行；
- 中文输入法 composition 期间不拦截 Enter；
- 纯空白不发送；
- 发送成功回调后才清空草稿；回调失败保留原文；
- textarea 高度在内容、容器宽度和字体变化时重新测量；
- 达到 8 行后内部滚动，Composer 不继续挤压时间线；
- 运行状态切换不修改草稿。

## 4. Supplement 生命周期

Composer 只负责本地乐观项：

```text
submitting → pending → injected | cancelled | promoted
```

本节点静态 Preview 只模拟 `pending / cancel`。生产接入时：

- POST 接受后用服务端 `supplementId` 替换 `clientRequestId`；
- SSE 决定 injected/promoted；injected 后 chip 退场，并在后端指定的 Round 位置按普通用户
  消息呈现，Frontend 不看相邻 FlowNode 猜；
- stop 后未注入文本仍保留；
- 撤回已经注入的补充必须显示 `409 supplement_already_injected`，不能假装成功。

## 5. 组件边界

```text
ComposerDock
├── SupplementQueueTray
├── ComposerTextarea
├── PermissionModeSelect
├── AttachmentPlaceholder
└── SendSupplementOrStopActions
```

`ComposerDock` 是 controlled component。草稿和临时高度可以留在组件内；permission mode、pending supplements 与 active Turn 来自上层。节点 1.4 再把这些状态迁入 store。

## 6. 视觉原则

- Composer 与 Turn 使用同一 `--conversation-max`；
- 默认只显示一个稳定容器，不堆多层玻璃；
- 发送按钮是唯一持续主色面；
- 运行提示使用文字与结构，不持续闪烁；
- pending chip 明确写“待送入”，避免让用户误以为模型已经看到；
- 停止按钮与发送按钮位置稳定，减少重新寻找；
- 附件和权限入口保持次级，不与输入争抢注意力。

## 7. 文件

```text
frontend/src/
├── domain/chat/input.ts
└── components/chat/composer/
    ├── ComposerDock.tsx
    ├── ComposerTextarea.tsx
    ├── PermissionModeSelect.tsx
    ├── SupplementQueueTray.tsx
    └── index.ts
```

`WaterfallPreview` 接入受控演示状态：可切换空闲/运行，发送新 Turn、补充、停止和附件占位只产生本地反馈，不伪造后端接受或终态。

## 8. 验证

实现完成后与现有前端统一验证：

- TypeScript/Vite 构建；
- 中文输入法 composition；
- Enter / Shift+Enter；
- 1–8 行自动增高和最大高度滚动；
- 空闲发送、运行中补充、停止；
- pending chip 撤回；
- 四种权限偏好与安全文案；
- 键盘焦点、窄屏、亮暗主题、reduced-motion。

## 9. 实现记录（2026-07-24）

已实现：

- controlled `ComposerDock`；
- 1–8 行自动增高的 `ComposerTextarea`；
- composition 期间不拦截中文输入法 Enter；
- 空闲发送与运行中 Supplement 的分流；
- pending Supplement chip 与撤回；
- 运行中唯一停止入口；
- 原生可访问的权限模式选择；
- 只产生本地反馈、不读取文件的附件占位；
- Waterfall Preview 的空闲/运行切换和完整演示回调。

当前实现仍使用 Preview 局部状态。节点 1.4 会把 draft、permission mode、pending supplements 和 active Turn selector 迁入职责明确的 store。节点 1.3 尚未单独运行构建和浏览器验收。

### 9.1 统一验证更新

节点 1.4 已完成上述状态迁移；大陆 1 统一 `npm run build` 通过，Composer 类型与生产打包通过。IME、自动增高和窄屏触控仍需在浏览器控制可用后补验。

### 9.1 统一验证更新

节点 1.4 已完成上述状态迁移；大陆 1 统一 `npm run build` 通过，Composer 类型与生产打包通过。IME、自动增高和窄屏触控仍需在浏览器控制可用后补验。
