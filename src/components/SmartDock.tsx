import { useEffect, useRef, useState } from 'react'
import { Box } from 'lucide-react'
import { MoreDockIcon, primaryDockItems, secondaryDockItems, type DockPanelId } from '../dock'

interface SmartDockProps {
  activePanel: DockPanelId | null
  onSelect: (panel: DockPanelId) => void
}

const secondaryIds = new Set<DockPanelId>(secondaryDockItems.map((item) => item.id))
const liveItem = primaryDockItems[2]
const LiveIcon = liveItem.icon

export default function SmartDock({ activePanel, onSelect }: SmartDockProps) {
  const [moreOpen, setMoreOpen] = useState(false)
  const zoneRef = useRef<HTMLDivElement | null>(null)
  const secondaryActive = activePanel ? secondaryIds.has(activePanel) : false

  useEffect(() => {
    if (secondaryActive) setMoreOpen(false)
  }, [secondaryActive])

  useEffect(() => {
    if (!moreOpen) return
    const close = (event: PointerEvent) => {
      if (!zoneRef.current?.contains(event.target as Node)) setMoreOpen(false)
    }
    document.addEventListener('pointerdown', close)
    return () => document.removeEventListener('pointerdown', close)
  }, [moreOpen])

  useEffect(() => {
    const close = () => setMoreOpen(false)
    window.addEventListener('evren-smart-more-close', close)
    return () => window.removeEventListener('evren-smart-more-close', close)
  }, [])

  const select = (panel: DockPanelId) => {
    setMoreOpen(false)
    onSelect(panel)
  }

  const openUndergroundModel = () => {
    setMoreOpen(false)
    window.dispatchEvent(new CustomEvent('evren-open-underground-model'))
  }

  return (
    <div className="smart-dock-zone" ref={zoneRef}>
      {moreOpen ? (
        <section className="smart-dock-menu" aria-label="Diğer araçlar">
          <header><strong>Diğer Araçlar</strong><small>Aktarım ve çalışma ayarları</small></header>
          <div className="smart-dock-menu-grid">
            {secondaryDockItems.map((item) => {
              const Icon = item.icon
              return (
                <button key={item.id} data-panel-id={item.id} type="button" className={activePanel === item.id ? 'is-active' : ''} onClick={() => select(item.id)}>
                  <span><Icon size={20} strokeWidth={1.9} /></span>
                  <strong>{item.label}</strong>
                </button>
              )
            })}
            <button type="button" data-feature-id="underground-model" onClick={openUndergroundModel}>
              <span><Box size={20} strokeWidth={1.9} /></span>
              <strong>3B Model</strong>
            </button>
          </div>
        </section>
      ) : null}

      <nav className="smart-dock" aria-label="Ana çalışma araçları">
        {primaryDockItems.slice(0, 2).map((item) => {
          const Icon = item.icon
          return <button key={item.id} data-panel-id={item.id} type="button" className={activePanel === item.id ? 'is-active' : ''} onClick={() => select(item.id)}><span className="smart-dock-icon"><Icon size={22} strokeWidth={1.9} /></span><small>{item.label}</small></button>
        })}

        <button data-panel-id={liveItem.id} type="button" className={`smart-live-action${activePanel === liveItem.id ? ' is-active' : ''}`} onClick={() => select(liveItem.id)}><span className="smart-live-icon"><LiveIcon size={25} strokeWidth={2} /></span><small>{liveItem.label}</small></button>

        {primaryDockItems.slice(3).map((item) => {
          const Icon = item.icon
          return <button key={item.id} data-panel-id={item.id} type="button" className={activePanel === item.id ? 'is-active' : ''} onClick={() => select(item.id)}><span className="smart-dock-icon"><Icon size={22} strokeWidth={1.9} /></span><small>{item.label}</small></button>
        })}

        <button type="button" className={moreOpen || secondaryActive ? 'is-active' : ''} onClick={() => setMoreOpen((value) => !value)} aria-expanded={moreOpen} aria-label="Diğer araçlar"><span className="smart-dock-icon"><MoreDockIcon size={23} strokeWidth={2} /></span><small>Diğer</small></button>
      </nav>
    </div>
  )
}
