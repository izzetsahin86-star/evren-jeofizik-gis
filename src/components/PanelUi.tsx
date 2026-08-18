import type { ReactNode } from 'react'

export function Card({ title, subtitle, icon, tone = 'blue', children, className = '' }: { title: string; subtitle?: string; icon?: ReactNode; tone?: 'blue' | 'purple' | 'amber' | 'green'; children: ReactNode; className?: string }) {
  return (
    <section className={`panel-card ${className}`}>
      <header className="panel-card-header">
        {icon && <span className={`card-icon tone-${tone}`}>{icon}</span>}
        <span><h2>{title}</h2>{subtitle && <p>{subtitle}</p>}</span>
      </header>
      <div className="panel-card-body">{children}</div>
    </section>
  )
}

export function Segmented<T extends string>({ value, options, onChange, ariaLabel }: { value: T; options: Array<{ value: T; label: string }>; onChange: (value: T) => void; ariaLabel: string }) {
  return (
    <div className="segmented" role="group" aria-label={ariaLabel}>
      {options.map((option) => (
        <button key={option.value} type="button" className={option.value === value ? 'is-active' : ''} onClick={() => onChange(option.value)}>{option.label}</button>
      ))}
    </div>
  )
}

export function EmptyState({ children }: { children: ReactNode }) {
  return <div className="empty-state">{children}</div>
}

export function Field({ label, children }: { label: string; children: ReactNode }) {
  return <label className="form-field"><span>{label}</span>{children}</label>
}
