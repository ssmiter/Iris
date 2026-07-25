import { useDagWorkflowStore } from '@/stores/dagWorkflowStore'
import { useTranslation } from 'react-i18next'
import { useMemo, useState } from 'react'
import type { DagNode, DagNodeData, HttpRequestNodeConfig, FileOperationAction, SendMessageChannel, DagWorkflow } from '@/types/dagWorkflow'
import { WEBBRIDGE_PRESETS } from '@/types/webbridge'
import { useWebBridgeStore } from '@/stores/webbridgeStore'
import { BrowserActionEditor } from '@/components/WebBridge/BrowserActionEditor'
import { VariablePicker } from './VariablePicker'
import { KeyValueEditor } from './KeyValueEditor'
import type { BrowserAction } from '@/types/webbridge'
import { cn } from '@/utils'

const COMMON_TOOLS = [
  'execute_sql_query',
  'list_schema_tables',
  'get_table_schema',
  'search_schema',
  'export_to_excel',
  'export_to_word',
  'export_to_image',
  'start_workflow',
  'trace_barcode',
  'create_word_document',
  'create_excel_document',
  'create_pptx_document',
  'web_search',
]

interface DagPropertyPanelProps {
  node: DagNode | null
  workflow: DagWorkflow | null
  onChange: (data: DagNodeData) => void
}

function Field({
  label,
  children,
}: {
  label: string
  children: React.ReactNode
}) {
  return (
    <div className="space-y-1">
      <label className="text-xs font-medium text-surface-600">{label}</label>
      {children}
    </div>
  )
}

function ExpressionBuilder({
  value,
  onChange,
  workflow,
}: {
  value: string
  onChange: (v: string) => void
  workflow: DagWorkflow | null
}) {
  const [left, setLeft] = useState('')
  const [op, setOp] = useState('==')
  const [right, setRight] = useState('')

  const apply = () => {
    const rightVal = /^(true|false|\d+(\.\d+)?)$/.test(right.trim()) ? right.trim() : `"${right.trim()}"`
    onChange(`${left} ${op} ${rightVal}`)
  }

  return (
    <div className="space-y-2 p-2 bg-surface-50 rounded-md border border-surface-100">
      <div className="text-xs font-medium text-surface-600">快速构建条件</div>
      <div className="grid grid-cols-12 gap-2">
        <input
          type="text"
          value={left}
          onChange={(e) => setLeft(e.target.value)}
          placeholder="variables.score"
          className="col-span-5 px-2 py-1 text-xs border border-surface-200 rounded focus:outline-none focus:border-primary-500"
        />
        <select
          value={op}
          onChange={(e) => setOp(e.target.value)}
          className="col-span-3 px-2 py-1 text-xs border border-surface-200 rounded focus:outline-none focus:border-primary-500"
        >
          <option value="==">等于</option>
          <option value="!=">不等于</option>
          <option value=">">大于</option>
          <option value=">=">大于等于</option>
          <option value="<">小于</option>
          <option value="<=">小于等于</option>
          <option value="includes">包含</option>
        </select>
        <input
          type="text"
          value={right}
          onChange={(e) => setRight(e.target.value)}
          placeholder="80"
          className="col-span-4 px-2 py-1 text-xs border border-surface-200 rounded focus:outline-none focus:border-primary-500"
        />
      </div>
      <div className="flex items-center gap-2">
        <button
          onClick={apply}
          className="px-2 py-1 text-xs font-medium text-primary-700 bg-primary-50 hover:bg-primary-100 rounded transition-colors"
        >
          应用
        </button>
        <VariablePicker workflow={workflow} onSelect={(v) => setLeft((prev) => prev + v)} />
      </div>
    </div>
  )
}

export function DagPropertyPanel({ node, workflow, onChange }: DagPropertyPanelProps) {
  const { t } = useTranslation()
  const data = node?.data
  const workflows = useWebBridgeStore((state) => state.workflows)
  const dagWorkflows = useDagWorkflowStore((state) => state.workflows)
  const selectedWorkflow = workflows.find((w) => w.id === data?.webbridge?.workflowId)

  const update = (patch: Partial<DagNodeData>) => {
    if (!data) return
    onChange({ ...data, ...patch })
  }

  const updateTyped = <K extends keyof DagNodeData>(key: K, value: DagNodeData[K]) => {
    update({ [key]: value } as Partial<DagNodeData>)
  }

  const presets = useMemo(() => Object.keys(WEBBRIDGE_PRESETS), [])

  if (!node || !data) {
    return (
      <div className="w-72 bg-white border-l border-surface-200 h-full flex items-center justify-center p-6">
        <p className="text-sm text-surface-400 text-center">{t('visualWorkflow.propertyPanel.selectNode')}</p>
      </div>
    )
  }

  return (
    <div className="w-72 bg-white border-l border-surface-200 flex flex-col h-full">
      <div className="px-4 py-3 border-b border-surface-200">
        <h3 className="text-sm font-semibold text-surface-800">{t('visualWorkflow.propertyPanel.title')}</h3>
        <p className="text-xs text-surface-500 mt-0.5 truncate">{node.type} · {data.label}</p>
      </div>

      <div className="flex-1 overflow-y-auto p-4 space-y-3">
        <Field label={t('visualWorkflow.propertyPanel.label')}>
          <input
            type="text"
            value={data.label}
            onChange={(e) => update({ label: e.target.value })}
            className="w-full px-2 py-1.5 text-sm border border-surface-200 rounded-md focus:outline-none focus:border-primary-500"
          />
        </Field>

        <Field label={t('visualWorkflow.propertyPanel.description')}>
          <input
            type="text"
            value={data.description || ''}
            onChange={(e) => update({ description: e.target.value })}
            className="w-full px-2 py-1.5 text-sm border border-surface-200 rounded-md focus:outline-none focus:border-primary-500"
          />
        </Field>

        {node.type !== 'start' && node.type !== 'end' && (
          <>
            <Field label={t('visualWorkflow.propertyPanel.onError')}>
              <select
                value={data.onError || 'stop'}
                onChange={(e) => update({ onError: e.target.value as DagNodeData['onError'] })}
                className="w-full px-2 py-1.5 text-sm border border-surface-200 rounded-md focus:outline-none focus:border-primary-500"
              >
                <option value="stop">{t('visualWorkflow.propertyPanel.errorStop')}</option>
                <option value="skip">{t('visualWorkflow.propertyPanel.errorSkip')}</option>
                <option value="retry">{t('visualWorkflow.propertyPanel.errorRetry')}</option>
              </select>
            </Field>

            <Field label={t('visualWorkflow.propertyPanel.maxRetries')}>
              <input
                type="number"
                min={0}
                max={3}
                value={data.maxRetries ?? 0}
                onChange={(e) => update({ maxRetries: parseInt(e.target.value || '0', 10) })}
                className="w-full px-2 py-1.5 text-sm border border-surface-200 rounded-md focus:outline-none focus:border-primary-500"
              />
            </Field>
          </>
        )}

        {node.type === 'llm' && (
          <>
            <Field label={t('visualWorkflow.propertyPanel.prompt')}>
              <textarea
                value={data.llm?.prompt || ''}
                onChange={(e) => updateTyped('llm', { ...data.llm, prompt: e.target.value })}
                rows={4}
                className="w-full px-2 py-1.5 text-sm border border-surface-200 rounded-md focus:outline-none focus:border-primary-500 font-mono"
              />
              <div className="mt-1">
                <VariablePicker workflow={workflow} onSelect={(v) => updateTyped('llm', { ...data.llm, prompt: (data.llm?.prompt || '') + v })} />
              </div>
            </Field>
            <Field label={t('visualWorkflow.propertyPanel.model')}>
              <input
                type="text"
                value={data.llm?.model || ''}
                onChange={(e) => updateTyped('llm', { ...data.llm, model: e.target.value })}
                placeholder={t('visualWorkflow.propertyPanel.modelPlaceholder')}
                className="w-full px-2 py-1.5 text-sm border border-surface-200 rounded-md focus:outline-none focus:border-primary-500"
              />
            </Field>
            <Field label={t('visualWorkflow.propertyPanel.systemPrompt')}>
              <textarea
                value={data.llm?.systemPrompt || ''}
                onChange={(e) => updateTyped('llm', { ...data.llm, systemPrompt: e.target.value })}
                rows={2}
                className="w-full px-2 py-1.5 text-sm border border-surface-200 rounded-md focus:outline-none focus:border-primary-500 font-mono"
              />
            </Field>
          </>
        )}

        {node.type === 'webbridge' && (
          <>
            <Field label={t('visualWorkflow.propertyPanel.securityPreset')}>
              <select
                value={data.webbridge?.securityPreset || ''}
                onChange={(e) => updateTyped('webbridge', { ...data.webbridge, securityPreset: e.target.value })}
                className="w-full px-2 py-1.5 text-sm border border-surface-200 rounded-md focus:outline-none focus:border-primary-500"
              >
                <option value="">{t('visualWorkflow.propertyPanel.noPreset')}</option>
                {presets.map((p) => (
                  <option key={p} value={p}>{p}</option>
                ))}
              </select>
            </Field>
            <Field label={t('visualWorkflow.propertyPanel.webbridgeActions')}>
              <BrowserActionEditor
                actions={data.webbridge?.actions || []}
                onChange={(actions) => updateTyped('webbridge', { ...data.webbridge, actions })}
              />
            </Field>
            <Field label={t('visualWorkflow.propertyPanel.webbridgeWorkflowId')}>
              <select
                value={data.webbridge?.workflowId || ''}
                onChange={(e) => updateTyped('webbridge', { ...data.webbridge, workflowId: e.target.value || undefined })}
                className="w-full px-2 py-1.5 text-sm border border-surface-200 rounded-md focus:outline-none focus:border-primary-500"
              >
                <option value="">{t('visualWorkflow.propertyPanel.webbridgeWorkflowNone')}</option>
                {workflows.map((w) => (
                  <option key={w.id} value={w.id}>
                    {w.name} ({w.steps?.length || 0} {t('webbridge.workflowPanel.steps')})
                  </option>
                ))}
              </select>
            </Field>
            {selectedWorkflow && (
              <div className="space-y-2">
                <p className="text-xs text-surface-500">
                  {selectedWorkflow.description || t('webbridge.workflowPanel.noDescription')}
                </p>
                <button
                  onClick={() => {
                    const actions = selectedWorkflow.steps?.flatMap((s) => s.actions || []) || []
                    updateTyped('webbridge', { ...data.webbridge, actions, workflowId: undefined })
                  }}
                  className="text-xs px-2 py-1 bg-surface-100 hover:bg-surface-200 text-surface-700 rounded transition-colors"
                >
                  {t('visualWorkflow.propertyPanel.webbridgeInlineWorkflow')}
                </button>
              </div>
            )}
            <div className="flex items-center gap-2 pt-1">
              <input
                id="wb-screenshot-on-failure"
                type="checkbox"
                checked={data.webbridge?.screenshotOnFailure ?? true}
                onChange={(e) => updateTyped('webbridge', { ...data.webbridge, screenshotOnFailure: e.target.checked })}
                className="w-4 h-4 text-primary-600 rounded border-surface-300 focus:ring-primary-500"
              />
              <label htmlFor="wb-screenshot-on-failure" className="text-sm text-surface-700">
                {t('visualWorkflow.propertyPanel.webbridgeScreenshotOnFailure')}
              </label>
            </div>
            <Field label={t('visualWorkflow.propertyPanel.webbridgeRetryDelayMs')}>
              <input
                type="number"
                min={0}
                step={100}
                value={data.webbridge?.retryDelayMs || 0}
                onChange={(e) => updateTyped('webbridge', { ...data.webbridge, retryDelayMs: parseInt(e.target.value || '0', 10) })}
                className="w-full px-2 py-1.5 text-sm border border-surface-200 rounded-md focus:outline-none focus:border-primary-500"
              />
            </Field>
          </>
        )}

        {node.type === 'javascript' && (
          <Field label={t('visualWorkflow.propertyPanel.javascriptCode')}>
            <textarea
              value={data.javascript?.code || ''}
              onChange={(e) => updateTyped('javascript', { ...data.javascript, code: e.target.value })}
              rows={8}
              className="w-full px-2 py-1.5 text-xs border border-surface-200 rounded-md focus:outline-none focus:border-primary-500 font-mono"
            />
          </Field>
        )}

        {node.type === 'condition' && (
          <Field label={t('visualWorkflow.propertyPanel.conditionExpression')}>
            <ExpressionBuilder
              value={data.condition?.conditionExpression || ''}
              onChange={(v) => updateTyped('condition', { ...data.condition, conditionExpression: v })}
              workflow={workflow}
            />
            <textarea
              value={data.condition?.conditionExpression || ''}
              onChange={(e) => updateTyped('condition', { ...data.condition, conditionExpression: e.target.value })}
              placeholder="variables.foo > 0"
              rows={3}
              className="w-full mt-2 px-2 py-1.5 text-xs border border-surface-200 rounded-md focus:outline-none focus:border-primary-500 font-mono"
            />
            <div className="mt-1">
              <VariablePicker
                workflow={workflow}
                onSelect={(v) =>
                  updateTyped('condition', {
                    ...data.condition,
                    conditionExpression: (data.condition?.conditionExpression || '') + v,
                  })
                }
              />
            </div>
          </Field>
        )}

        {node.type === 'loop' && (
          <>
            <Field label={t('visualWorkflow.propertyPanel.loopVariable')}>
              <input
                type="text"
                value={data.loop?.loopVariable || 'item'}
                onChange={(e) => updateTyped('loop', { ...data.loop, loopVariable: e.target.value })}
                className="w-full px-2 py-1.5 text-sm border border-surface-200 rounded-md focus:outline-none focus:border-primary-500"
              />
            </Field>
            <Field label={t('visualWorkflow.propertyPanel.loopOver')}>
              <input
                type="text"
                value={data.loop?.loopOver || ''}
                onChange={(e) => updateTyped('loop', { ...data.loop, loopOver: e.target.value })}
                placeholder="inputs.items"
                className="w-full px-2 py-1.5 text-sm border border-surface-200 rounded-md focus:outline-none focus:border-primary-500"
              />
              <div className="mt-1">
                <VariablePicker
                  workflow={workflow}
                  onSelect={(v) =>
                    updateTyped('loop', {
                      ...data.loop,
                      loopOver: (data.loop?.loopOver || '') + v,
                    })
                  }
                />
              </div>
            </Field>
            <Field label={t('visualWorkflow.propertyPanel.maxIterations')}>
              <input
                type="number"
                min={1}
                max={1000}
                value={data.loop?.maxIterations ?? 100}
                onChange={(e) => updateTyped('loop', { ...data.loop, maxIterations: parseInt(e.target.value || '1', 10) })}
                className="w-full px-2 py-1.5 text-sm border border-surface-200 rounded-md focus:outline-none focus:border-primary-500"
              />
            </Field>
          </>
        )}

        {node.type === 'delay' && (
          <Field label={t('visualWorkflow.propertyPanel.delayMs')}>
            <input
              type="number"
              min={0}
              step={100}
              value={data.delay?.delayMs || 0}
              onChange={(e) => updateTyped('delay', { ...data.delay, delayMs: parseInt(e.target.value || '0', 10) })}
              className="w-full px-2 py-1.5 text-sm border border-surface-200 rounded-md focus:outline-none focus:border-primary-500"
            />
          </Field>
        )}

        {node.type === 'variable' && (
          <>
            <Field label={t('visualWorkflow.propertyPanel.variableName')}>
              <input
                type="text"
                value={data.variable?.variableName || ''}
                onChange={(e) => updateTyped('variable', { ...data.variable, variableName: e.target.value })}
                className="w-full px-2 py-1.5 text-sm border border-surface-200 rounded-md focus:outline-none focus:border-primary-500"
              />
            </Field>
            <Field label={t('visualWorkflow.propertyPanel.variableValue')}>
              <input
                type="text"
                value={data.variable?.variableValue || ''}
                onChange={(e) => updateTyped('variable', { ...data.variable, variableValue: e.target.value })}
                placeholder="${inputs.foo}"
                className="w-full px-2 py-1.5 text-sm border border-surface-200 rounded-md focus:outline-none focus:border-primary-500"
              />
              <div className="mt-1">
                <VariablePicker
                  workflow={workflow}
                  onSelect={(v) =>
                    updateTyped('variable', {
                      ...data.variable,
                      variableValue: (data.variable?.variableValue || '') + v,
                    })
                  }
                />
              </div>
            </Field>
          </>
        )}

        {node.type === 'agent_swarm' && (
          <Field label={t('visualWorkflow.propertyPanel.taskDescription')}>
            <textarea
              value={data.agentSwarm?.taskDescription || ''}
              onChange={(e) => updateTyped('agentSwarm', { ...data.agentSwarm, taskDescription: e.target.value })}
              rows={3}
              className="w-full px-2 py-1.5 text-sm border border-surface-200 rounded-md focus:outline-none focus:border-primary-500"
            />
          </Field>
        )}

        {node.type === 'http_request' && (
          <>
            <Field label={t('visualWorkflow.propertyPanel.httpUrl')}>
              <input
                type="text"
                value={data.httpRequest?.url || ''}
                onChange={(e) => updateTyped('httpRequest', { ...data.httpRequest, url: e.target.value })}
                placeholder="https://api.example.com/data"
                className="w-full px-2 py-1.5 text-sm border border-surface-200 rounded-md focus:outline-none focus:border-primary-500"
              />
            </Field>
            <Field label={t('visualWorkflow.propertyPanel.httpMethod')}>
              <select
                value={data.httpRequest?.method || 'GET'}
                onChange={(e) => updateTyped('httpRequest', { ...data.httpRequest, method: e.target.value as HttpRequestNodeConfig['method'] })}
                className="w-full px-2 py-1.5 text-sm border border-surface-200 rounded-md focus:outline-none focus:border-primary-500"
              >
                <option value="GET">GET</option>
                <option value="POST">POST</option>
                <option value="PUT">PUT</option>
                <option value="DELETE">DELETE</option>
                <option value="PATCH">PATCH</option>
              </select>
            </Field>
            <Field label={t('visualWorkflow.propertyPanel.httpHeaders')}>
              <KeyValueEditor
                value={data.httpRequest?.headers || '{}'}
                onChange={(v) => updateTyped('httpRequest', { ...data.httpRequest, headers: v })}
                placeholder={{ key: 'Header', value: 'Value or ${variables.token}' }}
                variablePicker={
                  <VariablePicker
                    workflow={workflow}
                    onSelect={(v) => {
                      const current = data.httpRequest?.headers || '{}'
                      try {
                        const parsed = JSON.parse(current)
                        const entries = Object.entries(parsed)
                        const lastKey = entries.length > 0 ? String(entries[entries.length - 1][0]) : 'Authorization'
                        parsed[lastKey] = String(parsed[lastKey] || '') + v
                        updateTyped('httpRequest', { ...data.httpRequest, headers: JSON.stringify(parsed, null, 2) })
                      } catch {
                        updateTyped('httpRequest', { ...data.httpRequest, headers: `{"Authorization": "${v}"}` })
                      }
                    }}
                  />
                }
              />
            </Field>
            <Field label={t('visualWorkflow.propertyPanel.httpBody')}>
              <textarea
                value={data.httpRequest?.body || ''}
                onChange={(e) => updateTyped('httpRequest', { ...data.httpRequest, body: e.target.value })}
                rows={4}
                className="w-full px-2 py-1.5 text-xs border border-surface-200 rounded-md focus:outline-none focus:border-primary-500 font-mono"
              />
              <div className="mt-1">
                <VariablePicker
                  workflow={workflow}
                  onSelect={(v) =>
                    updateTyped('httpRequest', {
                      ...data.httpRequest,
                      body: (data.httpRequest?.body || '') + v,
                    })
                  }
                />
              </div>
            </Field>
            <Field label={t('visualWorkflow.propertyPanel.httpTimeout')}>
              <input
                type="number"
                min={1000}
                step={1000}
                value={data.httpRequest?.timeout ?? 30000}
                onChange={(e) => updateTyped('httpRequest', { ...data.httpRequest, timeout: parseInt(e.target.value || '30000', 10) })}
                className="w-full px-2 py-1.5 text-sm border border-surface-200 rounded-md focus:outline-none focus:border-primary-500"
              />
            </Field>
          </>
        )}

        {node.type === 'database_query' && (
          <>
            <Field label={t('visualWorkflow.propertyPanel.databaseConnection')}>
              <input
                type="text"
                value={data.databaseQuery?.connection || ''}
                onChange={(e) => updateTyped('databaseQuery', { ...data.databaseQuery, connection: e.target.value })}
                placeholder="默认连接"
                className="w-full px-2 py-1.5 text-sm border border-surface-200 rounded-md focus:outline-none focus:border-primary-500"
              />
            </Field>
            <Field label={t('visualWorkflow.propertyPanel.databaseQuery')}>
              <textarea
                value={data.databaseQuery?.query || ''}
                onChange={(e) => updateTyped('databaseQuery', { ...data.databaseQuery, query: e.target.value })}
                rows={5}
                placeholder="SELECT * FROM Orders WHERE FactoryId = @factoryId"
                className="w-full px-2 py-1.5 text-xs border border-surface-200 rounded-md focus:outline-none focus:border-primary-500 font-mono"
              />
              <div className="mt-1">
                <VariablePicker
                  workflow={workflow}
                  onSelect={(v) =>
                    updateTyped('databaseQuery', {
                      ...data.databaseQuery,
                      query: (data.databaseQuery?.query || '') + v,
                    })
                  }
                />
              </div>
            </Field>
            <Field label={t('visualWorkflow.propertyPanel.databaseParameters')}>
              <KeyValueEditor
                value={data.databaseQuery?.parameters || '{}'}
                onChange={(v) => updateTyped('databaseQuery', { ...data.databaseQuery, parameters: v })}
                placeholder={{ key: '参数名', value: '参数值或 ${inputs.factoryId}' }}
                variablePicker={
                  <VariablePicker
                    workflow={workflow}
                    onSelect={(v) => {
                      const current = data.databaseQuery?.parameters || '{}'
                      try {
                        const parsed = JSON.parse(current)
                        const entries = Object.entries(parsed)
                        const lastKey = entries.length > 0 ? String(entries[entries.length - 1][0]) : 'param'
                        parsed[lastKey] = String(parsed[lastKey] || '') + v
                        updateTyped('databaseQuery', { ...data.databaseQuery, parameters: JSON.stringify(parsed, null, 2) })
                      } catch {
                        updateTyped('databaseQuery', { ...data.databaseQuery, parameters: `{"param": "${v}"}` })
                      }
                    }}
                  />
                }
              />
            </Field>
          </>
        )}

        {node.type === 'file_operation' && (
          <>
            <Field label={t('visualWorkflow.propertyPanel.fileAction')}>
              <select
                value={data.fileOperation?.action || 'read'}
                onChange={(e) => updateTyped('fileOperation', { ...data.fileOperation, action: e.target.value as FileOperationAction })}
                className="w-full px-2 py-1.5 text-sm border border-surface-200 rounded-md focus:outline-none focus:border-primary-500"
              >
                <option value="read">从工作区读取文件</option>
                <option value="write">写入文件到工作区</option>
                <option value="upload">上传工作区文件为附件</option>
                <option value="download">下载 Data URL 到工作区</option>
              </select>
            </Field>
            <Field label={t('visualWorkflow.propertyPanel.filePath')}>
              <input
                type="text"
                value={data.fileOperation?.path || ''}
                onChange={(e) => updateTyped('fileOperation', { ...data.fileOperation, path: e.target.value })}
                placeholder="workspace 相对路径，如 downloads/report.txt"
                className="w-full px-2 py-1.5 text-sm border border-surface-200 rounded-md focus:outline-none focus:border-primary-500"
              />
              <div className="mt-1">
                <VariablePicker
                  workflow={workflow}
                  onSelect={(v) =>
                    updateTyped('fileOperation', {
                      ...data.fileOperation,
                      path: (data.fileOperation?.path || '') + v,
                    })
                  }
                />
              </div>
            </Field>
            {(data.fileOperation?.action === 'write' || data.fileOperation?.action === 'upload') && (
              <Field label={t('visualWorkflow.propertyPanel.fileContent')}>
                <textarea
                  value={data.fileOperation?.content || ''}
                  onChange={(e) => updateTyped('fileOperation', { ...data.fileOperation, content: e.target.value })}
                  rows={5}
                  placeholder="${nodeOutputs.previous_node.content}"
                  className="w-full px-2 py-1.5 text-xs border border-surface-200 rounded-md focus:outline-none focus:border-primary-500 font-mono"
                />
                <div className="mt-1">
                  <VariablePicker
                    workflow={workflow}
                    onSelect={(v) =>
                      updateTyped('fileOperation', {
                        ...data.fileOperation,
                        content: (data.fileOperation?.content || '') + v,
                      })
                    }
                  />
                </div>
              </Field>
            )}
            {data.fileOperation?.action === 'download' && (
              <Field label={t('visualWorkflow.propertyPanel.fileDataUrl')}>
                <input
                  type="text"
                  value={data.fileOperation?.dataUrl || ''}
                  onChange={(e) => updateTyped('fileOperation', { ...data.fileOperation, dataUrl: e.target.value })}
                  placeholder="data:application/octet-stream;base64,..."
                  className="w-full px-2 py-1.5 text-sm border border-surface-200 rounded-md focus:outline-none focus:border-primary-500"
                />
              </Field>
            )}
          </>
        )}

        {node.type === 'send_message' && (
          <>
            <Field label={t('visualWorkflow.propertyPanel.sendMessageChannel')}>
              <select
                value={data.sendMessage?.channel || 'log'}
                onChange={(e) => updateTyped('sendMessage', { ...data.sendMessage, channel: e.target.value as SendMessageChannel })}
                className="w-full px-2 py-1.5 text-sm border border-surface-200 rounded-md focus:outline-none focus:border-primary-500"
              >
                <option value="log">执行日志</option>
                <option value="notification">系统通知</option>
                <option value="toast">Toast 提示</option>
              </select>
            </Field>
            <Field label={t('visualWorkflow.propertyPanel.sendMessageTitle')}>
              <input
                type="text"
                value={data.sendMessage?.title || ''}
                onChange={(e) => updateTyped('sendMessage', { ...data.sendMessage, title: e.target.value })}
                className="w-full px-2 py-1.5 text-sm border border-surface-200 rounded-md focus:outline-none focus:border-primary-500"
              />
            </Field>
            <Field label={t('visualWorkflow.propertyPanel.sendMessageContent')}>
              <textarea
                value={data.sendMessage?.content || ''}
                onChange={(e) => updateTyped('sendMessage', { ...data.sendMessage, content: e.target.value })}
                rows={4}
                placeholder="工作流执行结果：${nodeOutputs.previous_node.content}"
                className="w-full px-2 py-1.5 text-sm border border-surface-200 rounded-md focus:outline-none focus:border-primary-500"
              />
              <div className="mt-1">
                <VariablePicker
                  workflow={workflow}
                  onSelect={(v) =>
                    updateTyped('sendMessage', {
                      ...data.sendMessage,
                      content: (data.sendMessage?.content || '') + v,
                    })
                  }
                />
              </div>
            </Field>
          </>
        )}
        {node.type === 'tool' && (
          <>
            <Field label={t('visualWorkflow.propertyPanel.toolName')}>
              <select
                value={data.tool?.toolName || ''}
                onChange={(e) => updateTyped('tool', { ...data.tool, toolName: e.target.value })}
                className="w-full px-2 py-1.5 text-sm border border-surface-200 rounded-md focus:outline-none focus:border-primary-500"
              >
                <option value="">{t('visualWorkflow.propertyPanel.selectTool')}</option>
                {COMMON_TOOLS.map((t) => (
                  <option key={t} value={t}>{t}</option>
                ))}
              </select>
            </Field>
            <Field label={t('visualWorkflow.propertyPanel.toolArgs')}>
              <KeyValueEditor
                value={data.tool?.args || '{}'}
                onChange={(v) => updateTyped('tool', { ...data.tool, args: v })}
                placeholder={{ key: '参数名', value: '参数值或 ${inputs.xxx}' }}
                variablePicker={
                  <VariablePicker
                    workflow={workflow}
                    onSelect={(v) => {
                      const current = data.tool?.args || '{}'
                      try {
                        const parsed = JSON.parse(current)
                        const entries = Object.entries(parsed)
                        const lastKey = entries.length > 0 ? String(entries[entries.length - 1][0]) : 'param'
                        parsed[lastKey] = String(parsed[lastKey] || '') + v
                        updateTyped('tool', { ...data.tool, args: JSON.stringify(parsed, null, 2) })
                      } catch {
                        updateTyped('tool', { ...data.tool, args: `{"param": "${v}"}` })
                      }
                    }}
                  />
                }
              />
            </Field>
          </>
        )}

        {node.type === 'sub_workflow' && (
          <>
            <Field label="子工作流">
              <select
                value={data.subWorkflow?.workflowId || ''}
                onChange={(e) => updateTyped('subWorkflow', { ...data.subWorkflow, workflowId: e.target.value })}
                className="w-full px-2 py-1.5 text-sm border border-surface-200 rounded-md focus:outline-none focus:border-primary-500"
              >
                <option value="">选择工作流</option>
                {dagWorkflows.map((w) => (
                  <option key={w.id} value={w.id}>{w.name}</option>
                ))}
              </select>
            </Field>
            <Field label="输入参数 (JSON)">
              <KeyValueEditor
                value={data.subWorkflow?.inputs || '{}'}
                onChange={(v) => updateTyped('subWorkflow', { ...data.subWorkflow, inputs: v })}
                placeholder={{ key: '参数名', value: '参数值或 ${inputs.xxx}' }}
                variablePicker={
                  <VariablePicker
                    workflow={workflow}
                    onSelect={(v) => {
                      const current = data.subWorkflow?.inputs || '{}'
                      try {
                        const parsed = JSON.parse(current)
                        const entries = Object.entries(parsed)
                        const lastKey = entries.length > 0 ? String(entries[entries.length - 1][0]) : 'param'
                        parsed[lastKey] = String(parsed[lastKey] || '') + v
                        updateTyped('subWorkflow', { ...data.subWorkflow, inputs: JSON.stringify(parsed, null, 2) })
                      } catch {
                        updateTyped('subWorkflow', { ...data.subWorkflow, inputs: `{"param": "${v}"}` })
                      }
                    }}
                  />
                }
              />
            </Field>
          </>
        )}

      </div>
    </div>
  )
}
