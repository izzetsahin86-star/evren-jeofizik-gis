import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { Box, CheckCircle2, Layers3, Map, Route, Sparkles, TriangleAlert } from 'lucide-react'
import './DESAutoDimensionAdvisor.css'

const RECORDS_KEY = 'evren-jeofizik-gis-des-analysis-v1'
const PROFESSIONAL_KEY = 'evren-jeofizik-gis-des-professional-v2'
const DUAL_KEY = 'evren-jeofizik-gis-des-dual-inversion-v1'
const DECISION_KEY = 'evren-jeofizik-gis-des-dimension-decision-v1'

type RawRecord = {
  id?: string
  easting?: number | string | null
  northing?: number | string | null
  elevation?: number | string | null
  measurements?: unknown[]
}

type LayerLike = { rho?: number; thickness?: number | null }
type ProfessionalStore = Record<string, { layers?: LayerLike[] }>
type DualStore = Record<string, { recommended?: { consensusLayers?: LayerLike[] } }>
type XY = { x: number; y: number; z: number | null; id: string }

type Level = 'good' | 'limited' | 'off'

type Decision = {
  rawCount: number
  modelCount: number
  coordinateCount: number
  elevationCount: number
  lineRatio: number
  lineLike: boolean
  geometry: string
  recommended: string
  oneB: { level: Level; label: string; detail: string }
  twoB: { level: Level; label: string; detail: string }
  threeB: { level: Level; label: string; detail: string }
  maps: { level: Level; label: string; detail: string }
  targetView: 'section' | 'level' | null
}

function readJson<T>(key: string, fallback: T): T {
  try {
    const value = JSON.parse(localStorage.getItem(key) || '') as T
    return value ?? fallback
  } catch {
    return fallback
  }
}

function finite(value: unknown) {
  if (value === '' || value === null || value === undefined) return null
  const number = Number(value)
  return Number.isFinite(number) ? number : null
}

function geometryFor(points: XY[]) {
  if (points.length < 2) return { ratio: 0, lineLike: true, label: 'Tek nokta / koordinat yetersiz' }
  const meanX = points.reduce((sum, point) => sum + point.x, 0) / points.length
  const meanY = points.reduce((sum, point) => sum + point.y, 0) / points.length
  let sxx = 0
  let syy = 0
  let sxy = 0
  points.forEach((point) => {
    const dx = point.x - meanX
    const dy = point.y - meanY
    sxx += dx * dx
    syy += dy * dy
    sxy += dx * dy
  })
  const n = Math.max(1, points.length)
  sxx /= n
  syy /= n
  sxy /= n
  const trace = sxx + syy
  const disc = Math.sqrt(Math.max(0, (sxx - syy) ** 2 + 4 * sxy * sxy))
  const major = (trace + disc) / 2
  const minor = Math.max(0, (trace - disc) / 2)
  const ratio = major > 1e-9 ? minor / major : 0
  const lineLike = points.length < 3 || ratio < 0.08
  if (lineLike) return { ratio, lineLike, label: 'Hat / profil ağırlıklı dağılım' }
  if (ratio < 0.22) return { ratio, lineLike: false, label: 'Dar alan dağılımı' }
  return { ratio, lineLike: false, label: 'Alana yayılmış dağılım' }
}

function buildDecision(): Decision {
  const raw = readJson<RawRecord[]>(RECORDS_KEY, [])
  const professional = readJson<ProfessionalStore>(PROFESSIONAL_KEY, {})
  const dual = readJson<DualStore>(DUAL_KEY, {})
  const validRaw = Array.isArray(raw) ? raw.filter((record) => typeof record.id === 'string' && record.id && Array.isArray(record.measurements)) : []

  let modelCount = 0
  const coordinates: XY[] = []
  validRaw.forEach((record) => {
    const id = record.id as string
    const dualLayers = dual[id]?.recommended?.consensusLayers
    const professionalLayers = professional[id]?.layers
    const layers = Array.isArray(dualLayers) && dualLayers.length >= 2
      ? dualLayers
      : Array.isArray(professionalLayers) && professionalLayers.length >= 2
        ? professionalLayers
        : []
    if (!layers.length) return
    modelCount += 1
    const x = finite(record.easting)
    const y = finite(record.northing)
    if (x === null || y === null) return
    coordinates.push({ x, y, z: finite(record.elevation), id })
  })

  const unique = Array.from(new Map(coordinates.map((point) => [`${point.x.toFixed(3)}:${point.y.toFixed(3)}`, point])).values())
  const coordinateCount = unique.length
  const elevationCount = unique.filter((point) => point.z !== null).length
  const geometry = geometryFor(unique)
  const rawCount = validRaw.length

  const oneB: Decision['oneB'] = modelCount === 0
    ? { level: 'off', label: 'Bekliyor', detail: 'Önce Professional veya DES Otomatik ile 1B model oluşturulmalı.' }
    : modelCount === rawCount
      ? { level: 'good', label: 'Hazır', detail: `${modelCount}/${rawCount} DES için 1B elektriksel model mevcut.` }
      : { level: 'limited', label: `${modelCount}/${rawCount} hazır`, detail: 'Modelsiz DES noktaları tamamlandıkça üst boyut sonuçları güçlenir.' }

  let twoB: Decision['twoB']
  if (coordinateCount < 2) twoB = { level: 'off', label: 'Yetersiz', detail: 'En az 2 koordinatlı ve modellenmiş DES gerekir.' }
  else if (geometry.lineLike) twoB = { level: 'good', label: 'Uygun', detail: `${coordinateCount} nokta profil geometrisinde; A–A′ kesiti öncelikli.` }
  else twoB = { level: 'limited', label: 'Profil seçilmeli', detail: 'Noktalar alana yayılmış. Tek kesitte tüm noktaları zorlamak yerine profil hatları seçilmeli.' }

  let threeB: Decision['threeB']
  if (coordinateCount >= 10 && !geometry.lineLike) threeB = { level: 'good', label: 'Uygun', detail: `${coordinateCount} koordinatlı 1B model alana yayılmış; 3B interpolasyon için iyi veri yoğunluğu.` }
  else if (coordinateCount >= 5 && !geometry.lineLike) threeB = { level: 'limited', label: 'Sınırlı', detail: `${coordinateCount} nokta ile 3B interpolasyon yapılabilir; saha boşlukları nedeniyle dikkatli yorumlanmalı.` }
  else if (coordinateCount >= 10 && geometry.lineLike) threeB = { level: 'off', label: 'Önerilmez', detail: 'Nokta sayısı yüksek olsa da dağılım hat şeklinde; 2B profil daha doğru temsil eder.' }
  else threeB = { level: 'off', label: 'Yetersiz', detail: '3B saha interpolasyonu için tercihen en az 10 alana yayılmış koordinatlı model gerekir.' }

  let maps: Decision['maps']
  if (coordinateCount >= 5 && !geometry.lineLike) maps = { level: 'good', label: 'Uygun', detail: 'Derinlik özdirenç haritaları için dağılım yeterli.' }
  else if (coordinateCount >= 3) maps = { level: 'limited', label: 'Sınırlı', detail: geometry.lineLike ? 'Harita üretilebilir ancak hat geometrisi nedeniyle yatay interpolasyon sınırlı yorumlanmalı.' : '3–4 nokta ile yüzey oluşur; belirsizlik yüksektir.' }
  else maps = { level: 'off', label: 'Yetersiz', detail: 'Renkli seviye haritası için en az 3 koordinatlı model gerekir.' }

  let recommended = '1B model'
  let targetView: Decision['targetView'] = null
  if (modelCount === 0) recommended = 'Önce 1B modelleri tamamla'
  else if (coordinateCount < 2) recommended = '1B model'
  else if (geometry.lineLike) {
    recommended = '1B + 2B A–A′ kesiti'
    targetView = 'section'
  } else if (coordinateCount >= 10) {
    recommended = '1B + derinlik haritaları + 3B saha modeli'
    targetView = 'level'
  } else if (coordinateCount >= 5) {
    recommended = '1B + derinlik haritaları · 3B sınırlı'
    targetView = 'level'
  } else if (coordinateCount >= 3) {
    recommended = '1B + sınırlı derinlik haritası'
    targetView = 'level'
  } else {
    recommended = '1B + 2B profil'
    targetView = 'section'
  }

  const decision: Decision = {
    rawCount,
    modelCount,
    coordinateCount,
    elevationCount,
    lineRatio: geometry.ratio,
    lineLike: geometry.lineLike,
    geometry: geometry.label,
    recommended,
    oneB,
    twoB,
    threeB,
    maps,
    targetView,
  }
  try { localStorage.setItem(DECISION_KEY, JSON.stringify({ ...decision, updatedAt: Date.now() })) } catch { /* no-op */ }
  return decision
}

function clickReportView(target: Decision['targetView']) {
  if (!target) return
  const buttons = Array.from(document.querySelectorAll<HTMLButtonElement>('.desreport-toolbar nav button'))
  const wanted = target === 'section' ? 'Kesiti' : 'Derinlik Haritası'
  const button = buttons.find((item) => item.textContent?.includes(wanted))
  if (button && !button.disabled) button.click()
}

function StatusCard({ icon, title, item }: { icon: ReactNode; title: string; item: Decision['oneB'] }) {
  return <div className={`desdimension-card is-${item.level}`}>
    <span>{icon}</span>
    <div><small>{title}</small><strong>{item.label}</strong><p>{item.detail}</p></div>
  </div>
}

export default function DESAutoDimensionAdvisor() {
  const [visible, setVisible] = useState(false)
  const [decision, setDecision] = useState<Decision>(buildDecision)
  const [collapsed, setCollapsed] = useState(false)
  const lastOverlay = useRef<Element | null>(null)
  const autoApplied = useRef(false)

  const refresh = useCallback(() => setDecision(buildDecision()), [])

  useEffect(() => {
    const detect = () => {
      const overlay = document.querySelector('.desreport-overlay')
      const isVisible = Boolean(overlay)
      setVisible(isVisible)
      if (overlay !== lastOverlay.current) {
        lastOverlay.current = overlay
        autoApplied.current = false
        if (overlay) {
          const next = buildDecision()
          setDecision(next)
          window.setTimeout(() => {
            if (!autoApplied.current) {
              clickReportView(next.targetView)
              autoApplied.current = true
            }
          }, 120)
        }
      }
    }
    const observer = new MutationObserver(detect)
    observer.observe(document.body, { childList: true, subtree: true })
    detect()
    window.addEventListener('evren-des-analysis-changed', refresh)
    return () => {
      observer.disconnect()
      window.removeEventListener('evren-des-analysis-changed', refresh)
    }
  }, [refresh])

  const summaryTone = useMemo(() => {
    if (decision.modelCount === 0) return 'off'
    if (decision.threeB.level === 'good' || decision.twoB.level === 'good') return 'good'
    return 'limited'
  }, [decision])

  if (!visible) return null

  return <aside className={`desdimension-panel is-${summaryTone}${collapsed ? ' is-collapsed' : ''}`} aria-label="Otomatik DES model boyutu önerisi">
    <button type="button" className="desdimension-head" onClick={() => setCollapsed((value) => !value)}>
      <span><Sparkles size={17} /></span>
      <div><small>OTOMATİK MODEL KARARI</small><strong>{decision.recommended}</strong></div>
      <b>{collapsed ? '+' : '−'}</b>
    </button>
    {!collapsed ? <>
      <div className="desdimension-meta">
        <span><b>{decision.rawCount}</b><small>DES</small></span>
        <span><b>{decision.modelCount}</b><small>1B model</small></span>
        <span><b>{decision.coordinateCount}</b><small>Koordinatlı</small></span>
        <span><b>{decision.elevationCount}</b><small>Kotlu</small></span>
      </div>
      <div className="desdimension-geometry"><Route size={15} /><span><strong>{decision.geometry}</strong><small>Geometri oranı {decision.lineRatio.toFixed(3)} · sistem nokta sayısını tek başına kullanmaz.</small></span></div>
      <div className="desdimension-grid">
        <StatusCard icon={<Layers3 size={16} />} title="1B" item={decision.oneB} />
        <StatusCard icon={<Route size={16} />} title="2B KESİT" item={decision.twoB} />
        <StatusCard icon={<Box size={16} />} title="3B SAHA" item={decision.threeB} />
        <StatusCard icon={<Map size={16} />} title="SEVİYE HARİTASI" item={decision.maps} />
      </div>
      <div className="desdimension-actions">
        {decision.targetView ? <button type="button" onClick={() => clickReportView(decision.targetView)}><CheckCircle2 size={15} /> Önerilen Görünümü Aç</button> : null}
        <button type="button" onClick={refresh}>Yeniden Kontrol Et</button>
      </div>
      <div className="desdimension-note"><TriangleAlert size={14} /><span><b>3B</b> burada çoklu 1B DES modellerinin mekânsal interpolasyon uygunluğudur; gerçek 3B rezistivite inversiyonu olarak adlandırılmaz.</span></div>
    </> : null}
  </aside>
}
