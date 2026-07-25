import type { WorkflowDefinition } from '@/types/webbridge'

export const EXAMPLE_WORKFLOW_TAG = 'built-in-example'

export interface WorkflowTemplate {
  id: string
  name: string
  description: string
  category: 'data_extraction' | 'form_automation' | 'monitoring' | 'research' | 'custom'
  icon?: string
  parameters: {
    name: string
    key: string
    label: string
    defaultValue: string
    placeholder?: string
  }[]
  build: (params: Record<string, string>) => WorkflowDefinition
}

function placeholder(name: string, description = ''): WorkflowDefinition {
  return {
    id: `template-${Date.now()}`,
    name,
    description,
    workflow_type: 'custom',
    steps: [],
  }
}

export const WORKFLOW_TEMPLATES: WorkflowTemplate[] = [
  {
    id: 'download-and-browse',
    name: '下载文件并浏览工作区',
    description: '访问网页、下载资源、保存页面 HTML，最后截图。适合演示工作区文件浏览器。',
    category: 'data_extraction',
    parameters: [
      { name: 'url', key: 'url', label: '目标网址', defaultValue: 'https://www.baidu.com', placeholder: 'https://www.baidu.com' },
      { name: 'downloadUrl', key: 'downloadUrl', label: '下载文件地址', defaultValue: 'https://example.com/image.png', placeholder: 'https://...' },
    ],
    build: (params) => ({
      ...placeholder(params.name || '下载文件并浏览工作区', `访问 ${params.url} 并保存资源到工作区`),
      workflow_type: 'data_extraction',
      steps: [
        {
          step_id: 'navigate',
          description: '访问目标页面',
          actions: [{ action_type: 'navigate', value: params.url }],
          on_error: 'stop',
        },
        {
          step_id: 'wait',
          description: '等待页面加载',
          actions: [{ action_type: 'wait', delay_ms: 2000 }],
          on_error: 'skip',
        },
        {
          step_id: 'save_page',
          description: '保存页面 HTML',
          actions: [{ action_type: 'save_page' }],
          on_error: 'skip',
        },
        {
          step_id: 'screenshot',
          description: '截图留存',
          actions: [{ action_type: 'screenshot' }],
          on_error: 'skip',
        },
        {
          step_id: 'download',
          description: '下载指定文件',
          actions: [{ action_type: 'download', value: params.downloadUrl }],
          on_error: 'stop',
        },
      ],
    }),
  },
  {
    id: 'table-extraction',
    name: '表格提取',
    description: '访问指定网页并提取表格数据。',
    category: 'data_extraction',
    parameters: [
      { name: 'url', key: 'url', label: '目标网址', defaultValue: 'https://example.com', placeholder: 'https://example.com' },
      { name: 'tableSelector', key: 'tableSelector', label: '表格选择器', defaultValue: 'table', placeholder: 'table, #data-table, .table' },
    ],
    build: (params) => ({
      ...placeholder(params.name || '表格提取', `从 ${params.url} 提取表格`),
      workflow_type: 'data_extraction',
      steps: [
        {
          step_id: 'navigate',
          description: '访问目标页面',
          actions: [{ action_type: 'navigate', value: params.url }],
          on_error: 'stop',
        },
        {
          step_id: 'screenshot',
          description: '截图确认页面',
          actions: [{ action_type: 'screenshot' }],
          on_error: 'skip',
        },
        {
          step_id: 'extract',
          description: '提取表格数据',
          actions: [
            {
              action_type: 'extract_table',
              selector: { selector_type: 'css', value: params.tableSelector },
            },
          ],
          on_error: 'stop',
        },
      ],
    }),
  },
  {
    id: 'table-export',
    name: '表格提取并导出 Excel',
    description: '访问含表格页面，提取表格并导出为 CSV/Excel 到 workspace/exports。',
    category: 'data_extraction',
    parameters: [
      { name: 'url', key: 'url', label: '目标网址', defaultValue: 'https://www.w3schools.com/html/html_tables.asp', placeholder: 'https://...' },
      { name: 'tableSelector', key: 'tableSelector', label: '表格选择器', defaultValue: 'table', placeholder: 'table, #data-table' },
      { name: 'format', key: 'format', label: '导出格式', defaultValue: 'xlsx', placeholder: 'csv 或 xlsx' },
    ],
    build: (params) => ({
      ...placeholder(params.name || '表格提取并导出 Excel', `从 ${params.url} 导出表格`),
      workflow_type: 'data_extraction',
      steps: [
        {
          step_id: 'navigate',
          description: '访问目标页面',
          actions: [{ action_type: 'navigate', value: params.url }],
          on_error: 'stop',
        },
        {
          step_id: 'extract',
          description: '提取表格',
          actions: [{ action_type: 'extract_table', selector: { selector_type: 'css', value: params.tableSelector } }],
          on_error: 'stop',
        },
        {
          step_id: 'export',
          description: `导出为 ${params.format}`,
          actions: [{ action_type: 'export_table', value: params.format, selector: { selector_type: 'css', value: params.tableSelector } }],
          on_error: 'stop',
        },
      ],
    }),
  },
  {
    id: 'login-and-query',
    name: '登录后查询',
    description: '登录系统后执行查询操作。',
    category: 'form_automation',
    parameters: [
      { name: 'url', key: 'url', label: '登录页网址', defaultValue: 'https://example.com/login', placeholder: 'https://example.com/login' },
      { name: 'usernameSelector', key: 'usernameSelector', label: '用户名输入框', defaultValue: 'input[name="username"]', placeholder: '#username' },
      { name: 'passwordSelector', key: 'passwordSelector', label: '密码输入框', defaultValue: 'input[name="password"]', placeholder: '#password' },
      { name: 'submitSelector', key: 'submitSelector', label: '登录按钮', defaultValue: 'button[type="submit"]', placeholder: '#login-button' },
      { name: 'querySelector', key: 'querySelector', label: '查询输入框', defaultValue: 'input[name="query"]', placeholder: '#query' },
      { name: 'queryValue', key: 'queryValue', label: '查询内容', defaultValue: '', placeholder: '查询关键词' },
    ],
    build: (params) => ({
      ...placeholder(params.name || '登录后查询', `登录 ${params.url} 并查询`),
      workflow_type: 'form_automation',
      steps: [
        {
          step_id: 'navigate',
          description: '打开登录页',
          actions: [{ action_type: 'navigate', value: params.url }],
          on_error: 'stop',
        },
        {
          step_id: 'login',
          description: '填写登录表单',
          actions: [
            { action_type: 'screenshot' },
            { action_type: 'type', selector: { selector_type: 'css', value: params.usernameSelector }, value: '${username}' },
            { action_type: 'type', selector: { selector_type: 'css', value: params.passwordSelector }, value: '${password}' },
            { action_type: 'click', selector: { selector_type: 'css', value: params.submitSelector } },
            { action_type: 'wait', delay_ms: 2000 },
          ],
          on_error: 'stop',
        },
        {
          step_id: 'query',
          description: '执行查询',
          actions: [
            { action_type: 'type', selector: { selector_type: 'css', value: params.querySelector }, value: params.queryValue },
            { action_type: 'wait', delay_ms: 1000 },
            { action_type: 'screenshot' },
          ],
          on_error: 'stop',
        },
      ],
    }),
  },
  {
    id: 'scheduled-screenshot',
    name: '定时截图',
    description: '访问页面并保存截图。',
    category: 'monitoring',
    parameters: [
      { name: 'url', key: 'url', label: '目标网址', defaultValue: 'https://example.com', placeholder: 'https://example.com' },
    ],
    build: (params) => ({
      ...placeholder(params.name || '定时截图', `对 ${params.url} 截图`),
      workflow_type: 'monitoring',
      steps: [
        {
          step_id: 'navigate',
          description: '访问目标页面',
          actions: [{ action_type: 'navigate', value: params.url }],
          on_error: 'stop',
        },
        {
          step_id: 'wait',
          description: '等待页面加载',
          actions: [{ action_type: 'wait', delay_ms: 2000 }],
          on_error: 'skip',
        },
        {
          step_id: 'screenshot',
          description: '保存页面截图',
          actions: [{ action_type: 'screenshot' }],
          on_error: 'stop',
        },
      ],
    }),
  },
  {
    id: 'form-fill',
    name: '表单填写',
    description: '自动填写并提交表单。',
    category: 'form_automation',
    parameters: [
      { name: 'url', key: 'url', label: '表单页网址', defaultValue: 'https://example.com/form', placeholder: 'https://example.com/form' },
      { name: 'fieldSelector', key: 'fieldSelector', label: '输入框选择器', defaultValue: 'input[name="field"]', placeholder: '#field' },
      { name: 'fieldValue', key: 'fieldValue', label: '填写内容', defaultValue: '', placeholder: '要填写的内容' },
      { name: 'submitSelector', key: 'submitSelector', label: '提交按钮', defaultValue: 'button[type="submit"]', placeholder: '#submit' },
    ],
    build: (params) => ({
      ...placeholder(params.name || '表单填写', `在 ${params.url} 填写表单`),
      workflow_type: 'form_automation',
      steps: [
        {
          step_id: 'navigate',
          description: '打开表单页',
          actions: [{ action_type: 'navigate', value: params.url }],
          on_error: 'stop',
        },
        {
          step_id: 'fill',
          description: '填写并提交',
          actions: [
            { action_type: 'screenshot' },
            { action_type: 'type', selector: { selector_type: 'css', value: params.fieldSelector }, value: params.fieldValue },
            { action_type: 'click', selector: { selector_type: 'css', value: params.submitSelector } },
            { action_type: 'wait', delay_ms: 2000 },
            { action_type: 'screenshot' },
          ],
          on_error: 'stop',
        },
      ],
    }),
  },
  {
    id: 'upload-file',
    name: '文件上传',
    description: '将工作区文件上传到网页的 <input type="file"> 元素。',
    category: 'form_automation',
    parameters: [
      { name: 'url', key: 'url', label: '含文件输入框的页面', defaultValue: 'data:text/html,<input type="file" id="fileInput">', placeholder: 'https://... 或 data URI' },
      { name: 'selector', key: 'selector', label: '文件输入框选择器', defaultValue: '#fileInput', placeholder: '#fileInput' },
      { name: 'filePath', key: 'filePath', label: '工作区文件相对路径', defaultValue: 'downloads/test-upload.txt', placeholder: 'downloads/xxx.png' },
    ],
    build: (params) => ({
      ...placeholder(params.name || '文件上传', `上传 ${params.filePath}`),
      workflow_type: 'form_automation',
      steps: [
        {
          step_id: 'navigate',
          description: '打开含文件输入框的页面',
          actions: [{ action_type: 'navigate', value: params.url }],
          on_error: 'stop',
        },
        {
          step_id: 'upload',
          description: '上传工作区文件',
          actions: [
            {
              action_type: 'upload',
              selector: { selector_type: 'css', value: params.selector },
              value: params.filePath,
            },
          ],
          on_error: 'stop',
        },
        {
          step_id: 'screenshot',
          description: '截图确认上传结果',
          actions: [{ action_type: 'screenshot' }],
          on_error: 'skip',
        },
      ],
    }),
  },
]

export function buildExampleWorkflows(): WorkflowDefinition[] {
  const workflows: WorkflowDefinition[] = [
    {
      id: `example-${EXAMPLE_WORKFLOW_TAG}-baidu`,
      name: '📘 示例：访问百度并保存资源',
      description: '演示 navigate、save_page、download、screenshot 和工作区浏览器用法。',
      workflow_type: 'data_extraction',
      steps: [
        {
          step_id: 'navigate',
          description: '访问百度',
          actions: [{ action_type: 'navigate', value: 'https://www.baidu.com' }],
          on_error: 'stop',
        },
        {
          step_id: 'wait',
          description: '等待加载',
          actions: [{ action_type: 'wait', delay_ms: 2000 }],
          on_error: 'skip',
        },
        {
          step_id: 'save',
          description: '保存页面 HTML',
          actions: [{ action_type: 'save_page' }],
          on_error: 'skip',
        },
        {
          step_id: 'screenshot',
          description: '截图',
          actions: [{ action_type: 'screenshot' }],
          on_error: 'skip',
        },
        {
          step_id: 'download',
          description: '下载示例图片',
          actions: [{ action_type: 'download', value: 'https://example.com/image.png' }],
          on_error: 'stop',
        },
      ],
    },
    {
      id: `example-${EXAMPLE_WORKFLOW_TAG}-table`,
      name: '📗 示例：提取表格并导出 Excel',
      description: '演示 extract_table 和 export_table，结果写入 workspace/exports。',
      workflow_type: 'data_extraction',
      steps: [
        {
          step_id: 'navigate',
          description: '打开示例表格页',
          actions: [{ action_type: 'navigate', value: 'https://www.w3schools.com/html/html_tables.asp' }],
          on_error: 'stop',
        },
        {
          step_id: 'extract',
          description: '提取表格',
          actions: [{ action_type: 'extract_table' }],
          on_error: 'stop',
        },
        {
          step_id: 'export',
          description: '导出为 Excel',
          actions: [{ action_type: 'export_table', value: 'xlsx' }],
          on_error: 'stop',
        },
      ],
    },
    {
      id: `example-${EXAMPLE_WORKFLOW_TAG}-upload`,
      name: '📙 示例：文件上传',
      description: '演示 upload 动作。先确保 workspace/downloads 有 test-upload.txt。',
      workflow_type: 'form_automation',
      steps: [
        {
          step_id: 'navigate',
          description: '打开含文件输入框的页面',
          actions: [{ action_type: 'navigate', value: 'data:text/html,%3Cinput%20type%3D%22file%22%20id%3D%22fileInput%22%3E' }],
          on_error: 'stop',
        },
        {
          step_id: 'upload',
          description: '上传测试文件',
          actions: [
            {
              action_type: 'upload',
              selector: { selector_type: 'id', value: 'fileInput' },
              value: 'downloads/test-upload.txt',
            },
          ],
          on_error: 'stop',
        },
        {
          step_id: 'screenshot',
          description: '截图确认',
          actions: [{ action_type: 'screenshot' }],
          on_error: 'skip',
        },
      ],
    },
  ]
  return workflows.map((w) => ({ ...w, description: `${w.description} [${EXAMPLE_WORKFLOW_TAG}]` }))
}

export const TEMPLATE_CATEGORIES: { value: WorkflowTemplate['category']; label: string }[] = [
  { value: 'data_extraction', label: '数据提取' },
  { value: 'form_automation', label: '表单自动化' },
  { value: 'monitoring', label: '监控' },
  { value: 'research', label: '研究' },
  { value: 'custom', label: '自定义' },
]
