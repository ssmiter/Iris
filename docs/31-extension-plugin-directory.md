# 31 · 拓展与插件：目录即对象

> 本文是 Iris 插件式拓展的地基规范。先于代码；改插件机制先改本文。
> 上游约定：CLAUDE.md 五条不变量、docs/03 工具平台、docs/26 对象与能力假设。

## 1. 设计原点

Iris 管理的对象只有一种组织方式：**目录**。文件是目录里的载体，工具是目录里的过程，
技能是目录里的指引，知识是目录里的语料——它们对模型同构：都能用 ls/grep/read 那套
发现原语逐步找到，按需读取，按规约使用。

插件因此不是"安装进内核的组件"，而是**放进拓展根的一个目录**。开发一个工具 =
新建文件夹 + 写清单 + 写执行体；工具的外部依赖（数据库连接、SDK、凭据）由工具自己
管理，内核不提供也不感知。内核只对目录做四件事：扫描、校验、投影、裁决。

两条公理：

- **归属公理**：对象的物理位置回答"它属于谁"（哪个领域/哪道工序），不回答"它是
  什么种类"。种类由对象自身的文件格式表达——SKILL.md 就是技能，tool.yml 就是过程
  工具——不靠目录名区分。
- **映射禁令**：目录即能力路径，不允许第二份映射表（CLAUDE.md 铁律在拓展面的延伸）。
  清单里不许写"我挂在哪个路径下"；路径永远由所在目录派生。

## 2. 拓展根与目录组织

拓展根可多个，按优先级叠加（见 §5）。单个拓展根的结构：

```
extensions/
├── _root.yml                    # 根级元数据：规范版本、归属判定规则
│
├── industry/                    # 领域区：按行业
│   └── mes/
│       ├── _directory.yml       #   域元数据（语义标签、说明、统计口径）
│       ├── _02mixing/           #   工序段：_NN 序号承载工序顺序
│       │   ├── _directory.yml
│       │   ├── _01base/
│       │   │   ├── material-info.tool.yml   # 过程工具：清单
│       │   │   ├── material-info.py         #   执行体（自管 DB 连接）
│       │   │   └── material-tester.SKILL.md # 领域技能：与工具同处工序上下文
│       │   └── _02plan/
│       │       └── aps-publish.tool.yml     # 写工具：影响陈述模板在清单里
│       └── _03curing/
│           ├── knowledge/                   # 领域知识库（唯一保留的种类子目录名）
│           │   └── 硫化工艺窗口.md
│           └── curing-press-status.tool.yml
│
├── web/                         # 领域区：按对象组织（无工序概念）
│   └── browser/
│       ├── _directory.yml
│       ├── page/                #   对象：Page
│       │   ├── navigate.tool.yml
│       │   └── read-page.tool.yml
│       └── form/                #   对象：Form
│           └── fill-form.tool.yml
│
├── skill/                       # 种类区（仅通用）：不属于任何单一领域的技能
│   └── charting.SKILL.md
├── code/                        # 种类区（仅通用）：通用过程工具，按运行时分层
│   ├── python/execute-python.tool.yml
│   ├── sql/run-query.tool.yml
│   └── bash/run-shell.tool.yml
├── mcp/                         # 种类区（仅接入层）：MCP 服务器声明
│   └── filesystem.mcp.yml
└── dsh/                         # 种类区（仅兼容层）：dsh 社区包原样落位
    └── some-dsh-skill/SKILL.md  #   内部结构不动，按 SKILL.md 规范扫描
```

领域决定自己的第三层语义：工业域是 `域 → 工序段(_NN) → 对象组 → 对象`，web 域是
`域 → 对象 → 动作`；规范只约束到二级。

**种类区只收留跨界者。** `skill/`、`code/`、`mcp/`、`dsh/` 只放不属于任何单一领域的
通用对象；领域内的同类对象永远留在领域内。"不混合"不是种类与领域平级分区，而是：
默认按领域归位，种类区是兜底。

### 2.1 归属判定（不混合规则的可执行版）

按序判定，取第一条命中：

1. 对象的内容围绕具体领域对象（工单、硫化机、Page）→ 进领域区，哪怕它是技能或知识；
2. 对象是外部协议的接入声明（MCP server、dsh bundle）→ 进种类区对应接入层；
3. 以上都不沾 → 进种类区 `skill/` 或 `code/`。

规则写进 `_root.yml`，是目录元数据的一部分，不是散落的惯例。归属判错的代价是
移动一次文件，不是功能损坏——能力路径随移动变化，旧路径的历史定义仍可寻址（§6）。

### 2.2 目录元数据 `_directory.yml`

```yaml
label: 密炼工序
summary: 混炼胶从投料到出片的全过程对象与动作   # 进目录卡片，≤200 字
order: 20                  # 同级排序（冗余于 _NN 前缀，供无序号目录用）
tags: [mixing, banbury]    # 搜索语料
visibility: all            # all | hidden；禁用=hidden，fail-close
stats:                     # 只声明口径，值由内核实时算，永不手写
  expose: [tool_count, success_rate_7d, p50_ms_7d]
```

统计值手写进文件 = 多事实源（WonWork 的教训）；文件只声明"暴露哪些口径"，内核把
实时值投影成目录卡片，数字本身就是模型的导航信号。

## 3. 对象种类与清单

格式识别，不靠位置。一个目录里可混放五种子内容，全部可选、无强制子目录骨架
（空骨架目录是噪声）：

| 内容 | 形态 | 识别方式 |
|---|---|---|
| 过程工具 | `*.tool.yml` + 同目录执行体 | 清单格式 |
| 技能 | `*.SKILL.md` 或 `<name>/SKILL.md` 束 | 社区规范（§5.1） |
| 知识库 | `knowledge/` 子目录（纯文档语料） | 目录名（语料无清单可识别） |
| 目录元数据 | `_directory.yml` | 下划线前缀 |
| 接入声明 | `*.mcp.yml` | 清单格式 |

知识库文档投影为只读能力条目：invoke 即读取内容，与文件对模型同构。
投影规则（确定性的，不给作者自由命名——映射禁令）：任何名为 `knowledge`
的目录下的 `*.md` 文件即知识文档；能力名由文件名派生——ascii 段转
snake_case，纯非 ascii 名退化为 `doc_<内容hash前8位>`，同目录撞名追加
hash 后缀；标题取首个 `#` 标题行（无则首个非空行），进发现语料；
定义版本 = 内容 hash，内容变更即新版本，历史定义仍可寻址。

### 3.2 共享常驻进程

同一插件目录里的多个 `kind: process` 清单**共享一个常驻进程**（目录即对象：
进程是目录的，不是清单的）。前提：同目录所有 process 清单的 `runtime.entry`
逐字一致，否则整目录 fail-closed 拒绝。内核在 invoke 帧里始终携带 `tool`
字段（工具名），单清单插件忽略它，多清单插件按它分发。浏览器这类 20 个
动作共享一个 daemon 连接的域，靠这条约定落成一个进程。

### 3.1 过程工具清单 `*.tool.yml`

```yaml
name: sql_daily_output           # snake_case，全局唯一
kind: process                    # process | template
description: 查询某日产量汇总     # 发现用一句话，≤500 字符进目录卡片
input_schema:                    # JSON Schema 受控子集
  type: object
  properties: { date: { type: string } }
  required: [date]
risk: { level: read_only, side_effect: none }   # 四级风险 + 副作用，同 docs/03
approval:
  mode: auto                     # auto | explicit；写操作必须 explicit
  impact_statement: null         # explicit 必填，支持 {date} 参数占位，运行时填充
runtime:
  entry: python material.py      # process：长驻进程；template：一次性命令模板
  env: [MES_DB_URL]              # 只声明需要的变量名，值由环境提供
limits: { timeout_ms: 30000, max_result_chars: 100000 }
search_hint: 产量 日报 汇总       # 发现打分语料
```

`runtime.entry` 是 argv 数组。内核供给占位符：`{pluginDir}`（插件目录绝对路径，
两种形态可用）、`{javaBin}`（当前 JVM 的 java 可执行文件，仅 process 形态的
spawn argv 可用——产品不引入新运行时）；`{paramName}` 仅 template 形态可用，
值取输入参数。process 形态的输入永远走 invoke 帧（§4）。

风险声明与审批裁决仍是内核权力：清单声明只是输入，Runtime 的策略双闸（目录隐藏 +
执行拒绝）不依赖插件自觉。审批通过前进程不启动。

## 4. 过程工具执行协议

内核与过程插件之间是 stdin/stdout NDJSON，一帧一行：

- 内核 → 插件：`{"type":"invoke","callId","tool","input","context":{"workspace","env"}}`
  （`tool` 是清单名；单清单插件可忽略，多清单共享进程按它分发，§3.2）
- 插件 → 内核：`{"type":"progress","callId","text"}` 任意多次；恰好一次
  `{"type":"result","callId","success","data","structuredData"|"error"}`
- 取消三层：内核先发 `{"type":"cancel","callId"}`，200ms 后 SIGTERM，再 SIGKILL——
  插件有体面退出的机会，内核不等 forever。
- 进度帧的归宿：Tool 契约没有进度通道，内核把 `progress.text` 依序收进结果的
  `progress` 数组（截断纪律同结果字符预算），不伪造中间状态。
- 超时：清单 `timeout_ms`，内核计时，超时走取消三层。
- `kind: template` 无长驻进程：清单给命令模板与参数插值，内核代为 spawn 一次性
  进程，stdout 即结果。包装一个 CLI 的最低成本形态。
- 进程惰性拉起：首次调用时启动；崩溃自动重启一次再报错；禁用/卸载随最后一个
  引用退出而回收。高频域未来可在清单声明 keep-alive 优化，协议不变。

## 5. 社区规范兼容层

### 5.1 SKILL.md（原生兼容）

兼容 deepseek-harness / `.agents` 惯例的子集：

- 形态：`<root>/<name>/SKILL.md` 束，或扁平 `<name>.SKILL.md`；文件名精确
  `SKILL.md`（大小写敏感）。`knowledge/` 段下的 `.md` 永远按 §3 知识投影
  识别，不作技能——语料目录优先，确定无疑义。
- frontmatter：文件开头 `---` 行开合的 YAML 头。字段白名单：
  `name`（kebab-case，必填）、`description`（必填）、`whenToUse`、
  `metadata`、`disable-model-invocation`、`user-invocable`；白名单外字段、
  缺必填、name 非 kebab-case 均 fail-closed——整个技能丢弃并告警，
  绝不带病注册。正文 = frontmatter 之后的部分。
- 投影（与知识文档同构）：技能 = 只读能力（read_only/none/auto）。能力名 =
  frontmatter `name` 确定性转换（`-` → `_` 得 snake_case，转换后仍非法
  则整件拒绝）；能力路径 = 束/扁平同形——**父目录 + 转换后能力名**
  （叶段必须 snake_case，注册表约束；束目录名本身可 kebab）。
  定义版本 = SKILL.md 内容 hash。
- 加载原语：invoke 无参返回正文 + 束内资源相对路径清单（≤200 条）；
  `resource` 参数按相对路径读束内文件——围栏到束目录（resolve 后越界
  拒绝），按文本读取、同知识文档的字符预算；扁平形态无束，`resource`
  如实报 `skill_resource_unavailable`。
- 目录注入只含 `name` + 截断至 500 字符的 `description`，正文经上述
  加载原语按需读取（发现优于塞满）。`whenToUse` 仅随正文与结果元数据
  呈现，不进目录卡片。
- `disable-model-invocation: true` 遵循作者声明：不注册为模型能力
  （记扫描日志，非 problem）；`user-invocable` 仅记录——用户直连通道
  随管理页落地，当前不改变行为。

### 5.2 扫描根与优先级

| rank | 根 | 性质 |
|---|---|---|
| 50 | `<backend>/../extensions/`（`iris.extension.bundled-root` 可改写） | 内建拓展根：随发行物出厂，仍是普通目录对象 |
| 100 | `<workspace>/.iris/extensions/` | 项目级自有 |
| 200 | `<workspace>/.agents/skills`、`<workspace>/.dsh/skills` | 社区惯例，原样识别 |
| 300 | `~/.iris/extensions/` | 机器级自有 |
| 400 | `~/.dsh/skills`、`~/.agents/skills` | 社区全局 |

默认扫描序列即上表 rank 升序（不存在的根跳过）；`iris.extension.roots`
显式配置时以配置为准。社区根里同样只做格式识别（§3 五种内容都可能
出现），不复制文件。

同名冲突：rank 小者整件胜出；被遮蔽项在目录标注 `shadowed-by` 且仍可寻址，
绝不静默双活。社区根只做**投影**不复制文件。逐件裁决与标注随统一能力管理页
落地（[docs/32](32-capability-management-page.md) §3）：冲突件不注册、记
胜出者来源、管理页可见而模型目录不出现；内建根与代码内工具同名时同样
遮蔽（内核恒胜），保证出厂目录永远可被内核行为覆盖裁决。

### 5.3 MCP

- 传输在现有 streamable_http 之外补 **stdio**（本地进程即插件；与 Claude Code
  同形：spawn command/args，换行分隔 JSON-RPC，stderr 只进日志不进协议）；
- 远端工具以 `mcp__<server>__<tool>` 命名入注册表（与 Claude Code / dsh 同形）；
- 声明形态：`mcp/<server>.mcp.yml`：

```yaml
slug: filesystem             # snake_case，全局唯一
display_name: 文件系统        # 管理页展示名
transport: stdio             # stdio | streamable_http
command: [npx, -y, "@modelcontextprotocol/server-filesystem", "."]
env: [SOME_TOKEN]            # 只声明变量名，值由环境提供（不写进文件/库）
enabled: true
# streamable_http 时改用：
# endpoint: https://example.com/mcp
# authorization_env: MCP_TOKEN
```

声明经拓展扫描进入 MCP 连接器注册表（来源记录到 `mcp_server_origin`）；
删除声明 = 停用该连接器，历史定义仍可寻址。与管理页手工建的连接器 slug
冲突时 fail-closed：保留既有连接器，拒绝声明并告警。

### 5.4 明确不兼容的部分

dsh 的 Cordis `inject`/`apply(ctx)` 代码契约是 JS 生态绑定，不直容；`dsh/` 落位区
只消费其 SKILL.md 与资源文件。兼容性声明以本文为准，不追 dsh 的 breaking changes。

## 6. 生命周期

- **安装** = 把目录放进拓展根；文件监听触发增量扫描；
- **校验 fail-closed**：清单非法 → 该插件目录整体拒绝并告警，其余不受影响；
  合法 → 清单内容 hash 即版本（无独立版本字段，目录即真相），定义快照落
  `capability_definition`，历史 ToolCall 按 `path + manifestHash` 永远可寻址；
- **禁用** = `_directory.yml` 翻 `visibility: hidden`（或管理操作改写它）→
  目录从发现平面消失 + 执行拒绝双闸兜底；**隐藏而非卸载**，定义版本仍可寻址；
- **热装生效边界**：新 Run 立即看到；进行中 Run 的能力快照不变（manifest hash
  钉住天然成立）；
- **卸载** = 删目录；历史定义与审计记录永不删除（不变量 1）；进程句柄随引用
  退出回收。

## 7. 前缀缓存纪律

- Resident surface（常驻原语面）**永远由内核签发**，插件不可进——稳定前缀的
  物理保证；
- 插件能力只出现在两处：发现原语的返回（历史中的 tool_result，天然 append-only）、
  目录卡片注入块（变化时整块追加新版本，不改写旧块）；
- `model_attempt_cache_diagnostic` 视图继续逐 attempt 校验：任何插件装卸都不应
  引起 prefix 漂移。

## 8. 发现平面

模型面对一棵能力树 + 一套文件心智：

| 动作 | 原语 | 文件同构 |
|---|---|---|
| 浏览 | list_capabilities | ls |
| 搜索 | search_files（capabilities 命名空间） | grep |
| 读取 | read_capability | read |
| 调用 | invoke_capability（path + manifestHash 钉住） | 执行 |

目录卡片携带统计信号（tool_count、success_rate_7d、p50_ms_7d，按 `_directory.yml`
声明的口径实时计算）。万能锤（如裸 SQL 查询）不驻留、与业务工具同成本对称。

## 9. 安全边界

- 双闸：目录隐藏只是体验，执行拒绝才是边界；未知来源/禁用态一律 fail-close；
- 路径围栏不变：文件类插件同样只能在工作区根内操作；
- 审批不出内核：挂起、决策（带人话影响陈述）、恢复全在 Runtime；无人应答
  fail-closed；
- 过程插件跑在用户进程权限下，内核管审批、审计、超时、取消与结果截断。

## 10. 内核/拓展分界

判据：缺了它就无法对任何拓展做裁决的，留内核；可替换实现或只服务某类能力的，外移。

**留内核**：事件 store 与 SSE；Tool Runtime 六闸（schema 校验、路径围栏、审批裁决
含影响陈述渲染、审计、超时/取消、结果截断）；生命周期裁决；发现原语四件；目录
投影器；`/system/files` 与 `/system/agents`、`/system/tasks` 编排原语（Runtime 的
左右手，永留）。

**写工具的特例**：值就在内核写服务（Workspace Checkpoint、编码保持、乐观锁版本）
里的工具不外移——外移后这些保障无法由进程协议承载，会变成更差的
`write_file`（例：`/life/notes/append_note` 永留内核）。判据不变：缺了它就无法
对拓展做裁决的留内核；append_note 的裁决能力（checkpoint）恰恰在内核里。

**皆目录对象**：业务域工具（industry、web、data、code、personal、life）、skills、
memory、knowledge、MCP 适配、Pipeline 定义。

## 11. 迁移路径

- **M0（已落地）**：`ToolRegistry.replaceExternal(providerKey)` 复用为统一"拓展来源"
  入口（外部路径正则放宽允许工序序号段 `_02mixing`）；拓展根扫描器 + fail-closed
  清单校验（`com.iris.extension`）；**仅 template 形态**：清单给 argv 模板、内核
  一次性 spawn，stdout 即结果；`_directory.yml` 元数据叠加进
  CapabilityDirectoryCatalog（代码优先，hidden 即消失）；WatchService 热加载
  （防抖整根重扫，新 Run 立即可见，在途 Run 快照不变）；热加载进来的定义随下次
  启动固化进 `capability_definition`（与 MCP 一致）。
- **M1（已落地）**：kind=process NDJSON 常驻协议落地（§4：惰性拉起、崩溃重启
  一次、取消三层、随引用计数回收）；内建拓展根（rank 50）；钉子户 =
  `/system/math`、`/system/time` 两个零依赖域外移为内建插件（单文件 Java 源码
  启动，`java` 是产品已有运行时，不引入新依赖）；`/life/notes` 不外移——其值在
  内核 Checkpoint/编码/乐观锁（§10 写工具特例）；MCP stdio 传输（
  McpStdioClient：spawn command/args/env、换行 JSON-RPC、stderr 只进日志、
  进程随连接器停用回收）+ `*.mcp.yml` 声明扫描落库（来源记
  `mcp_server_origin`，slug 冲突 fail-closed 保手工连接器，删声明=停用）+
  `mcp__<server>__<tool>` 命名入注册表；
- **M2（已落地）**：知识库投影（`knowledge` 段下的 `.md` → 只读能力条目，§3 投影
  规则：ascii snake slug / 纯非 ascii 退化为 `doc_<hash8>`、同目录撞名加确定性
  `_<hash8>` 后缀、标题取首个 `#` 标题行否则首个非空行、版本=内容 hash16）；
  目录统计进卡片（`_directory.yml` 的 `stats.expose` 声明口径，内核实时算
  tool_count / success_rate_7d / p50_ms_7d 随 `list_capabilities`
  卡片返回，零样本口径缺省不返回，值永不手写）；`/industry/**` 目录元数据从代码
  搬进内建拓展根的 `_directory.yml`（内核 `/system/**` 目录元数据随内核定义留
  代码）；共享常驻进程（§3.2，invoke 帧增 `tool` 字段，同目录 entry/env 不一致
  = 整目录 fail-closed 拒绝）；`/code/python` 外移为内建 process 插件——按最终
  形态重写而非迁移：宿主是 `{javaBin}` 单文件源码（随内核发行），负责定位本机
  Python（`IRIS_PYTHON` 优先，其次 PATH 的 python/python3，找不到 =
  `python_runtime_unavailable` 明确报错）、staged I/O、输出集合精确核验、工作区
  围栏与 cancel 帧杀子进程；输入只引用工作区文件，**不进入内核
  Checkpoint/Artifact 体系**（跨进程插件的自证就是 result 帧，docs/04 §2）；
  内核 `sandbox` 包与 `iris.sandbox.python.*` 配置随之删除；
- **M3a（已落地）**：`/web/browser` 外移为内建共享进程插件
  `extensions/web/browser/`——19 个 process 清单共享一个 `Browser.java`
  常驻进程（§3.2，entry 逐字一致 `{javaBin} {pluginDir}/Browser.java`），
  JDK HttpClient 直连 webbridge daemon，无新增运行时。**daemon 协议所有权
  整体搬进插件**：endpoint/协议版本/健康检查（3s 缓存）、Bearer token
  （runtimes.json 只写环境变量名，默认 `IRIS_BRIDGE_TOKEN`，与 daemon
  同源共读）、幂等三键（invoke `callId` = 内核 executionId 即
  idempotencyKey，`actionAttemptId = callId:<primitive>`）、动作三态
  （applied / not_applied / outcome_unknown）如实投影为 result 帧，
  `resolveElement` 前置校验（fill 的字段类型白名单、select 的 option
  核对、press 的受限键表、upload 的 file input 核对）随执行进行——
  插件无 prepare/execute 分界，审批影响陈述只用输入参数占位。
  `runtimes.json` 是插件自有配置（连接配置所有权归插件目录），内核
  `iris.webbridge.*` 配置随之删除。截图字节由插件写入工作区围栏内声明
  路径（`workspace_path`，扩展名须与 format 一致），自证 = 内容 hash 随
  structuredData 返回，内核 BrowserScreenshot* 投影链（Controller /
  Service / ProjectionEnricher）随之删除。**人工接管不是浏览器原语**：
  旧 `request_browser_takeover` 不外移——其值在内核持久 UserInput
  （暂停可跨重启），插件协议承载不了；最终形态是组合：
  `/system/interaction/ask_user` 暂停任务 → 用户交还后
  `observe_browser_page` 重读页面再继续，不为浏览器域保留特例工具。
  取消语义：cancel 帧中止在途 HTTP（sendAsync future cancel），进程
  EOF 时取消并等待在途调用写出结果帧再退出。内核侧删除
  `tools/web/browser/`（20 个工具类）与 `webbridge` 包；
  前端 `browser_screenshot` 预览卡分支随之删除（插件结果走通用
  structured 投影，专门卡片随前端管理页统一重做）；
- **M3b（已落地）**：`/data/sql` 外移为内建共享进程插件
  `extensions/data/sql/`——3 个 process 清单共享一个 `Sql.java` 常驻进程
  （§3.2）。**连接配置所有权搬进插件目录**：插件自有 `connections.json`
  （与 `runtimes.json` 同一归属公理），URL 可写，凭据只写环境变量名
  （`username_env`/`password_env`），插件从自己的进程环境读取，内核永不
  持有 JDBC URL 与口令；`iris.sql.connections` 配置随之删除。**JDBC
  驱动随插件自带**：`lib/` 目录 vendor sqlite-jdbc（个人版默认连接
  SQLite），entry 用 `-cp {pluginDir}/lib/*` 装载；其它方言在
  connections.json 里以 `driver` 指向本机 jar，找不到 =
  `sql_driver_unavailable` 明确报错，不静默退化。只读分析器（词法级，
  注释/字符串/CTE/括号深度）原样搬进插件，内核不再内置 SQL 方言知识；
  只读兑现 = 连接声明 read_only + JDBC `setReadOnly(true)` + 分析器证明
  三重门，真正的兜底仍是数据库账号本身。availability probe 不外移：
  没有可用连接时 `list_sql_connections` 返回空清单与指引，inspect/query
  在调用时如实报 `sql_connection_not_found`；内核 `com.iris.sql` 包
  与 `tools/data/sql/` 随之删除；
- **M3c（已落地）**：`/industry/mes` 演示域按最终形态重写为内建共享进程
  插件 `extensions/industry/mes/`——工序叶子目录（深度恰好 2）内的
  工具清单按 §3.2 共享该目录的常驻进程，entry 逐字一致
  `["{javaBin}", "-cp", "{pluginDir}/../../lib/*", "{pluginDir}/../../Mes.java"]`
  （宿主与驱动在域根一份，叶子目录只放清单；进程惰性拉起、随引用计数
  回收，未触及的工序零成本）。**演示库所有权搬进插件**：DDL 与
  脱敏种子随插件自带（`seed.sql`），首次调用在
  `{workspace}/industry/mes-demo.db` 自播种（BEGIN IMMEDIATE +
  seed_marker 双重检查，多进程并发首播安全；文件存在即跳过，用户可删
  可改可重播），内核 schema.sql 的 `industrial_demo_*` 表与种子随之
  删除——演示数据不再是内核 schema 的一部分。数据访问形态不变：领域
  工具只选择固定数据视图并归一化参数，表、SQL、行预算集中在插件
  仓储层；写工具（计划维护、质量处置、APS 发布）保持
  elevated/external_write/explicit 与乐观守护语义，目标改为插件自有
  演示库。`/industry/mens` 目录骨架维持纯 `_directory.yml` 元数据不变。
  内核 `tools/industry/`（39 个工具类与抽象骨架）、
  `industry/demo/IndustrialDemoRepository` 随之删除；
- **M4（已落地）**：SKILL.md 原生兼容与社区扫描根（§5.1 + §5.2 rank
  200/400）。技能投影为只读能力（与知识文档同构：invoke 读正文，
  `resource` 参数围栏读取束内资源）；frontmatter 白名单校验 fail-closed；
  默认扫描序列补全五个 rank，冲突处置维持整根 fail-closed（逐件
  `shadowed-by` 标注仍随管理页落地）；
- **M5（已落地）**：统一能力管理页——逐件 `shadowed-by` 裁决（§5.2）+
  只读管理查询 API（`/api/v1/capability-admin`）+ CapabilityCenter
  重构为目录树统一页。设计与边界见
  [docs/32](32-capability-management-page.md)；
- 每步外移前该工具定义快照已固化在 `capability_definition`（现有机制），历史会话
  寻址零影响。
