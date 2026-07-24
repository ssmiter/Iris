# 11 · Iris 设计系统

> 状态：大陆 1 / 节点 1.1 已实现，等待验证
>
> 范围：定义并实现品牌表达、设计令牌、基础组件、复用边界和视觉验收方法。
>
> 参考基线：WonWork SVN working copy r188。只复用已经验证的通用设计与工程原语，不带入企业业务、前端 Agent Loop 或整文件历史包袱。

## 1. 节点目标

1. 建立亮色与暗色共享的语义令牌；
2. 提供 Button、Input、Card、Badge、Modal、Toast 六个基础组件；
3. 让后续瀑布流、审批、产物和 Composer 只使用语义令牌，不散落硬编码颜色；
4. 保留 WonWork 已经验证的交互尺度，同时让 Iris 形成自己的气质；
5. 用一个临时 Design System Preview 做视觉和键盘验收，不提前实现节点 1.2 的对话界面。

节点完成的判断不是“出现了一套彩虹色”，而是后续组件不必再次决定颜色、间距、圆角、焦点和动效规则。

## 2. 品牌表达先修正

### 2.1 产品名怎样出现

- 产品界面主名称只写 **Iris**；
- “虹使”保留在 About、命名故事和中文说明中，不再固定拼成 `Iris · 虹使`；
- 不让产品用第三人称神话称谓谈论自己；
- README 重写时先同步 `docs/10-naming-and-identity.md`，再统一应用名、网页标题和说明文字。

现有空状态：

```text
Iris · 虹使
把日常琐事交给知根知底的虹使。
```

改为更自然的产品语言：

```text
Iris
想先处理哪件事？
文件、网页，或一个还没理清的念头，都可以从这里开始。
```

这不是最终空状态文案，但它确立语气：安静、直接、有能力，不自我神化。

### 2.2 品牌性格

| 关键词 | 视觉结果 | 文案结果 |
|---|---|---|
| 清醒 | 高可读性、少玻璃、少装饰 | 先说结果，不说空泛鼓励 |
| 温和 | 暖中性底色、柔和边界 | 不命令、不评判 |
| 可靠 | 稳定状态色、明确焦点与终态 | 说明做了什么、还差什么 |
| 轻盈 | 稀疏光谱、克制阴影 | 句子短，少拟人化口号 |

### 2.3 彩虹怎样使用

彩虹是身份签名，不是界面填充色：

- Logo、启动瞬间、当前活动锚点可以出现光谱；
- 普通按钮只使用单一 Iris 主色；
- 成功、警告、危险使用稳定语义色，不随生活域换色；
- 不给求职、出行、财务永久分配彩虹色，避免颜色同时承担品牌、导航和状态三种含义；
- 单屏最多一个持续可见的光谱焦点。

建议品牌光谱：

```text
coral #E98178 → gold #D8A542 → mint #62B891
→ sky #6FA7D8 → iris #787EDB
```

它比七段高饱和彩条更像雨后折射，也更适合长时间桌面使用。

## 3. WonWork 复用矩阵

### 3.1 直接继承的设计结论

| 来源 | 复用内容 | Iris 落点 |
|---|---|---|
| `src/index.css` | 对话列宽 `780px`、水平 padding `24px` | `--conversation-max`、`--conversation-pad` |
| `src/index.css` | Composer 与 Turn 共用列宽公式 | 节点 1.3 延续相同对齐约束 |
| `src/index.css` | Windows/中文系统字体 fallback | Iris 默认离线字体栈 |
| `tailwind.config.js` | Tailwind 3 + Typography 的稳定配置方式 | 保持相同工具链，不在 1.1 同时升级框架范式 |
| `package.json` | `cva + clsx + tailwind-merge` | 组件 variant 与 class 合并 |
| `package.json` / `Toast.tsx` | Sonner 作为 Toast 基础 | 包一层 Iris 安全默认值 |
| Chat 卡片 | `rounded-xl + neutral border + light shadow` 的共享外壳 | Card 的 `outlined / raised` 变体 |
| Approval/Artifact Card | 风险卡有强调边，普通产物保持中性 | 后续节点复用语义，不让所有卡片染色 |
| 多处组件 | `motion-reduce:transition-none` | 每个动效组件的硬性要求 |

这些结论可以直接复用，不需要重新争论。

### 3.2 只复用结构、必须适配的部分

| WonWork 设计 | Iris 的改造 |
|---|---|
| 冷蓝 `surface` 灰阶 | 改成暖中性 canvas/surface，同时保持层级数量 |
| 通用 indigo `primary` | 改成 Iris violet-blue，保持按钮交互成熟度 |
| 22px 玻璃 Composer | 保留浮动体积与对齐，减少常态 blur 和阴影 |
| Approval Card 信息层级 | 保留“影响先于参数、主次操作明确”，颜色进入语义令牌 |
| Artifact Card Shell | 保留中性共享外壳，代码在 Iris 中按新组件契约实现 |

### 3.3 不复用

- 数百行 `wf-*` 全局组件 CSS；
- 前端 Agent Loop、巨型 chatStore 和消息反推状态；
- 企业业务视图、登录、许可、支付和 Workflow 编辑器；
- 到处直接写 `blue-500 / amber-50 / #xxxxxx`；
- 自制但未统一验证焦点管理的 Modal；
- “所有控件都是 rounded-lg + transition-all”的无差别样式；
- 运行时宽度档位、权限模式等不属于节点 1.1 的功能。

“可直接复用”指复用成熟决策、依赖和小型原语，不是复制一个包含历史职责的文件再改名。

## 4. 令牌架构

### 4.1 三层令牌

```text
Primitive
  neutral / iris / spectrum / status 的原始色阶
        ↓
Semantic
  canvas / surface / text / border / action / focus / feedback
        ↓
Component
  button / input / card / modal / toast 的状态组合
```

业务组件只使用 Semantic 或 Component token。Primitive 只允许在令牌定义文件和品牌资产中出现。

### 4.2 CSS 表达

颜色变量保存 RGB channel：

```css
:root {
  --color-canvas: 247 247 244;
}

[data-theme='dark'] {
  --color-canvas: 17 19 16;
}
```

Tailwind 映射：

```ts
canvas: 'rgb(var(--color-canvas) / <alpha-value>)'
```

这样保留 opacity modifier，同时让主题切换不需要生成两套 class。

## 5. 颜色

### 5.1 亮色

| Token | Value | 用途 |
|---|---:|---|
| `canvas` | `#F7F7F4` | 应用背景 |
| `surface` | `#FCFCFA` | 普通内容面 |
| `surface-raised` | `#FFFFFF` | 浮层、Composer、Modal |
| `surface-muted` | `#F0F1EC` | 次级区块、hover |
| `text` | `#1F211E` | 主文本 |
| `text-subtle` | `#62675F` | 次文本 |
| `text-muted` | `#858B82` | 辅助信息 |
| `border` | `#E2E4DE` | 常规边界 |
| `border-strong` | `#C7CBC2` | active/分隔强调 |
| `primary` | `#575FC7` | 主动作 |
| `primary-hover` | `#474FAF` | 主动作 hover |
| `primary-soft` | `#EEF0FF` | 选中与轻提示 |
| `focus` | `#6A73E3` | 键盘焦点 |
| `success` | `#267A58` | 已验证成功 |
| `warning` | `#956017` | 需留意 |
| `danger` | `#B94045` | 危险与失败 |
| `info` | `#3D6EAA` | 中性信息 |

### 5.2 暗色

| Token | Value |
|---|---:|
| `canvas` | `#111310` |
| `surface` | `#171A16` |
| `surface-raised` | `#1D211C` |
| `surface-muted` | `#252A23` |
| `text` | `#F2F3EE` |
| `text-subtle` | `#B7BBB2` |
| `text-muted` | `#8B9187` |
| `border` | `#2D332B` |
| `border-strong` | `#444C41` |
| `primary` | `#AAB0FF` |
| `primary-hover` | `#BBC0FF` |
| `primary-soft` | `#292D50` |
| `focus` | `#B9BEFF` |
| `success` | `#72C89D` |
| `warning` | `#E0B266` |
| `danger` | `#F08B8F` |
| `info` | `#8DB8EA` |

暗色不是亮色反相。Raised surface 只比背景亮一层，避免深色界面变成一叠发光卡片。

### 5.3 对比度规则

- 正文与 canvas/surface 至少达到 WCAG AA；
- primary button 文本单独验证，不假定白色永远适合；
- muted text 只承载辅助信息，不能承载唯一状态；
- focus ring 与相邻 surface 必须可见；
- 状态同时使用图标/文字/结构，不只用颜色。

执行阶段用脚本计算固定 token pair 的 contrast ratio，并将结果写进验证记录。

## 6. 字体

首版不依赖在线字体，保证 Windows exe 离线一致：

```text
sans:
"Segoe UI Variable", "Segoe UI", "PingFang SC",
"Microsoft YaHei UI", system-ui, sans-serif

mono:
"Cascadia Code", "SFMono-Regular", Consolas, monospace
```

| Style | Size / line-height | Weight | 用途 |
|---|---|---:|---|
| display | `32 / 38` | 650 | 空状态、启动页 |
| title | `24 / 31` | 650 | 页面标题 |
| heading | `18 / 26` | 600 | 区块标题 |
| body | `15 / 25` | 400 | 对话与正文 |
| body-strong | `15 / 25` | 600 | 重要短句 |
| small | `13 / 19` | 400/600 | 组件辅助信息 |
| caption | `11.5 / 16` | 500 | 时间、状态、元数据 |
| code | `13 / 20` | 400 | 参数、路径、代码 |

正文默认 15px，直接继承 WonWork 在长对话中的可读尺度；基础组件不得用任意 `text-[Npx]` 创造新层级。

## 7. 空间、圆角和阴影

### 7.1 空间

以 4px 为主节拍，允许 2px 微调：

```text
0, 2, 4, 6, 8, 10, 12, 16, 20, 24, 32, 40, 48, 64
```

### 7.2 圆角

| Token | Value | 用途 |
|---|---:|---|
| `radius-xs` | `6px` | 小标签、紧凑控制 |
| `radius-sm` | `10px` | Button、Input |
| `radius-md` | `14px` | Card |
| `radius-lg` | `18px` | 浮层 |
| `radius-xl` | `24px` | Composer |
| `radius-pill` | `999px` | 状态 chip |

不是所有元素都使用同一个 `rounded-lg`。圆角大小表达容器层级。

### 7.3 阴影

```text
shadow-hairline: 0 1px 0 rgb(31 33 30 / .04)
shadow-raised:   0 8px 24px rgb(24 27 23 / .08)
shadow-floating: 0 16px 48px rgb(24 27 23 / .12)
focus-ring:      0 0 0 3px rgb(var(--color-focus) / .22)
```

- 普通 Card 默认无投影或只有 hairline；
- Composer 使用 raised；
- Modal 使用 floating；
- hover 不通过突然增加大阴影制造跳动。

## 8. 布局令牌

```text
--conversation-max: 780px
--conversation-pad: 24px
--page-gutter: clamp(16px, 3vw, 32px)
--composer-bottom: 16px
--sidebar-width: 248px       # 1.2 才使用
--topbar-height: 48px        # 1.2 才使用
```

`conversation-max` 和 `conversation-pad` 直接继承 WonWork 已验证的对齐值。Composer 与 Turn 必须引用同一变量，不能再次出现 720/780 两套宽度。

## 9. 动效

### 9.1 时长

| Token | Value | 用途 |
|---|---:|---|
| `motion-instant` | `90ms` | 按压反馈 |
| `motion-fast` | `140ms` | hover、颜色 |
| `motion-normal` | `200ms` | 小型展开 |
| `motion-deliberate` | `280ms` | Modal、面板 |
| `motion-attention-exit` | `360ms` | 审批两阶段退场 |

### 9.2 曲线

```text
standard: cubic-bezier(.2, 0, 0, 1)
enter:    cubic-bezier(.16, 1, .3, 1)
exit:     cubic-bezier(.4, 0, 1, 1)
```

### 9.3 规则

- 默认只动画 `opacity / transform / color / border-color`；
- 高度动画只用于用户需要看懂“内容去了哪里”的收拢；
- 禁止常态 `transition-all`；
- 只有当前活动锚点允许低频 pulse；
- `prefers-reduced-motion: reduce` 下立即完成，不用“缩短到仍会移动”；
- 流式文本动画属于节点 1.2，不在基础组件里实现。

## 10. 基础组件契约

### 10.1 Button

```text
variant: primary | secondary | ghost | danger
size: sm | md | lg | icon
state: default | hover | active | focus-visible | disabled | loading
```

- 使用原生 `button`；
- loading 保留宽度并设置 `aria-busy`；
- icon-only 必须有 accessible name；
- danger 只用于直接危险动作，不用于普通“拒绝”；
- variants 用 CVA 声明，class 通过统一 `cn()` 合并。

### 10.2 Input

组合为 `Field + Label + Control + Description/Error`：

- `id`、label、description、error 的 aria 关系完整；
- error 不通过 placeholder 表达；
- disabled 与 readOnly 视觉不同；
- focus 使用统一 ring；
- 1.1 只实现单行 Input；Composer Textarea 属于 1.3。

### 10.3 Card

```text
variant: plain | outlined | raised | interactive
padding: none | sm | md | lg
```

- Card 默认中性，不内置业务状态；
- interactive Card 必须是 link/button 或内部有明确动作，不能让 `div` 假装可点击；
- Approval 与 Artifact 后续组合 Card，不复制外壳。

### 10.4 Badge

```text
tone: neutral | info | success | warning | danger
appearance: soft | outline
```

- 可选 dot/icon，但始终保留文字；
- 不用于长句；
- 状态文案由业务层提供，Badge 不推断状态。

### 10.5 Modal

实现采用成熟的无障碍 Dialog primitive，不复制 WonWork 各业务 Modal：

- controlled open state；
- focus trap、Esc、overlay click 和焦点归还；
- `aria-labelledby / describedby`；
- `sm / md / lg` 三种宽度；
- body 可滚动，header/footer 稳定；
- danger confirmation 是 Modal 的组合，不是 Modal 内置逻辑。

计划使用 `@radix-ui/react-dialog`，避免在 1.1 自己重造焦点管理。

### 10.6 Toast

直接沿用 WonWork 已验证的 Sonner 方案，并包成 Iris 默认：

- 位置 `top-right`，避开底部 Composer；
- 默认 4 秒，可关闭；
- `success / info / warning / error`；
- 同时可见数量受限，重复错误按 key 合并；
- Toast 只表示短期反馈，审批、澄清和未知副作用必须进入 Attention，不得用 Toast 替代。

## 11. 工程方案

### 11.1 保留版本边界

节点 1.1 不升级 React、Vite、TypeScript、zustand 或 react-virtuoso。只加入设计系统必需依赖，降低变量数量。

复用 WonWork 已验证的 Tailwind 3 配置范式：

```text
devDependencies:
tailwindcss 3.4.x
postcss
autoprefixer
@tailwindcss/typography

dependencies:
class-variance-authority
clsx
tailwind-merge
lucide-react
sonner
@radix-ui/react-dialog
```

版本在执行时由 lockfile 固定；不使用浮动 `latest`。

### 11.2 计划文件

```text
frontend/
├── tailwind.config.ts
├── postcss.config.js
└── src/
    ├── index.css
    ├── styles/
    │   ├── tokens.css
    │   ├── base.css
    │   └── utilities.css
    ├── lib/
    │   └── cn.ts
    ├── components/ui/
    │   ├── Button.tsx
    │   ├── Input.tsx
    │   ├── Card.tsx
    │   ├── Badge.tsx
    │   ├── Modal.tsx
    │   ├── Toast.tsx
    │   └── index.ts
    └── components/dev/
        └── DesignSystemPreview.tsx
```

同时更新：

- `docs/10-naming-and-identity.md`：品牌展示名、中文语气和光谱规则；
- `frontend/src/App.tsx`：暂时挂载 Preview，节点 1.2 替换；
- `frontend/package.json` 与 lockfile；
- `.codex/state.json`。

### 11.3 明确不动

- `agent/types.ts` 和 `stores/chatStore.ts` 的 Agent/SSE 结构留给后续节点按 0.4 契约重构；
- 不在 1.1 实现 WaterfallTurn、Composer、Sidebar、主题设置页；
- 不引入完整组件框架或复制 shadcn 目录；
- 不生成 Logo 位图；
- 不为了 Preview 增加第二套路由或状态管理。

## 12. 执行顺序

1. 先更新 `docs/10-naming-and-identity.md`，冻结品牌表达；
2. 安装并锁定最小依赖；
3. 建立 Tailwind、PostCSS、CSS token 与 dark theme；
4. 实现 `cn()` 和六个基础组件；
5. 建立临时 Preview，覆盖全部 variant/state；
6. 运行 build 和 token 硬编码检查；
7. 在浏览器做亮/暗、键盘、响应式和 reduced-motion 验收；
8. 修订本文件为“已实现基线”，更新 state，提交节点 1.1；
9. 等待用户确认 1.1，再进入 1.2。

## 13. 验收

### 13.1 自动验证

```text
npm run build
JSON/package/tsconfig 可解析
Tailwind content path 覆盖 src
非品牌实现文件不散落原始 hex
light/dark 固定文字与按钮 contrast pair 达到 AA
```

### 13.2 视觉尺寸

至少检查：

```text
1440 × 900   Windows 桌面常规窗口
1024 × 768   紧凑桌面窗口
390 × 844    窄屏退化
```

每个尺寸检查亮色和暗色：

- 字体与层级清晰；
- Preview 无横向溢出；
- Modal 不超出视口；
- focus ring 不被裁切；
- Toast 不遮挡关键主操作；
- 颜色、阴影和圆角没有“每个组件都在争抢注意力”。

### 13.3 交互与可访问性

- 只用键盘可以依次操作全部组件；
- Modal 打开、Tab 环、Esc 和焦点归还正确；
- Button loading/disabled 不重复触发；
- Input error 被屏幕阅读器关联；
- reduced-motion 下无位移和脉冲；
- 对比度与状态表达不依赖颜色猜测。

### 13.4 节点完成标准

节点 1.1 完成时，后续开发者应能只使用令牌和基础组件搭出新界面，不再临时决定：

- 主色、状态色和主题；
- 字号、间距、圆角和阴影；
- focus、disabled、loading 和 error；
- Modal 与 Toast 的可访问性；
- 动效时长与 reduced-motion；
- 哪些 WonWork 设计可以复用，哪些历史包袱禁止进入 Iris。
## 14. 实现记录（2026-07-24）

节点 1.1 的实现主体已经落地，当前状态为“等待验证”，不是“已完成”。

已实现：

- 三层颜色令牌、亮暗主题、字体、间距、圆角、阴影、布局与动效令牌；
- Tailwind 3、PostCSS 与 Typography 配置；
- `cn()` 类名合并原语；
- Button、Input、Card、Badge、Modal、Toast 六个基础组件；
- Card 的可操作区域由 `CardAction` 承载，避免让普通 `div` 冒充按钮；
- 主题读取、应用与本地偏好保存；
- Design System Preview，覆盖主题切换、主要变体、输入状态、Modal 与 Toast；
- Iris 品牌称谓、中文语气和稀疏光谱规则。

实际文件比 11.2 的初始计划多出 `frontend/src/theme/theme.ts`，用于隔离主题状态与 DOM 应用逻辑。

尚未执行：

- TypeScript 与生产构建；
- 固定 token pair 的对比度计算；
- 原始色值散落检查；
- 亮暗主题、键盘、响应式与 reduced-motion 浏览器验收。

这些验证按用户要求暂缓。验证通过、问题修正并记录证据后，节点才能改为“已完成”并提交。

### 14.1 联合验证记录（2026-07-24）

- `npm run build`：通过，TypeScript 与 Vite 生产构建成功；
- 非令牌实现文件的原始 hex / Tailwind 原始色阶扫描：未发现；
- light/dark 的 primary、正文和 danger 六组关键对比度：`5.41–16.75`，均达到 WCAG AA；
- 真实浏览器视觉与交互：当前桌面会话未提供浏览器控制连接，待后续补验。
