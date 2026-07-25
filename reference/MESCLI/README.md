# MESCLI Reference

参考项目之一：企业级 Agent 后端的**抽象架构**样本。只保留核心部分，不含任何业务域工具。

> 目录中的 `.md` 文件内为 C# 源码，仅供阅读参考，不用于运行。

## 定位

这是"工具平台该有的样子"的抽象样本：工具的契约、注册、目录、发现、审批、
沙箱、工作区围栏的完整闭环。不包含 MES 业务语义（车间/工序/配方），
那些是它的业务，不是我们的。

## 值得借鉴的思路（Java 后端实现时）

1. **工具契约**：`ITool`（Name / Description / Parameters / InvokeAsync）
   + `ToolDefinition` 参数 schema + `ToolResult` 统一结果 + `ToolContext` 执行上下文
2. **目录即能力树**：`ToolCatalogMetadataAttribute` 用注解声明目录路径，
   `CapabilityService` / `DomainCatalog` 装配能力树，`CapabilitiesController` 对外暴露目录 API
3. **发现原语**：`ToolSearchTool`（工具搜索）+ `SchemaDiscovery/`（ListTables /
   GetTableSchema / SearchSchema / ExecuteSqlQuery）——模型先发散后收敛，不预装 schema
4. **审批与授权**：`ToolApprovalService` + `ToolAuthorizationService`，
   写操作挂起等待批准，审批契约见 `Models/ApprovalDecision` 等
5. **沙箱双实现**：`DockerSandboxExecutor`（强隔离）/ `ProcessSandboxExecutor`（轻量），
   `ExecutePythonScriptTool` 是 Python 执行的工具入口
6. **工作区围栏**：`Tools/Workspace/` 六个文件工具 + `WorkspaceFileService`
   路径校验 + `WorkspaceWriteContext` 写上下文

## 与 Iris 的关系

Iris 后端不照搬 C# 代码，而是把这些抽象语义用 Java/Spring Boot 原生重写，
结合我们的终极愿景（Turn/Run/Round 状态机、SSE 投影、能力树生长、
前端 WonWork 式的瀑布流体验），形成原生高效的 Agentic 后端。

## 结构

```
Tools/               工具契约与基础设施（ITool, Registry, Definition, Context, Result...）
Tools/SchemaDiscovery/  SQL 发现原语（列表/结构/搜索/查询）
Tools/Workspace/        工作区文件工具（读写替换列举删除 + 产物呈现）
Tools/Code/             Python 沙箱执行工具
Services/            能力目录、审批授权、沙箱执行器、工作区服务
Controllers/         能力目录与工具调用 API
Models/              能力树、目录项、审批契约等模型
```
