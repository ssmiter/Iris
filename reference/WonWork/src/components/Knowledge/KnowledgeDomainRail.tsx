import { Cloud, Database, Layers3, LockKeyhole } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import type { KnowledgeCapabilities, KnowledgeDomain } from '@/types/knowledge'

export function KnowledgeDomainRail({
  value,
  capabilities,
  onChange,
}: {
  value: KnowledgeDomain
  capabilities: KnowledgeCapabilities
  onChange: (domain: KnowledgeDomain) => void
}) {
  const { t } = useTranslation()
  const options: Array<{ id: KnowledgeDomain; label: string; detail: string; icon: typeof Database }> = [
    { id: 'local', label: t('knowledge.domain.localLabel'), detail: t('knowledge.domain.localDetail'), icon: Database },
    { id: 'online', label: t('knowledge.domain.onlineLabel'), detail: t('knowledge.domain.onlineDetail'), icon: Cloud },
    { id: 'both', label: t('knowledge.domain.bothLabel'), detail: t('knowledge.domain.bothDetail'), icon: Layers3 },
  ]

  return (
    <div className="ww-kb-domain-rail" role="radiogroup" aria-label={t('knowledge.domain.groupAriaLabel')}>
      {options.map(({ id, label, detail, icon: Icon }) => {
        const requiresOnline = id !== 'local'
        const disabled = requiresOnline && !capabilities.onlineAvailable
        return (
          <button
            type="button"
            role="radio"
            aria-checked={value === id}
            key={id}
            disabled={disabled}
            className={value === id ? 'is-active' : ''}
            onClick={() => onChange(id)}
            title={disabled ? t('knowledge.domain.disabledTitle') : `${label} · ${detail}`}
          >
            <span className="ww-kb-domain-icon"><Icon size={17} /></span>
            <span><b>{label}</b><small>{detail}</small></span>
            {disabled && <LockKeyhole className="ww-kb-domain-lock" size={11} />}
          </button>
        )
      })}
    </div>
  )
}
