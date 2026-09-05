import { useEffect, useMemo, useState } from 'react'
import { Box, Boxes, Layers3, Sparkles, Trash2, X } from 'lucide-react'
import './WorkCenterFeature.css'

const OPEN_EVENT = 'evren-open-work-center'
const LAST_TAB_KEY = 'evren-jeofizik-gis-work-center-last-tab-v1'
const DES_KEYS = [
  'evren-jeofizik-gis-des-analysis-v1',
  'evren-jeofizik-gis-des-professional-v2',
  'evren-jeofizik-gis-des-calibration-v1',
  'evren-jeofizik-gis-des-dual-inversion-v1',
  'evren-jeofizik-gis-des-auto-pipeline-v1',
]

type WorkTab = 'model' | 'studio' | 'des'

type WorkItem = {
  id: WorkTab
  label: string
  shortLabel: string
  event: string
  icon: typeof Box
}

const WORK_ITEMS: WorkItem[] = [
  { id: 'model', label: '3B Model', shortLabel: '3B Model', event: 'evren-open-underground-model', icon: Box },
  { id: 'studio', label: '3B Studio', shortLabel: '3B Studio', event: 'evren-open-underground-model-v2', icon: Layers3 },
  { id: 'des', label: 'DES Çalışması', shortLabel: 'DES Çalışması', event: 'evren-open-des-workspace', icon: Sparkles },
]

const FEATURE_OVERLAYS = [
  '.underground-overlay',
  '.des-overlay',
  '.despro-overlay',
  '.descal-overlay',
  '.desdual-overlay',
  '.desreport-overlay',
  '.desworkspace-overlay',
]

function readLastTab(): WorkTab {
  try {
    const value = localStorage.getItem(LAST_TAB_KEY) as WorkTab | null
    return WORK_ITEMS.some((item) => item.id === value) ? (value as WorkTab) : 'des'
  } catch {
    return 'des'
  }
}

function closeFeatureOverlays() {
  FEATURE_OVERLAYS.forEach((selector) => {
    const overlay = document.querySelector(selector)
    if (!overlay) return
    const button = overlay.querySelector<HTMLButtonElement>('button[class*="close"], button[aria-label*="kapat" i]')
    if (button && !button.disabled) button.click()
  })
}

export default function WorkCenterFeature() {
  const [open, setOpen] = useState(false)
  const [tab, setTab] = useState<WorkTab>(readLastTab)
  const active = useMemo(() => WORK_ITEMS.find((item) => item.id === tab) ?? WORK_ITEMS[2], [tab])

  useEffect(() => {
    const show = () => setOpen(true)
    window.addEventListener(OPEN_EVENT, show)
    return () => window.removeEventListener(OPEN_EVENT, show)
  }, [])

  useEffect(() => {
    if (!open) return
    document.body.classList.add('evren-work-center-open')
    localStorage.setItem(LAST_TAB_KEY, tab)
    closeFeatureOverlays()
    const timer = window.setTimeout(() => window.dispatchEvent(new CustomEvent(active.event)), 40)
    return () => window.clearTimeout(timer)
  }, [open, tab, active.event])

  useEffect(() => () => {
    document.body.classList.remove('evren-work-center-open')
    closeFeatureOverlays()
  }, [])

  const closeCenter = () => {
    closeFeatureOverlays()
    document.body.classList.remove('evren-work-center-open')
    setOpen(false)
  }

  const clearAllDes = () => {
    const count = (() => {
      try {
        const raw = JSON.parse(localStorage.getItem(DES_KEYS[0]) || '[]')
        return Array.isArray(raw) ? raw.length : 0
      } catch { return 0 }
    })()
    if (!window.confirm(`${count || 'Tüm'} DES kaydı ve bunlara bağlı model / doğrulama / otomatik işlem sonuçları silinsin mi? Bu işlem geri alınamaz.`)) return
    DES_KEYS.forEach((key) => localStorage.removeItem(key))
    window.dispatchEvent(new CustomEvent('evren-des-analysis-changed'))
    closeCenter()
    window.setTimeout(() => window.location.reload(), 80)
  }

  if (!open) return null

  return (
    <div className="work-center-chrome" role="dialog" aria-modal="true" aria-label="Çalışma Merkezi">
      <header className="work-center-header">
        <div className="work-center-brand"><span><Boxes size={22} /></span><div><small>EVREN GIS · TEK ÇALIŞMA ALANI</small><strong>Çalışma Merkezi</strong></div></div>
        <div className="work-center-actions">
          <button type="button" className="work-center-clear" onClick={clearAllDes}><Trash2 size={15} /> Tüm DES'i Sil</button>
          <button type="button" className="work-center-close" onClick={closeCenter} aria-label="Çalışma merkezini kapat"><X size={20} /></button>
        </div>
      </header>
      <nav className="work-center-tabs" aria-label="Çalışma araçları">
        {WORK_ITEMS.map((item) => {
          const Icon = item.icon
          return <button type="button" key={item.id} className={tab === item.id ? 'is-active' : ''} onClick={() => setTab(item.id)}><Icon size={16} /><span>{item.label}</span><small>{item.shortLabel}</small></button>
        })}
      </nav>
    </div>
  )
}
