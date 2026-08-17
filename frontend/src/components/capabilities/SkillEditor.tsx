import { useState, type FormEvent } from 'react'
import {
  capabilityManagementApi,
  type SkillDraft,
  type SkillView,
} from '@/api/irisApi'
import { Button, Input, notify } from '@/components/ui'
import { EditorHeading, TextArea } from './controls'

const emptySkill: SkillDraft = {
  name: '',
  title: '',
  capabilityPath: '',
  description: '',
  whenToUse: '',
  instructions: '',
  dependencies: [],
  enabled: true,
}

/** 内核技能库（DB 真相）编辑器：统一能力页的详情内编辑（docs/32 §1）。 */
export function SkillEditor({
  current,
  onCancel,
  onSaved,
}: {
  current?: SkillView
  onCancel: () => void
  onSaved: (skill: SkillView) => void
}) {
  const [draft, setDraft] = useState<SkillDraft>(
    current
      ? {
          name: current.name,
          title: current.title,
          capabilityPath: current.capabilityPath,
          description: current.description,
          whenToUse: current.whenToUse,
          instructions: current.instructions,
          dependencies: current.dependencies,
          enabled: current.enabled,
        }
      : emptySkill,
  )
  const [saving, setSaving] = useState(false)

  const submit = async (event: FormEvent) => {
    event.preventDefault()
    setSaving(true)
    try {
      const saved = current
        ? await capabilityManagementApi.updateSkill(current, draft)
        : await capabilityManagementApi.createSkill(draft)
      onSaved(saved)
    } catch (error) {
      notify.error('Skill 没有保存', { description: (error as Error).message })
    } finally {
      setSaving(false)
    }
  }

  return (
    <form className="grid gap-4" onSubmit={submit}>
      <EditorHeading
        title={current ? '编辑 Skill' : '新建 Skill'}
        onCancel={onCancel}
      />
      <div className="grid gap-4 sm:grid-cols-2">
        <Input label="名称" required value={draft.name} disabled={Boolean(current)} onChange={(event) => setDraft({ ...draft, name: event.target.value })} placeholder="weekly_report" />
        <Input label="标题" required value={draft.title} onChange={(event) => setDraft({ ...draft, title: event.target.value })} placeholder="整理周报" />
      </div>
      <Input label="能力路径" value={draft.capabilityPath} onChange={(event) => setDraft({ ...draft, capabilityPath: event.target.value })} description="留空时进入 /skills/personal；路径末段必须与名称一致。" placeholder="/skills/personal/weekly_report" />
      <TextArea label="一句话描述" value={draft.description} onChange={(value) => setDraft({ ...draft, description: value })} rows={2} />
      <TextArea label="何时使用" value={draft.whenToUse} onChange={(value) => setDraft({ ...draft, whenToUse: value })} rows={3} description="这是召回判断的主要依据，请写任务特征，不要写泛化口号。" />
      <TextArea label="工艺正文" value={draft.instructions} onChange={(value) => setDraft({ ...draft, instructions: value })} rows={10} />
      <Input label="依赖能力路径" value={draft.dependencies.join(', ')} onChange={(event) => setDraft({ ...draft, dependencies: event.target.value.split(',').map((item) => item.trim()).filter(Boolean) })} description="可选；多个绝对能力路径用逗号分隔。" />
      <div className="flex justify-end gap-2">
        <Button variant="ghost" onClick={onCancel}>取消</Button>
        <Button type="submit" isLoading={saving} loadingLabel="正在保存">保存 Skill</Button>
      </div>
    </form>
  )
}
