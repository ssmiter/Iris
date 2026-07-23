# CLAUDE.md

本文件指导 AI 助手（Claude Code 等）在本仓库中的工作方式。

## 项目定位

Weave 是个人 AI 助手：瀑布流对话前端 + 大规模工具平台后端（Java/Spring Boot）+ 浏览器自动化 + 本地工作区与沙箱。最终形态为 Windows exe 个人产品。

## 最重要的五条不变量

1. **对话历史不可丢**：分支变体、压缩边界、工具调用结构全部持久化；任何"优化"都不得丢弃历史信息，只能改变"当前视野"。
2. **发现优于塞满**：工具 schema 不预装进上下文，一律走发现原语（目录/搜索/按需读取）。新增工具必须带目录路径与描述，否则不注册。
3. **写操作必审批**：任何改变外部世界状态的工具（写文件、发请求、提交表单、支付）默认挂起等待批准；只读工具直接执行。审批请求必须带一句人话的影响陈述。
4. **路径围栏**：文件工具只允许操作工作区根目录内路径，越界一律拒绝（fail-close）。
5. **视觉克制**：动画只用于注意力锚定；禁止无意义的频繁移动。新组件先回答"它减少了用户哪一次寻找"。

## 分层约定

```
frontend/          Vite + React + TS（瀑布流对话）
backend/           Spring Boot 3（工具平台 + 代理 + 工作区 + 历史）
webbridge-daemon/  浏览器自动化守护进程（独立进程，HTTP 本地通信）
docs/              设计文档（先改文档再改代码，文档与代码同步更新）
```

## 常用命令

```bash
# 前端
cd frontend && npm install && npm run dev        # :5173，/api 代理 :5001

# 后端
cd backend && ./mvnw spring-boot:run             # :5001

# WebBridge daemon
cd webbridge-daemon && npm install && npm start  # :9223
```

## 编码约定

- 后端工具按 `tools/<域>/<目录>/XxxTool.java` 组织——**文件目录即能力树路径**，不许在代码里另写一套路径映射。
- 每个工具必须声明：name（snake_case）、description（一句话，发现用）、目录路径、风险等级（read_only/standard/elevated/destructive）、参数 JSON Schema。
- SSE 是唯一的流式通道；对话代理、工具进度、审批状态都走 SSE 事件，禁止轮询。
- 状态持久化默认 SQLite；能用单表解决的不要加中间件。

## 文档优先

改架构先改 docs/ 对应文档；新工具域先在 docs/03 的域清单里登记。文档是 GitHub 作品的一部分，保持可独立阅读。
