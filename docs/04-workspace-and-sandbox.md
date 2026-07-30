# 04 · 工作区与 Python 沙箱

## 1. 工作区（Workspace）

助手的手和脚落在文件系统上。工作区是用户明确选择的一个真实目录，也是所有文件 Tool 唯一允许接触的根。需要外部文件时先由用户导入或显式更换工作区，不给单次调用临时越界特权。

### 路径围栏（Path Jail）——第一安全原则

- 文件工具只接受**工作区内相对路径**（`notes/旅行清单.md`）；
- 绝对路径、UNC、device path、空字节、非法段和 `..` 逃逸 → 一律拒绝；
- 在唯一 root 下 resolve + normalize，用路径段语义校验 containment，不用字符串 `startsWith`；
- 逐层检查已存在祖先的 symlink / Windows reparse point；无法解析或检查异常一律拒绝；
- 写入前重新校验父目录和目标版本，executor 只接收 WorkspaceGuard 签发的受保护目标；
- 错误信息要教学化："路径越界：只能操作工作区内文件，收到的是绝对路径 E:\…，请改用相对路径"。

### Windows 一等公民的逻辑路径

Iris 不把模型暴露给某一台机器的物理路径。Workspace 层在 Windows 文件系统之上提供唯一的逻辑命名空间：

- Tool 输入接受 `notes/todo.md` 或 `notes\todo.md`，归一化输出恒为 `notes/todo.md`；不更改真实文件名大小写。
- 拒绝盘符路径、UNC、device path、ADS 冒号、NUL 与 `..` 逃逸；安全性按 Path segment 和已存在祖先的真实路径判断，不按字符串前缀猜测。
- 遍历不跟随 symlink/junction 目录；读取最终文件前再次解析真实目标并确认仍在 root 内。无法识别的 reparse point 按 fail-close 处理。
- 换行和编码是内容属性，不是路径属性：首版读取 UTF-8、带 BOM 的 UTF-8/UTF-16LE/UTF-16BE；不确定或疑似二进制时明确拒绝，不用平台默认编码猜测。
- 物理 root 只存在于进程配置和审计数据中，不进入普通 Tool 输出。这样未来从直接文件访问切到 staged I/O 或 OS Sandbox 时，模型契约无需变化。

`WorkspacePathGuard` 是逻辑路径到受保护物理目标的唯一翻译器；`WorkspaceFileService` 是有界读取、遍历与搜索的唯一入口。文件 Tool、HTTP 端点、Checkpoint 与未来 Sandbox Helper 都只能建立在这两层之上。

### 三种路径，三个责任

Iris 内部同时存在三类“路径”，必须在类型和接口上分开：

| 路径 | 示例 | 谁能直接使用 | 语义 |
|---|---|---|---|
| Workspace logical path | `workspace://notes/todo.md` | 用户、模型、文件 Tool | 用户文件的位置，可变且写入需审批 |
| Capability path | `/system/files/read_file` | Catalog、模型发现 | 能力的语义组织位置，不是磁盘路径 |
| Managed object ref | `object://sha256/<hash>` | 后端存储服务 | Iris 私有不可变内容，只能经拥有该引用的领域服务读取 |

`objectRef` 永远不接受任意文件名或相对路径，只接受固定算法和 digest；物理布局由
Managed Object Store 独占。普通 Workspace Tool 不得读取或枚举对象仓。Checkpoint
和 Tool output 对外分别保持 `checkpoint://<id>`、`tool-result://<executionId>`
身份，只有 SQLite 内部记录指向共享 object 的引用。

当前开发配置与产品落点：

| 内容 | 配置 | 开发默认 | Windows 产品目标 |
|---|---|---|---|
| SQLite | `IRIS_DB_PATH` | 当前用户目录下的 `.iris.db` | `%LOCALAPPDATA%\Iris\data\iris.db` |
| Managed Object Store | `IRIS_OBJECT_STORE_PATH` | `~/Iris/data/objects` | `%LOCALAPPDATA%\Iris\data\objects` |
| User Workspace | `IRIS_WORKSPACE` / 用户选择 | `~/Iris/workspace` | 用户选择；默认建议“文档\Iris” |

数据库与对象仓属于可备份的 Iris 私有数据根，Workspace 属于用户文件根；即使用户误配，
二者存在包含关系时也拒绝启动。最终 exe 由启动器解析 Windows known folder 并显式注入
绝对路径，Java 内核不自行猜测本地化的“文档”目录名。

### 文件工具集

`read_file / write_file / append_file / list_files / glob / grep / delete_file / mkdir / move_file`

- `read_file`：大文件截断 + 提示（"已截断，共 N 行"），支持行范围；返回稳定行号和下一段起点；
- `write_file`：模型只提交 path/content；prepare 自动冻结目标版本并生成人话差异，批准后复核版本、建 Checkpoint，再同目录原子替换；不要求模型回传整份旧内容；
- `append_file`：向文本文件末尾追加内容或创建新文件；保持已有编码和换行风格，不暗中补换行，仍以原子替换、版本复核和 Checkpoint 完成提交；
- `make_directory`：一次只创建已有父目录下的一层；文件写入不再暗中递归建目录，真实变化与审批资源保持一致；
- `remove_directory`：只删除空目录，不提供隐式递归删除；删除前记录目录状态，可由 Checkpoint 恢复；
- `apply_patch`：对一个文件做唯一精确文本替换，可显式 `replace_all`；自动适配目标文件现有 CRLF/LF 风格，失败时返回当前事实与下一步，不猜模糊位置；
- `move_file`：只移动普通文件且不隐式覆盖目标；源与目标作为同一个资源集冻结、审批和恢复；
- `copy_file`：流式复制普通文件并保留原件；复制期间持续核对取消和源内容版本，目标不存在且父目录已存在时才原子提交；
- `delete_file`：destructive，强审批；
- `list_files`：稳定排序，有最大深度、扫描量和返回量；默认跳过生成目录，但显式进入或请求包含时可见；
- `search_files`：统一承接首版 grep/glob 的发现用途；默认安全的字面量搜索，可显式启用受限正则，走内存友好的流式扫描；
- `grep/glob` 名称暂不单独注册，避免在语义尚未分化时制造重叠能力；真实使用数据证明需要后再拆分专用原语。

只读首切片的共同结果预算：

- `list_files` 最多返回有限条目；截断时要求模型缩小 `path/pattern/depth`。
- `search_files` 同时限制候选文件数、单文件大小、单行长度和命中数；跳过项与原因进入摘要。
- `read_file` 按行流式扫描，只保留请求窗口；返回内容达到预算即停止投影，但保留是否还有后文的事实。
- 取消信号在目录迭代和逐行读取中检查，不能等整个目录或文件扫描完才响应。

所有文件写，包括创建目录、移动、覆盖、删除和恢复，都经过 Tool Runtime；不存在前端可直调的 `/workspace/write` 旁路。

### 检查点（Checkpoints）——后悔药

- 每次写操作前创建一个 Checkpoint set；其中按稳定顺序记录全部资源的 logical path、kind、change kind、before hash/size/mtime、内容快照引用和 `toolExecutionId`；
- 成功后记录 after hash 与 evidence；
- Checkpoint 内容先按 SHA-256 原子写入 Managed Object Store，SQLite 只保存
  `beforeObjectRef + beforeHash/size/mtime`；不把内部快照文件混进用户工作区，
  恢复能力只能通过 Tool Runtime 和 `checkpointId` 读取它；
- 对话分支只改变历史视野，不静默回滚文件；
- 恢复 Checkpoint 是新的可预览写动作：只在目标仍等于该 Checkpoint 的 `afterHash` 时允许 prepare，默认审批，并在恢复前为当前状态再建一个恢复 Checkpoint；
- 原目标不存在的 Checkpoint 恢复为“删除后来创建的文件”，仍因恢复前快照而可逆；普通 `delete_file` 同样先保存完整内容，再执行删除；
- `captured` 但未确认 `applied` 的 Checkpoint 不可直接恢复，因为此时外部写入结果未知，必须先 reconciliation；
- `inspect_workspace_change(execution_id)` 只读比较整组资源的 before、记录的 after 与当前版本，区分“已确认应用 / 未观察到写入 / 部分或未知”，但不擅自把未知改写成成功；
- Object 先落盘、SQL 引用后提交；SQL 失败产生的孤儿对象可由以后 reachability GC
  回收，反向顺序则被禁止；
- 大文件保留期限和 reachability GC 在真实数据出现后实现；当前没有成功清理前，
  不能只留 hash 却仍承诺可回滚。

## 2. Python Runner 与 Sandbox 边界

数据处理、文档生成（Word/Excel/PPT/PDF）、图表渲染交给 Python——这是助手从"会聊"到"会干活"的关键一跃。

### 首版架构

```
Agentic / Pipeline 提交 execute_python_analysis Invocation
  → Tool Runtime 校验脚本来源、输入、预算与风险
  → 把声明输入复制或只读映射到 staged input
  → Trusted Runner 或未来 Sandbox Helper 在独立 run directory 执行
  → 只写 separate output
  → 捕获 stdout/stderr/生成文件清单并截断
  → Runtime 验证 output
  → 在同一次已批准 Operation 内建立整组 Checkpoint
  → 原子导入 Workspace 并登记 internal Artifact
```

首个可执行契约名为 `execute_python_analysis`，明确限定为数据分析、确定性计算、图表和
文档产物生成，不提供 Shell。调用必须预先声明：

```text
inputs[]  = exactly one of workspace_path / artifact_ref / tool_execution_id
            + mount_name
outputs[] = output_name + workspace_path + kind + title
```

三种输入都先解析为不可变的 `content hash + byte count`，并受同一个 staged input 总预算
约束：

- `workspace_path` 表示用户当前可编辑文件，prepare 与 execute 之间重新核对内容版本；
- `artifact_ref` 表示同一对话中已经冻结的精确成果版本；
- `tool_execution_id` 表示同一对话中某次成功 ToolExecution 的完整规范 JSON payload。

模型可以先用 `query_tool_result/read_tool_result` 只观察大结果的一小部分，再把
`tool_execution_id` 直接交给 Python。完整数据由 Backend 在数据平面复制，不经过模型
上下文，也不需要模型把几万条记录重新写进 Workspace。只有用户需要继续编辑或交付的内容
才进入 Workspace；内部工具结果不因“可能以后会用”而污染用户目录。

Backend 按输入版本复制到 staged input；Python 只通过 `IRIS_INPUT_DIR` 读取。脚本只能把
交付件写到 `IRIS_OUTPUT_DIR`，且执行结果必须与声明的 output_name 集合精确一致。验证后，
Backend 再逐个核对目标 Workspace version、建立 Checkpoint、原子写入并登记 internal
Artifact。模型批准的是这次声明完整的输入、代码与目标资源，不会在 Python 完成后再弹
第二次同义审批。脚本不能直接宣布成功、不能直接发布用户成果；Iris 不向进程传递工作区
物理根或挂载整个工作区，但 `trusted_process` 仍不能阻止恶意代码自行探测宿主文件系统。

Runtime mode 是 Application availability，而不是 Tool 参数：

- `disabled`：Definition 可发现但 unavailable；
- `trusted_process`：仅本机显式启用，标记 degraded；具备 staged I/O、输出预算、取消和
  进程树终止，但不宣称能阻止恶意 Python 访问宿主资源；
- `container`：未来默认产品模式；断网、只读根文件系统、只读 input、独立可写 output，
  并限制 CPU、内存和 PID。

模型不能选择较弱 mode，也不能在 container 不可用时静默降级到宿主 Python。

进程层先提供内部 `WorkspaceProcessRunner`，但它本身不是模型 Tool：命令以 argv
而不是拼接后的 shell 字符串提交，cwd 必须经 Workspace 围栏解析，环境继承必须显式，
stdout/stderr 始终并发排空且只做有界留存，取消与超时会终止当前进程及可见子进程。
这只是可信本地执行的生命周期内核，不等于安全沙箱；在 Windows Job Object、staged
I/O 与写入核验接通前，不把任意命令能力暴露给模型。

### 约束（默认值，可配置）

| 项 | 默认 | 说明 |
|---|---|---|
| 超时 | 120s | 到时强杀进程组 |
| 输出截断 | 64KB | stdout/stderr 各自截断 |
| 网络 | Trusted Runner 不承诺隔离 | 环境变量和约定不是安全边界；真正 Sandbox 必须由 OS 级策略验证 |
| 文件访问 | staged input + separate output | 不把整个 Workspace 读写挂载给执行进程 |
| 预装库 | python-docx / openpyxl / python-pptx / pypdf / matplotlib / pandas | 文档四件套 + 数据处理 |

### 与工具的衔接

- `execute_python_analysis` 是 `/code/python` 下的 Tool；产品默认不开放宿主任意代码，
  `trusted_process` 只用于用户本机显式选择的开发模式；
- output 通过验证和导入后登记为 internal Artifact；模型确认适合交付并调用
  `publish_artifact(user_timeline)` 后才转为用户产物卡片；
- 当前 stdout/stderr 在执行结束后作为有界 Observation 返回。过程级 stdout SSE 是后续
  增量，接入时复用 `WorkspaceProcessRunner.OutputListener`，不能另开轮询通道。

## 3. 产物（Artifacts）

工具/沙箱产出的文件与用户上传的输入都是一等公民：

- 统一产物模型：`{ id, path, version, name, kind, size, provenance, visibility, sourceToolExecutionId }`；
- 对话里渲染为文件卡片（类型图标 + 名称 + 大小 + 预览）；
- 产物索引按会话持久化（SQLite），切换会话水合还原；
- 预览坞（右侧面板）集中展示当前会话全部产物。

### 3.1 登记不等于发布

Artifact 是数据平面的稳定交接对象，不等于“前端已经给用户展示了一张卡片”。生命周期
至少分为：

```text
User upload / Workspace / Sandbox output
  → register：冻结精确内容版本，登记 provenance，visibility=internal
  → reference：任务账本、模型上下文或 child Run 只携带 artifact:// 引用
  → publish：显式增加 model_context 或 user_timeline 可见性
  → preview/download：前端按需读取，不把 payload 塞进 ConversationView
```

  `register` 不接受任意物理路径，只能读取围栏内工作区文件或 Runtime 已验证的 staged
  output；登记时把精确字节复制到 Managed Object Store，后续工作区文件变化不会改写旧
  Artifact。`publish` 只改变 Iris 内部可见性和投影，不修改工作区文件，也不向外部系统
  发送内容。发布到 `user_timeline` 后才生成 ArtifactNode；内部 Artifact 和
  `model_context` 引用默认不进入瀑布流。

  模型使用 `read_artifact` 读取元数据，确认类型、来源和版本；只有确实需要正文时才调用
  `read_artifact_text` 分窗读取 UTF-8 文本。二进制 Artifact 不伪装成文本塞进上下文，
  应交给匹配的领域能力或仅作为用户交付件。`model_context` 表示该稳定引用允许用于任务
  交接：Backend 在后续 ModelContext 的动态状态区投影一个有界的 Artifact 卡片索引
  （reference/title/kind/mediaType/byteCount/contentHash），不自动注入正文。超出通用
  索引预算的长期成果应进入 active Task 的 `artifactRefs`，不能让 model_context 成为
  无限增长的另一段历史。

  Artifact 不得暗含“必定来自 ToolExecution”的假设。来源显式区分 `tool` 与
  `user_upload`，两者统一获得稳定的 `artifact://artifact_<id>@<version>` 引用。用户
  Message 只保存引用；Provider 输入只投影有界元数据，正文仍按窗口读取或由工具通过
  引用直接装载。这样简历、报表、日志和图纸只是不同输入数据，不会形成场景特判。

  当前可见性是可重建的状态投影；每次 `publish` 另存不可变发布事实。这样重复发布不会
  制造多张相同成果卡，崩溃恢复又能从本次 ToolExecution 找回尚未完成的前端投影。

Artifact、Evidence 和文件各司其职：

- Evidence 证明一个 claim，由工具 verify 产生；
- Artifact 是可传递、可预览或可下载的不可变内容版本；
- Workspace file 是用户可继续编辑的当前文件；
- Task Work State 只保存 Evidence/Artifact 稳定引用，不复制正文。

首版每次登记都创建新的 `artifactId@1`，即使逻辑文件名相同也不隐式覆盖。等真实场景
证明“同一产物的新版本”语义后，再增加显式 version lineage，避免现在凭文件路径猜身份。

### 3.2 预览是受信投影，不是执行产物

用户看到 Artifact 卡片时，正文仍不进入 ConversationView。只有用户打开卡片，Frontend
才按 `previewRef` 拉取一个有界的 `ArtifactPreviewView`。Backend 根据已登记的
`mediaType + name` 选择受信任的展示模式：

- Markdown、JSON、纯文本和 CSV 返回有界 UTF-8 文本，由 Iris 自有组件渲染；
- PNG、JPEG、GIF、WebP 只通过专用只读图片端点展示；
- HTML、SVG、Office、PDF、压缩包和未知二进制首版只提供元数据与下载。

模型生成的 HTML 不在 Iris 主页面执行。未来需要“活文档/任务黑板”时，优先定义声明式
Artifact View Model，由受信组件目录渲染筛选器、表格、进度与链接；任意 HTML 只能作为
单独的隔离展示能力，并且不能拥有主应用身份、凭据或网络权限。

这一边界服务于实际体验：用户不打开就不读取、不解析、不渲染；打开后直接查看结构化
成果，不要求模型把大表或长报告重新复述一遍。Artifact 是下一程协作的稳定界面，
Answer 只说明结论和下一步。

## 4. 设计规范提炼（通用）

1. **一切写前快照**：没有检查点的写操作不许合并。
2. **错误信息教学化**：拒绝时告诉用户正确用法长什么样。
3. **大输出必截断**：任何可能无限大的输出（文件/查询/子进程）都有上限 + "已截断"明示。
4. **如实命名隔离强度**：独立目录、超时和强杀只是 Runner 约束；没有 OS 边界就不能声称任意代码安全。
5. **产物可追踪**：每个产物记得自己由哪次工具调用产生（sourceToolCallId），对话与文件互链。
