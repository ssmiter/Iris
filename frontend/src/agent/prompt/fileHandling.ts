import { buildWorkspaceDirsGuide } from '@/config/workspaceDirs'

/**
 * 文件处理规范提示（原 localToolPrompt.getFileHandlingPrompt 原样搬运）。
 * 注意：本段含当日日期目录，是 session 级内容——它作为独立的
 * file_handling 顶层 system 段注入，不影响 tool_usage 段的前缀稳定性。
 * 【Iris 2026-09】standalone 已删除，恒为本地模式（工作区以后端为权威源）。
 */
export function buildFileHandlingPrompt(_mode?: string): string {
  const modeLine =
    '- 本地模式下，工作区以后端为权威源；文件读写 list 通过 /api/workspace 操作真实磁盘，写操作仍受 read-before-write 与审批流保护。'

  const today = new Date()
  const dateDir = `${today.getFullYear()}${String(today.getMonth() + 1).padStart(2, '0')}${String(today.getDate()).padStart(2, '0')}`

  return `## 文件处理规范

- **/workspace/ 是统一命名空间**：前端工具与 Python 沙箱都通过它共享文件。
${buildWorkspaceDirsGuide(dateDir)}
- **前端文件工具（read_file / write_file / str_replace / list_files / glob / grep / delete_file）接受两类路径**：<code>/workspace/</code> 虚拟路径，以及物理绝对路径（如 <code>E:\\code\\proj\\src\\a.ts</code>）。物理路径受目录登记闸保护：未登记目录首次访问会请你向用户请求授权，授权后该目录及子目录不再询问。读文件用 read_file、改文件用 str_replace、找文件用 glob、查内容用 grep——不要拿 run_command 的 cat/head/tail/grep 当文件工具用。
- **Python 沙箱是本地执行环境管理，不是安全隔离容器**；在 Process 模式下它可以访问 C:/D:/E: 等本地路径，这是 WonWork 为内部用户提供的灵活能力，不是漏洞。
- 读取或修改已授权目录外的文件，先经目录授权（"目录未登记"失败时**原样重发同一调用**即触发授权卡，用户确认一次后不再询问）；不要为读取而把外部文件或目录复制进工作区。只有确需纳入工作区的外部资料（交付物、反复处理的数据集）才放 <code>/workspace/sync/&lt;name&gt;/</code>。
- 工作区文件统一以 "/workspace/" 为前缀。后端生成的 Word/Excel/PPT/图片等文件会自动落入 "/workspace/outputs/{yyyyMMdd}/..."，可通过 list_files 查看、read_file 读取文本、execute_python_script 读取二进制内容。
- 用户上传的附件已保存到 <code>/workspace/uploads/{yyyyMMdd}/</code>，用户消息中以「[工作区文件: 名称] 路径：...」引用；需要内容时用 read_file 读取（图片已内嵌 base64，无需再读）。若附件以内联「[文件: 名称]」形式出现，则内容已随消息给出，可直接引用。
- **写文件前必须先读**：调用 write_file 前，必须先调用 read_file 获取当前完整内容，并在 ".expectedContent" 字段回传。str_replace 同样必须先 read_file 再逐字复制 old_string。
- 如果目标文件不存在，write_file 会创建新文件，此时无需 expectedContent。
- delete_file 是高风险、不可恢复操作，执行前必须向用户确认，禁止静默删除。
- 读取大文件时，优先使用 offset/limit 参数控制返回长度，避免上下文爆炸。
- Office/PDF/图片等二进制文件不要直接全文 read_file；优先使用 execute_python_script 配合 python-docx/openpyxl/python-pptx/Pillow 等库提取文本或转换。
- **execute_python_script 的 OUTPUT_PATH 是强制写入目标**：任何需要作为本次产出返回的文件，必须写入 OUTPUT_PATH（框架会自动包装 stdout 兜底，但显式写入更可靠）。脚本可以直接读写工作区文件；需要额外依赖时通过 pip_packages 参数申请安装。用 matplotlib 绘图时沙箱已自动配置中文字体，**不要手动设置 plt.rcParams 的 font.sans-serif**——指定系统不存在的字体会让中文重新变成方框。
${modeLine}`
}
