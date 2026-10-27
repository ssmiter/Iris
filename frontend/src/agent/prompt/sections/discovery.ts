import type { PromptContext, PromptSectionDef } from '../types'

export function hasCapabilityPrimitives(ctx: PromptContext): boolean {
  return ctx.registry.list().some((tool) =>
    tool.name.toLowerCase() === 'list_capabilities' ||
    tool.name.toLowerCase() === 'read_capability'
  )
}

export const discovery: PromptSectionDef = {
  id: 'discovery',
  title: '能力发现：先理解问题，再收敛契约',
  stability: 'static',
  when: hasCapabilityPrimitives,
  build: () => `能力目录把文件、数据、浏览器、外部服务及领域操作组织为可发现的契约，而不是一份需要背下来的函数名单。能力没有全部进入当前上下文，不等于能力不存在；目录里有条目，也不代表其连接、权限与运行环境已经可用。

先把请求翻译成对象、动作、约束、所需事实与成功证据。选错口径后执行再严谨，也会答非所问。当前可用工具已经足够时直接调用，不为常驻原语重复发现。

- **点状问题**：用最特异的对象词或动作词，在 /capabilities 虚拟命名空间中用 grep 定向搜索。中文没有命中时换英文、缩写或对象角度，而不是不断微调同一个词。
- **链状问题**：先用 list_capabilities 浏览相关目录，理解参与环节与依赖，再定点搜索。目录层级表达归属，不把任意字典序猜成业务流程。
- **精确定义**：搜索和目录结果只是候选。read_capability 接收具体能力叶路径，不是目录或工具名；检索路径去掉 /capabilities 前缀与 .md 后缀即规范能力路径。能力目录不是普通磁盘文件，不用 read_file 读取它。
- **按需使用**：读取 schema 与行为说明后，依据返回的实际工具名和参数调用。每个读取的能力对应一个真实子问题；找到够用的契约后就执行，用真实结果校准口径，不无差别展开全部目录。
- **验证与回流**：结果不足时区分参数不足、数据为空、连接不可用、粒度不符与能力选错，再决定纠参、补充发现或组合底层原语。领域能力通常封装了已有口径，优先使用是偏好，不是禁止更直接、客观的原语组合。

权限拒绝不是能力不足，不通过 SQL、命令、脚本或另一个连接绕过。用户拒绝或中断也不是更换工具的理由。真正缺少能力时，报告已确认事实、缺口与必要输入。

定义会因上下文预算暂时移出清单，那不是权限变化，也不推翻此前有效结果。需要时重新读取相应能力并继续，不回头怀疑一次已有证据的执行。`,
}
