# 41 · 环境自举规范化：新机器零手工（设计稿）

> 状态：**已落地**（2026-08-27：`SqliteDirectoryBootstrap` EnvironmentPostProcessor
> 自动建 DB 父目录、SchemaColumnMigration @Order(5)、bundledRoot 缺失 WARN；
> 129 测试 0 失败、历史遗留基线不变）。幂等 schema 与目录自举为既有现状，
> 本稿确认保留；异步化经评估不做（见 §3）。
> 起因：用户 2026-08-27 提出「幂等的 SQL 创建 + 环境规范好，每次启动自动
> 创建好需要的，有就跳过，新机器 git 拉下来不用自己配」。
> 摸底结论（同日）：幂等初始化已是现状（schema.sql 116 个 CREATE 全部
> IF NOT EXISTS + 幂等列迁移，每次启动全量重跑仅几十毫秒）；
> **异步化不做**——同步初始化毫秒级，异步化要为 12+1 个有顺序依赖的
> 启动期 DB 触点重做依赖图，收益趋零。本稿只修真缺口。

## 1. 现状确认（不变部分）

- schema 初始化：`spring.sql.init.mode: always` + 全量 `IF NOT EXISTS`，
  同步执行，幂等，暖库 10–30ms。保持同步（正确且简单）。
- 目录自举：`~/Iris/workspace`（WorkspaceService 构造器）与
  `~/Iris/data/objects`（ManagedObjectStore 构造器）启动时自动建，
  失败即明确的启动失败。保持。

## 2. 修复三个真缺口

### 2.1 IRIS_DB_PATH 父目录自动创建（新机器最可能踩的坑）

现状：父目录不存在时 sqlite-jdbc 报 `path does not exist`，被 Hikari/Spring
包三层后根因埋在堆栈底部，全库无 FailureAnalyzer。

修法：`EnvironmentPostProcessor`（context refresh 之前）解析
`spring.datasource.url`（占位符已求值），对 `jdbc:sqlite:` 路径
`createDirectories` 父目录；建不出来时抛出带人话的异常
（「Iris 数据库目录不可写：\<path\>，请检查 IRIS_DB_PATH 或目录权限」）——
同步、fail-close、报错即根因。注册进
`META-INF/spring/org.springframework.boot.env.EnvironmentPostProcessor.imports`。

### 2.2 SchemaColumnMigration 显式排序（定时炸弹）

现状：无 `@Order`，排在 `@Order(10)` 的 ModelProfileCatalog **之后**——
今天不炸只因为 schema.sql 已含那两列；将来新增列若被早期 runner 读取必炸。

修法：加 `@Order(5)`，先于一切读库 runner（ModelProfileCatalog=10 起）。
一行改动，消除一类未来事故。

### 2.3 内建拓展根的 CWD 依赖（静默丢工具）

现状：`ExtensionProperties` 的 bundledRoot 用相对路径 `../extensions`
解析，依赖从 `backend/` 启动；别处起 jar **静默**丢掉全部内建拓展
（浏览器/Python/SQL 工具消失且无报错）。

修法：启动时若 bundledRoot 解析不到，打 **WARN 日志**（列出解析自哪个
CWD、期望什么），不静默。不改成 fail-close（开发场景从 IDE 不同目录
启动是常态），但让「工具凭空消失」可诊断。

## 3. 不做（防反悔）

- 不做 schema 异步初始化/就绪门（收益趋零，依赖图成本真实）；
- 不做配置中心/安装向导：模型 profile、webbridge token 等本来就是
  「不配则对应能力调用期降级」的设计（docs/35 既定），新机器唯一
  必配项是模型 API Key，属密钥不该进仓库；
- 不动 extensions 根的五层解析规则本身（docs/31 已定）。

## 4. 验收标准

1. 删掉 DB 文件与父目录后启动：目录自动创建、schema 落齐、服务正常；
2. IRIS_DB_PATH 指到不可写位置：启动失败且首行错误即人话根因；
3. SchemaColumnMigration 执行顺序在 ModelProfileCatalog 之前（日志可见）；
4. 从仓库根（非 backend/）启动：出现 bundledRoot 解析 WARN；
5. 后端全量测试通过（129 + 历史遗留基线不变）。
