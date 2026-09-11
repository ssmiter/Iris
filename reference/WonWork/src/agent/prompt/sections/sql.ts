import type { PromptSectionDef } from '../types'

/**
 * SQL 查询特别说明（原 §2.6，原样搬运）。
 * online 下 SQL 默认不注入上下文（2026-07-27 起经能力发现按需加载），但定位与操作要点
 * 必须先于使用被知道，故 online 恒注入本节；其他模式维持"工具在上下文才注入"。
 */
export const sql: PromptSectionDef = {
  id: 'sql',
  title: 'SQL 查询特别说明',
  stability: 'static',
  when: (ctx) =>
    ctx.mode === 'mescli-online' ||
    ctx.registry.list().some((t) => (t.alwaysLoad || !t.deferred) && t.name === 'execute_sql_query'),
  build: (ctx) => {
    const isOnlineSql = ctx.mode === 'mescli-online'
    return `${
      isOnlineSql
        ? `**在 MES 在线模式下，execute_sql_query 永远是辅助角色**。你的最高优先级永远是通过能力发现（{ref:discovery|能力发现}）准确找到未注入上下文、能回答业务问题的业务工具——它们的口径经过业务方确认。SQL 仅用于：预览表结构帮助理解、已确认业务工具覆盖不了、或对业务工具返回结果做二次加工。它默认不注入上下文，确有需要时通过能力发现加载。数据查不到或不完整时，先怀疑业务工具没用到位——回到 {ref:discovery|能力发现} 换角度继续找；适度尝试后仍没有，就如实告知数据现状，不要用 SQL 自行探索补全——数据本身的不足不是你的问题，除非用户明确要求你用 SQL 探索。\n`
        : ''
    }- <code>execute_sql_query</code> 支持读和写（SELECT / PRAGMA / EXPLAIN 与 INSERT / UPDATE / DELETE / CREATE / DROP / ALTER 等）。
- ${
      isOnlineSql
        ? '当前后端是 **SQL Server**：预览表结构用 <code>SELECT TOP 1 * FROM table_name</code>，**不要使用 LIMIT / PRAGMA**（那是 SQLite 语法，会直接报错）。'
        : '当前后端是 **SQLite**：想查看表结构时，优先使用 <code>SELECT * FROM table_name LIMIT 1</code>（PRAGMA 属于读操作可直接执行，但 LIMIT 预览对后续查询更有参考价值）。'
    }
- **查询结果不再整体截断**：完整结果集会自动落盘到 <code>/workspace/scratch/{date}/sql_result_*.json</code>，返回中包含总行数、预览行和落盘路径。需要全量分析（如按多月/多维度聚合）时，用 <code>execute_python_script</code> 读取落盘文件处理，**不要因为预览行数有限而重复查询或换工具重算**。
- **探索 SOP（避免盲查）**：对陌生表分析时，先 <code>COUNT(*)</code> + <code>MIN/MAX(日期列)</code> 确认数据量和时间范围，确认数据落在用户需求范围内后再细查；查询反复返回空时先怀疑"数据是否存在"，而不是继续变换条件试探。
- **多维聚合尽量减少往返**：需要按多个维度（如按物料/班次/机台）分别汇总时，更高效的做法是一次查询带上全部维度列后落盘用 Python 透视，或合并为少数几条 GROUP BY，而不是每个维度单独往返一次。
- 如果报错是 <code>no such column/table</code>、语法错误等可恢复错误，**立即根据错误信息修正 SQL 并重新调用工具**，不要只向用户解释。
- 如果某条语句因安全策略被拦截，**不要停止**，应立刻改用允许的 SELECT 查询继续完成任务。
- **db_name 缺省即可**：Online 模式下 db_name 留空会自动使用当前登录域的主库，绝大多数查询不需要显式指定。工具描述里枚举的数据库（MES/MENS/IRIS 等）是全部域的总览，**不代表当前域都能访问**——跨域指定会被拒绝，遇到"当前登录域不允许访问"时直接改用缺省 db_name 重试，不要反复尝试其他库名。`
  },
}
