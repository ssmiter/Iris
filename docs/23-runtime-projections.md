# Tool Runtime 对话投影

> 状态：大陆 2 / 节点 2.6 前置实现已通过统一编译与回归验证

ToolExecution、Approval 与瀑布流节点不是三套真相。Runtime 表保存执行事实，投影器把
安全子集写成 ToolNode / AttentionNode；SSE 与 ConversationView 只读取投影。

- 每个 ToolCall 最多一个 ToolNode；
- 每个 Approval 最多一个 AttentionNode；
- 等待审批时 ToolNode 保持验证/等待语义，同时创建就地 AttentionNode；
- 批准、拒绝、过期或执行终止后，原节点原位更新，不追加伪造的新调用；
- 投影只含人话影响、状态和稳定 ID，不含工具输入、密钥或原始 provider payload。

投影表可重建，`tool_execution` 与 `tool_approval_request` 才是 canonical facts。
