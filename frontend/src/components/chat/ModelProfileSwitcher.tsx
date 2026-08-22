import { useEffect, useState } from 'react'
import { Cpu } from 'lucide-react'
import {
  getModelProfiles,
  setActiveModelProfile,
  type ModelProfilesView,
} from '@/api/irisApi'
import { notify } from '@/components/ui'

/**
 * 顶栏模型 profile 切换（docs/21 §7.1）。样式对齐分支切换 select；
 * 切换是低频管理操作，成功后直接以后端返回的目录刷新显示。
 */
export function ModelProfileSwitcher() {
  const [view, setView] = useState<ModelProfilesView | null>(null)
  const [switching, setSwitching] = useState(false)

  useEffect(() => {
    let cancelled = false
    getModelProfiles()
      .then((loaded) => {
        if (!cancelled) setView(loaded)
      })
      .catch(() => {
        // 后端未就绪或老版本无此端点时静默隐藏，不打扰对话
      })
    return () => {
      cancelled = true
    }
  }, [])

  if (!view || view.profiles.length === 0) {
    return null
  }

  return (
    <label className="relative hidden items-center sm:flex">
      <Cpu
        aria-hidden="true"
        className="pointer-events-none absolute left-2 h-3.5 w-3.5 text-ink-muted"
      />
      <span className="sr-only">切换模型</span>
      <select
        className="h-8 max-w-40 rounded-sm border border-border bg-surface-raised py-0 pl-7 pr-7 text-small text-ink shadow-hairline outline-none focus:border-border-strong focus:shadow-focus disabled:opacity-60"
        value={view.active}
        disabled={switching}
        onChange={async (event) => {
          const next = event.target.value
          if (next === view.active) return
          setSwitching(true)
          try {
            setView(await setActiveModelProfile(next))
            notify.info('已切换模型', { description: next })
          } catch (error) {
            setView({ ...view })
            notify.error('暂时无法切换模型', {
              description: (error as Error).message,
            })
          } finally {
            setSwitching(false)
          }
        }}
      >
        {view.profiles.map((profile) => (
          <option key={profile.id} value={profile.id}>
            {profile.id}
          </option>
        ))}
      </select>
    </label>
  )
}
