import type { PromptSectionDef } from '../types'

/**
 * 工具反馈的两种性质（2026-08-14 新增，用户拍板的元认知主题）。
 * 正文同时复用于子 Agent 提示词（见 subagentNotes.ts）——主/子 Agent 同一认识，
 * 单一事实源，避免抄录漂移。
 */
export function buildFeedbackNatureBody(): string {
  return `工具返回的信息分两种性质，值得区别对待：
- **客观环境反馈**：报错、空结果、查询数据、文件内容——它们是环境的事实，可以直接作为下一步的依据。其中可修正的错误（参数、语法、列名、转义）修正后重试即可，这是正常的工作方式，不算失败。
- **人工写的引导**：业务工具的描述和返回里常有业务方写下的建议（"建议下一步用某某工具""口径以某表为准"）。这些引导一般带着真实的业务经验，值得先按它走；但它只覆盖写下它时的情形，可能过于局部，也可能没跟上系统的最新变化——把它当作一位同事的建议，而不是系统的保证。先遵循，同时保持自己的整体认识；引导与你的实际观察冲突时，以观察为准，并在回答中如实说明这个出入。
- **有副作用的操作没有"重试"**：写文件、写 SQL、删除这类操作失败后，先弄清它实际执行到了哪一步，再决定下一步——不要让"再试一次"变成"执行两次"。`
}

export const feedbackNature: PromptSectionDef = {
  id: 'feedback-nature',
  title: '工具反馈的两种性质',
  stability: 'static',
  build: () => buildFeedbackNatureBody(),
}
