import { useEffect, useState, type FormEvent } from 'react'
import { Plus } from 'lucide-react'
import {
  capabilityManagementApi,
  type MemoryDraft,
  type MemorySummary,
  type MemoryView,
} from '@/api/irisApi'
import { Badge, Button, Input, notify } from '@/components/ui'
import { EditorHeading, EnableSwitch, QuietState, TextArea } from './controls'

const emptyMemory: MemoryDraft = {
  title: '',
  content: '',
  scope: 'personal',
  sourceKind: 'user_stated',
  sourceRef: '',
  confidence: 1,
  enabled: true,
}

/**
 * 记忆控制台（DB 真相）：统一能力页的子视图。记忆不是能力树上的对象
 * （docs/32 §1 的六种 kind 不含它），但写路径沿用现有控制器（§4）。
 */
export function MemoryConsole({ onBack }: { onBack: () => void }) {
  const [memories, setMemories] = useState<MemorySummary[]>([])
  const [loading, setLoading] = useState(true)
  const [busyId, setBusyId] = useState<string | null>(null)
  const [editing, setEditing] = useState<MemoryView | undefined | null>(null)

  useEffect(() => {
    let cancelled = false
    setLoading(true)
    capabilityManagementApi
      .listMemories()
      .then((next) => !cancelled && setMemories(next))
      .catch((error: Error) =>
        notify.error('记忆暂时不可用', { description: error.message }),
      )
      .finally(() => !cancelled && setLoading(false))
    return () => {
      cancelled = true
    }
  }, [])

  const toggleMemory = async (memory: MemorySummary) => {
    setBusyId(memory.memoryId)
    setMemories((items) =>
      items.map((item) =>
        item.memoryId === memory.memoryId
          ? { ...item, enabled: !memory.enabled }
          : item,
      ),
    )
    try {
      const updated = await capabilityManagementApi.setMemoryEnabled(
        memory,
        !memory.enabled,
      )
      setMemories((items) => replaceBy(items, memorySummary(updated)))
    } catch (error) {
      setMemories((items) => replaceBy(items, memory))
      notify.error('没有改变记忆状态', {
        description: (error as Error).message,
      })
    } finally {
      setBusyId(null)
    }
  }

  const editMemory = async (memory: MemorySummary) => {
    setBusyId(memory.memoryId)
    try {
      setEditing(await capabilityManagementApi.readMemory(memory.memoryId))
    } catch (error) {
      notify.error('没有读到记忆正文', {
        description: (error as Error).message,
      })
    } finally {
      setBusyId(null)
    }
  }

  if (editing !== null) {
    return (
      <MemoryEditor
        current={editing}
        onCancel={() => setEditing(null)}
        onSaved={(memory) => {
          setMemories((items) =>
            items.some((item) => item.memoryId === memory.memoryId)
              ? replaceBy(items, memorySummary(memory))
              : [...items, memorySummary(memory)],
          )
          setEditing(null)
        }}
      />
    )
  }

  return (
    <section className="grid gap-3">
      <EditorHeading title="记忆" onCancel={onBack} backLabel="返回能力树" />
      <div className="flex items-start justify-between gap-5 px-1">
        <p className="text-small leading-relaxed text-ink-muted">
          启用的记忆才参与语义召回；模型先看到候选摘要，确有需要时再读取精确正文。
        </p>
        <Button variant="secondary" size="sm" onClick={() => setEditing(undefined)}>
          <Plus className="h-3.5 w-3.5" />
          添加记忆
        </Button>
      </div>
      {loading ? (
        <QuietState>正在读取记忆…</QuietState>
      ) : memories.length === 0 ? (
        <QuietState>还没有长期记忆。普通对话不会自动沉淀为事实。</QuietState>
      ) : (
        memories.map((memory) => (
          <article
            key={memory.memoryId}
            className="grid grid-cols-[minmax(0,1fr)_auto] gap-4 rounded-md px-3 py-3 transition-colors hover:bg-surface-muted"
          >
            <button
              type="button"
              className="min-w-0 text-left"
              disabled={busyId === memory.memoryId}
              onClick={() => void editMemory(memory)}
            >
              <div className="flex items-center gap-2">
                <span className="truncate text-body font-semibold text-ink">
                  {memory.title}
                </span>
                <Badge appearance="outline">{memory.scope}</Badge>
                <span className="text-caption text-ink-muted">
                  {Math.round(memory.confidence * 100)}%
                </span>
              </div>
              <p className="mt-1 line-clamp-2 text-small leading-relaxed text-ink-subtle">
                {memory.preview}
              </p>
              <p className="mt-1 text-caption text-ink-muted">
                来源：{memory.sourceKind}
              </p>
            </button>
            <EnableSwitch
              checked={memory.enabled}
              disabled={busyId === memory.memoryId}
              label={`${memory.enabled ? '忘记' : '恢复'} ${memory.title}`}
              onClick={() => void toggleMemory(memory)}
            />
          </article>
        ))
      )}
    </section>
  )
}

function MemoryEditor({
  current,
  onCancel,
  onSaved,
}: {
  current?: MemoryView
  onCancel: () => void
  onSaved: (memory: MemoryView) => void
}) {
  const [draft, setDraft] = useState<MemoryDraft>(
    current
      ? {
          title: current.title,
          content: current.content,
          scope: current.scope,
          sourceKind: current.sourceKind,
          sourceRef: current.sourceRef ?? '',
          confidence: current.confidence,
          enabled: current.enabled,
        }
      : emptyMemory,
  )
  const [saving, setSaving] = useState(false)

  const submit = async (event: FormEvent) => {
    event.preventDefault()
    setSaving(true)
    try {
      const saved = current
        ? await capabilityManagementApi.updateMemory(
            memorySummary(current),
            draft,
          )
        : await capabilityManagementApi.createMemory(draft)
      onSaved(saved)
    } catch (error) {
      notify.error('记忆没有保存', { description: (error as Error).message })
    } finally {
      setSaving(false)
    }
  }

  return (
    <form className="grid gap-4" onSubmit={submit}>
      <EditorHeading title={current ? '编辑记忆' : '添加记忆'} onCancel={onCancel} backLabel="返回记忆" />
      <Input label="事实标题" required value={draft.title} onChange={(event) => setDraft({ ...draft, title: event.target.value })} placeholder="偏好的周报格式" />
      <TextArea label="事实正文" value={draft.content} onChange={(value) => setDraft({ ...draft, content: value })} rows={7} description="只写可在未来复用的稳定事实；不要把一次任务的中间状态写进来。" />
      <div className="grid gap-4 sm:grid-cols-2">
        <Input label="作用域" required value={draft.scope} onChange={(event) => setDraft({ ...draft, scope: event.target.value })} />
        <Input label="置信度" required type="number" min={0} max={1} step={0.05} value={draft.confidence} onChange={(event) => setDraft({ ...draft, confidence: Number(event.target.value) })} />
      </div>
      <Input label="来源引用" value={draft.sourceRef} onChange={(event) => setDraft({ ...draft, sourceRef: event.target.value })} description={`来源类型：${draft.sourceKind}。引用可留空，但不能伪造出处。`} />
      <div className="flex justify-end gap-2">
        <Button variant="ghost" onClick={onCancel}>取消</Button>
        <Button type="submit" isLoading={saving} loadingLabel="正在保存">保存记忆</Button>
      </div>
    </form>
  )
}

function replaceBy(items: MemorySummary[], value: MemorySummary) {
  return items.map((item) => (item.memoryId === value.memoryId ? value : item))
}

function memorySummary(memory: MemoryView): MemorySummary {
  return {
    memoryId: memory.memoryId,
    definitionVersion: memory.definitionVersion,
    headVersion: memory.headVersion,
    title: memory.title,
    preview: memory.content.length > 320
      ? `${memory.content.slice(0, 320)}…`
      : memory.content,
    scope: memory.scope,
    sourceKind: memory.sourceKind,
    sourceRef: memory.sourceRef,
    confidence: memory.confidence,
    enabled: memory.enabled,
    lifecycleStatus: memory.lifecycleStatus,
    updatedAt: memory.updatedAt,
  }
}
