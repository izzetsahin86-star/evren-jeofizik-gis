import { useEffect, useRef, useState } from 'react'
import { EllipsisVertical, Expand, Move, Redo2, Trash2, Undo2, X } from 'lucide-react'

interface SmartHeaderProps {
  showStats: boolean
  polygonCount: number
  pointCount: number
  areaLabel: string | null
  activeName: string
  activeColor: string
  activePointCount: number
  isOnline: boolean
  performanceActive: boolean
  canUndo: boolean
  canRedo: boolean
  onUndo: () => void
  onRedo: () => void
  onReset: () => void
  onFit: () => void
  onClearActive: () => void
}

export default function SmartHeader({
  showStats,
  polygonCount,
  pointCount,
  areaLabel,
  activeName,
  activeColor,
  activePointCount,
  isOnline,
  performanceActive,
  canUndo,
  canRedo,
  onUndo,
  onRedo,
  onReset,
  onFit,
  onClearActive,
}: SmartHeaderProps) {
  const [menuOpen, setMenuOpen] = useState(false)
  const menuRef = useRef<HTMLDivElement | null>(null)

  useEffect(() => {
    if (!menuOpen) return
    const close = (event: PointerEvent) => {
      if (!menuRef.current?.contains(event.target as Node)) setMenuOpen(false)
    }
    document.addEventListener('pointerdown', close)
    return () => document.removeEventListener('pointerdown', close)
  }, [menuOpen])

  return (
    <header className="smart-header">
      <div className="smart-header-main">
        <div className="smart-brand">
          <img src="/icons/evren-jeofizik-logo.svg" alt="Evren Jeofizik logosu" />
          <span><strong>Evren Jeofizik</strong><small>Mobil GIS</small></span>
        </div>

        <div className="smart-header-actions">
          <button type="button" className="smart-header-action tone-cyan" onClick={onUndo} disabled={!canUndo} aria-label="Geri al"><Undo2 size={19} /></button>
          <button type="button" className="smart-header-action tone-violet" onClick={onRedo} disabled={!canRedo} aria-label="Yinele"><Redo2 size={19} /></button>
          <div className="smart-header-menu-wrap" ref={menuRef}>
            <button type="button" className={`smart-header-action tone-amber${menuOpen ? ' is-active' : ''}`} onClick={() => setMenuOpen((value) => !value)} aria-label="Çalışma seçenekleri" aria-expanded={menuOpen}>{menuOpen ? <X size={19} /> : <EllipsisVertical size={20} />}</button>
            {menuOpen ? (
              <div className="smart-header-menu">
                <button type="button" onClick={() => { onFit(); setMenuOpen(false) }}><Expand size={18} /><span><strong>Poligona Yaklaş</strong><small>Aktif alanı ekrana sığdır</small></span></button>
                <button type="button" onClick={() => { onReset(); setMenuOpen(false) }}><Move size={18} /><span><strong>Düzeni Sıfırla</strong><small>Harita görünümünü başlangıca al</small></span></button>
                <button type="button" className="is-danger" onClick={() => { onClearActive(); setMenuOpen(false) }}><Trash2 size={18} /><span><strong>Aktif Poligonu Temizle</strong><small>Koordinat ve DES noktalarını kaldır</small></span></button>
              </div>
            ) : null}
          </div>
        </div>
      </div>

      <div className="smart-context-bar">
        <span className="smart-active-color" style={{ background: activeColor }} />
        <span className="smart-active-copy"><strong>{activeName}</strong><small>{activePointCount} nokta</small></span>
        {showStats ? <span className="smart-stat"><b>{polygonCount}</b> pol</span> : null}
        {showStats ? <span className="smart-stat"><b>{pointCount}</b> pkt</span> : null}
        {showStats && areaLabel ? <span className="smart-area">{areaLabel}</span> : null}
        {performanceActive ? <span className="smart-speed">Hızlı</span> : null}
        <span className={`smart-online${isOnline ? '' : ' is-offline'}`}><i />{isOnline ? 'Online' : 'Offline'}</span>
      </div>
    </header>
  )
}
