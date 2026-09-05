import { useEffect, useMemo, useState } from 'react'
import { Download, Layers3, Map, Mountain, Route, X } from 'lucide-react'
import './DESReportMapsFeature.css'

const OPEN_EVENT = 'evren-open-des-report-maps'
const RECORDS_KEY = 'evren-jeofizik-gis-des-analysis-v1'
const PROFESSIONAL_KEY = 'evren-jeofizik-gis-des-professional-v2'
const DUAL_KEY = 'evren-jeofizik-gis-des-dual-inversion-v1'

type ViewTab = 'level' | 'section' | 'base'

type LayerModel = { id?: string; rho: number; thickness: number | null; interpretation?: string }
type DesMeasurement = { ab2: number; mn: number; rho: number }
type DesRecord = {
  id: string
  name: string
  easting: number | null
  northing: number | null
  elevation: number | null
  measurements: DesMeasurement[]
}
type ModelStore = Record<string, { layers?: LayerModel[] }>
type DualStore = Record<string, { recommended?: { consensusLayers?: LayerModel[] } }>
type ModelledRecord = DesRecord & { layers: LayerModel[] }
type MapPoint = { x: number; y: number; value: number; name: string }

function finite(value: unknown): number | null {
  const number = Number(value)
  return Number.isFinite(number) ? number : null
}

function readJson<T>(key: string, fallback: T): T {
  try {
    const raw = JSON.parse(localStorage.getItem(key) || '') as T
    return raw ?? fallback
  } catch {
    return fallback
  }
}

function readRecords(): DesRecord[] {
  const raw = readJson<Array<Partial<DesRecord>>>(RECORDS_KEY, [])
  return raw.flatMap((record) => {
    if (!record.id || !Array.isArray(record.measurements)) return []
    return [{
      id: record.id,
      name: record.name || 'DES',
      easting: finite(record.easting),
      northing: finite(record.northing),
      elevation: finite(record.elevation),
      measurements: record.measurements as DesMeasurement[],
    }]
  })
}

function modelledRecords(): ModelledRecord[] {
  const records = readRecords()
  const professional = readJson<ModelStore>(PROFESSIONAL_KEY, {})
  const dual = readJson<DualStore>(DUAL_KEY, {})
  return records.flatMap((record) => {
    const dualLayers = dual[record.id]?.recommended?.consensusLayers
    const professionalLayers = professional[record.id]?.layers
    const layers = Array.isArray(dualLayers) && dualLayers.length ? dualLayers : Array.isArray(professionalLayers) ? professionalLayers : []
    const clean = layers.map((layer, index) => ({
      id: layer.id || `layer-${index + 1}`,
      rho: Math.max(0.001, Number(layer.rho) || 0.001),
      thickness: index === layers.length - 1 || layer.thickness === null ? null : Math.max(0.01, Number(layer.thickness) || 0.01),
      interpretation: layer.interpretation || '',
    }))
    return clean.length >= 2 ? [{ ...record, layers: clean }] : []
  })
}

function rhoAtDepth(layers: LayerModel[], depth: number) {
  let cursor = 0
  for (const layer of layers) {
    if (layer.thickness === null) return layer.rho
    if (depth <= cursor + layer.thickness) return layer.rho
    cursor += layer.thickness
  }
  return layers[layers.length - 1]?.rho ?? 0
}

function boundaryDepth(layers: LayerModel[], boundary: number) {
  let depth = 0
  const end = Math.min(boundary, layers.length - 1)
  for (let index = 0; index < end; index += 1) {
    const thickness = layers[index]?.thickness
    if (thickness === null || !Number.isFinite(thickness)) return null
    depth += thickness
  }
  return depth > 0 ? depth : null
}

function idw(points: MapPoint[], x: number, y: number, power = 2) {
  let weighted = 0
  let weights = 0
  for (const point of points) {
    const dx = x - point.x
    const dy = y - point.y
    const d2 = dx * dx + dy * dy
    if (d2 < 1e-10) return point.value
    const w = 1 / Math.max(1e-12, d2 ** (power / 2))
    weighted += point.value * w
    weights += w
  }
  return weights ? weighted / weights : 0
}

function colorFor(value: number, min: number, max: number) {
  const logSafe = min > 0 && max > 0
  const a = logSafe ? Math.log10(Math.max(min, 0.001)) : min
  const b = logSafe ? Math.log10(Math.max(max, min + 0.001)) : max
  const v = logSafe ? Math.log10(Math.max(value, 0.001)) : value
  const t = Math.max(0, Math.min(1, (v - a) / Math.max(1e-9, b - a)))
  const hue = 240 - 240 * t
  return `hsl(${hue} 82% 52%)`
}

function exportSvg(id: string, fileName: string) {
  const svg = document.getElementById(id) as SVGSVGElement | null
  if (!svg) return
  const copy = svg.cloneNode(true) as SVGSVGElement
  copy.setAttribute('xmlns', 'http://www.w3.org/2000/svg')
  const source = new XMLSerializer().serializeToString(copy)
  const blob = new Blob([source], { type: 'image/svg+xml;charset=utf-8' })
  const url = URL.createObjectURL(blob)
  const link = document.createElement('a')
  link.href = url
  link.download = fileName
  document.body.appendChild(link)
  link.click()
  link.remove()
  window.setTimeout(() => URL.revokeObjectURL(url), 500)
}

function HeatMap({ points, title, subtitle, unit, svgId }: { points: MapPoint[]; title: string; subtitle: string; unit: string; svgId: string }) {
  if (points.length < 3) return <div className="desreport-empty-card"><Map size={30} /><strong>Harita için en az 3 koordinatlı model gerekli</strong><span>DES Analiz'de E/N koordinatlarını ve model sonuçlarını tamamlayın.</span></div>
  const xs = points.map((point) => point.x)
  const ys = points.map((point) => point.y)
  const values = points.map((point) => point.value)
  let minX = Math.min(...xs); let maxX = Math.max(...xs); let minY = Math.min(...ys); let maxY = Math.max(...ys)
  const padX = Math.max((maxX - minX) * 0.08, 1)
  const padY = Math.max((maxY - minY) * 0.08, 1)
  minX -= padX; maxX += padX; minY -= padY; maxY += padY
  const minV = Math.min(...values); const maxV = Math.max(...values)
  const cols = 42; const rows = 30
  const width = 940; const height = 620; const left = 75; const right = 110; const top = 58; const bottom = 70
  const innerW = width - left - right; const innerH = height - top - bottom
  const xScreen = (x: number) => left + (x - minX) / Math.max(1e-9, maxX - minX) * innerW
  const yScreen = (y: number) => top + (maxY - y) / Math.max(1e-9, maxY - minY) * innerH
  const cells = []
  for (let row = 0; row < rows; row += 1) {
    for (let col = 0; col < cols; col += 1) {
      const x0 = minX + (col / cols) * (maxX - minX)
      const x1 = minX + ((col + 1) / cols) * (maxX - minX)
      const y0 = minY + (row / rows) * (maxY - minY)
      const y1 = minY + ((row + 1) / rows) * (maxY - minY)
      const value = idw(points, (x0 + x1) / 2, (y0 + y1) / 2)
      cells.push(<rect key={`${row}-${col}`} x={xScreen(x0)} y={yScreen(y1)} width={innerW / cols + .5} height={innerH / rows + .5} fill={colorFor(value, minV, maxV)} />)
    }
  }
  const legend = Array.from({ length: 9 }, (_, index) => minV + (maxV - minV) * (index / 8))
  return <div className="desreport-figure"><div className="desreport-figure-head"><div><strong>{title}</strong><small>{subtitle}</small></div><button type="button" onClick={() => exportSvg(svgId, `${title.replace(/[^A-Za-z0-9_-]+/g, '-')}.svg`)}><Download size={15} /> SVG</button></div>
    <svg id={svgId} viewBox={`0 0 ${width} ${height}`} className="desreport-map" role="img" aria-label={title}>
      <rect width={width} height={height} fill="#fff" />
      <text x={left} y={28} fontSize="20" fontWeight="700" fill="#172033">{title}</text>
      <text x={left} y={47} fontSize="11" fill="#667085">{subtitle}</text>
      <g>{cells}</g>
      {Array.from({ length: 6 }, (_, index) => {
        const t = index / 5
        const xValue = minX + t * (maxX - minX)
        const yValue = minY + t * (maxY - minY)
        return <g key={index}><line x1={left + t * innerW} y1={top} x2={left + t * innerW} y2={top + innerH} stroke="rgba(255,255,255,.28)" strokeWidth="1" /><text x={left + t * innerW} y={top + innerH + 24} textAnchor="middle" fontSize="10" fill="#475467">{xValue.toFixed(0)}</text><line x1={left} y1={top + (1 - t) * innerH} x2={left + innerW} y2={top + (1 - t) * innerH} stroke="rgba(255,255,255,.28)" strokeWidth="1" /><text x={left - 10} y={top + (1 - t) * innerH + 4} textAnchor="end" fontSize="10" fill="#475467">{yValue.toFixed(0)}</text></g>
      })}
      {points.map((point) => <g key={point.name}><circle cx={xScreen(point.x)} cy={yScreen(point.y)} r="5" fill="#fff" stroke="#111827" strokeWidth="1.8" /><text x={xScreen(point.x) + 7} y={yScreen(point.y) - 7} fontSize="10" fontWeight="700" fill="#111827" stroke="#fff" strokeWidth="3" paintOrder="stroke">{point.name}</text></g>)}
      <text x={left + innerW / 2} y={height - 18} textAnchor="middle" fontSize="11" fill="#475467">Easting / Doğu (m)</text>
      <text x="18" y={top + innerH / 2} transform={`rotate(-90 18 ${top + innerH / 2})`} textAnchor="middle" fontSize="11" fill="#475467">Northing / Kuzey (m)</text>
      <g transform={`translate(${left + innerW + 34} ${top})`}>
        {legend.map((value, index) => <g key={index}><rect x="0" y={(8 - index) * (innerH / 9)} width="22" height={innerH / 9 + 1} fill={colorFor(value, minV, maxV)} /><text x="30" y={(8 - index) * (innerH / 9) + innerH / 18 + 4} fontSize="9" fill="#475467">{value.toFixed(unit === 'Ωm' ? 1 : 0)}</text></g>)}
        <text x="11" y={innerH + 24} textAnchor="middle" fontSize="10" fontWeight="700" fill="#344054">{unit}</text>
      </g>
    </svg>
  </div>
}

function SectionView({ records }: { records: ModelledRecord[] }) {
  const usable = records.filter((record) => record.easting !== null && record.northing !== null)
  if (usable.length < 2) return <div className="desreport-empty-card"><Route size={30} /><strong>Kesit için en az 2 koordinatlı DES gerekli</strong><span>DES noktalarına E/N koordinatı ekleyin.</span></div>
  const spanE = Math.max(...usable.map((r) => r.easting!)) - Math.min(...usable.map((r) => r.easting!))
  const spanN = Math.max(...usable.map((r) => r.northing!)) - Math.min(...usable.map((r) => r.northing!))
  const ordered = [...usable].sort((a, b) => spanE >= spanN ? a.easting! - b.easting! : a.northing! - b.northing!)
  const distances: number[] = [0]
  for (let index = 1; index < ordered.length; index += 1) {
    const dx = ordered[index].easting! - ordered[index - 1].easting!
    const dy = ordered[index].northing! - ordered[index - 1].northing!
    distances.push(distances[index - 1] + Math.hypot(dx, dy))
  }
  const maxDistance = Math.max(...distances, 1)
  const finiteDepths = ordered.map((record) => record.layers.slice(0, -1).reduce((sum, layer) => sum + (layer.thickness || 0), 0))
  const maxDepth = Math.max(50, ...finiteDepths) * 1.18
  const elevations = ordered.map((record) => record.elevation ?? 0)
  const maxZ = Math.max(...elevations)
  const minZ = Math.min(...elevations.map((z) => z - maxDepth))
  const rhoValues = ordered.flatMap((record) => record.layers.map((layer) => layer.rho))
  const minRho = Math.min(...rhoValues); const maxRho = Math.max(...rhoValues)
  const width = 1000; const height = 620; const left = 78; const right = 40; const top = 55; const bottom = 70
  const innerW = width - left - right; const innerH = height - top - bottom
  const x = (distance: number) => left + distance / maxDistance * innerW
  const y = (z: number) => top + (maxZ - z) / Math.max(1e-9, maxZ - minZ) * innerH
  const boundaryLines: Array<Array<{ x: number; y: number }>> = []
  const maxBoundary = Math.max(...ordered.map((record) => record.layers.length - 1))
  for (let boundary = 1; boundary <= maxBoundary; boundary += 1) {
    boundaryLines.push(ordered.flatMap((record, index) => {
      const depth = boundaryDepth(record.layers, boundary)
      return depth === null ? [] : [{ x: x(distances[index]), y: y((record.elevation ?? 0) - depth) }]
    }))
  }
  return <div className="desreport-figure"><div className="desreport-figure-head"><div><strong>A–A′ Yer-Elektrik Kesiti</strong><small>1B modeller gerçek DES mesafelerinde yan yana gösterilir</small></div><button type="button" onClick={() => exportSvg('desreport-section-svg', 'DES-AA-Kesiti.svg')}><Download size={15} /> SVG</button></div>
    <svg id="desreport-section-svg" viewBox={`0 0 ${width} ${height}`} className="desreport-map">
      <rect width={width} height={height} fill="#fff" />
      <text x={left} y="28" fontSize="20" fontWeight="700" fill="#172033">A–A′ Yer-Elektrik Kesiti</text>
      {Array.from({ length: 6 }, (_, i) => { const z = minZ + (maxZ - minZ) * (i / 5); return <g key={i}><line x1={left} x2={left + innerW} y1={y(z)} y2={y(z)} stroke="#e4e7ec" /><text x={left - 10} y={y(z) + 4} textAnchor="end" fontSize="10" fill="#475467">{z.toFixed(0)} m</text></g> })}
      <polyline points={ordered.map((record, index) => `${x(distances[index])},${y(record.elevation ?? 0)}`).join(' ')} fill="none" stroke="#344054" strokeWidth="2" />
      {ordered.map((record, recordIndex) => {
        let depth = 0
        const columnWidth = Math.max(22, Math.min(58, innerW / Math.max(ordered.length * 3, 1)))
        return <g key={record.id}>{record.layers.map((layer, layerIndex) => {
          const startZ = (record.elevation ?? 0) - depth
          const endDepth = layer.thickness === null ? maxDepth : depth + layer.thickness
          const endZ = (record.elevation ?? 0) - endDepth
          const rectY = y(startZ); const rectH = Math.max(2, y(endZ) - rectY)
          if (layer.thickness !== null) depth += layer.thickness
          return <rect key={layerIndex} x={x(distances[recordIndex]) - columnWidth / 2} y={rectY} width={columnWidth} height={rectH} fill={colorFor(layer.rho, minRho, maxRho)} stroke="#fff" strokeWidth=".7"><title>{`${record.name} · Tabaka ${layerIndex + 1} · ${layer.rho.toFixed(1)} Ωm`}</title></rect>
        })}<line x1={x(distances[recordIndex])} x2={x(distances[recordIndex])} y1={top} y2={top + innerH} stroke="#101828" strokeDasharray="3 4" strokeOpacity=".45" /><text x={x(distances[recordIndex])} y={top + innerH + 24} textAnchor="middle" fontSize="10" fontWeight="700" fill="#344054">{record.name}</text><text x={x(distances[recordIndex])} y={top + innerH + 39} textAnchor="middle" fontSize="9" fill="#667085">{distances[recordIndex].toFixed(0)} m</text></g>
      })}
      {boundaryLines.map((line, index) => line.length >= 2 ? <polyline key={index} points={line.map((p) => `${p.x},${p.y}`).join(' ')} fill="none" stroke="#101828" strokeWidth="1.2" strokeOpacity=".72" /> : null)}
      <text x={left + innerW / 2} y={height - 14} textAnchor="middle" fontSize="11" fill="#475467">Profil mesafesi (m)</text>
    </svg>
  </div>
}

export default function DESReportMapsFeature() {
  const [open, setOpen] = useState(false)
  const [view, setView] = useState<ViewTab>('level')
  const [depth, setDepth] = useState(500)
  const [boundary, setBoundary] = useState(2)
  const [records, setRecords] = useState<ModelledRecord[]>(modelledRecords)

  useEffect(() => {
    const show = () => { setRecords(modelledRecords()); setOpen(true) }
    window.addEventListener(OPEN_EVENT, show)
    return () => window.removeEventListener(OPEN_EVENT, show)
  }, [])

  useEffect(() => {
    if (!open) return
    const previous = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    const close = (event: KeyboardEvent) => { if (event.key === 'Escape') setOpen(false) }
    window.addEventListener('keydown', close)
    return () => { document.body.style.overflow = previous; window.removeEventListener('keydown', close) }
  }, [open])

  const coordinateRecords = useMemo(() => records.filter((record) => record.easting !== null && record.northing !== null), [records])
  const levelPoints = useMemo<MapPoint[]>(() => coordinateRecords.map((record) => ({ x: record.easting!, y: record.northing!, value: rhoAtDepth(record.layers, depth), name: record.name })), [coordinateRecords, depth])
  const basePoints = useMemo<MapPoint[]>(() => coordinateRecords.flatMap((record) => {
    if (record.elevation === null) return []
    const d = boundaryDepth(record.layers, boundary)
    return d === null ? [] : [{ x: record.easting!, y: record.northing!, value: record.elevation - d, name: record.name }]
  }), [coordinateRecords, boundary])
  const maxBoundary = Math.max(1, ...records.map((record) => record.layers.length - 1))

  if (!open) return null

  return <div className="desreport-overlay" role="dialog" aria-modal="true" aria-label="DES Rapor Haritaları"><section className="desreport-shell">
    <header className="desreport-header"><div><span><Map size={22} /></span><div><small>EVREN GIS · RAPOR GÖRSELLERİ</small><h2>DES Rapor & Haritalar</h2></div></div><button type="button" className="desreport-close" onClick={() => setOpen(false)} aria-label="Kapat"><X size={20} /></button></header>
    <div className="desreport-toolbar">
      <nav><button type="button" className={view === 'level' ? 'is-active' : ''} onClick={() => setView('level')}><Map size={16} /> Derinlik Haritası</button><button type="button" className={view === 'section' ? 'is-active' : ''} onClick={() => setView('section')}><Route size={16} /> A–A′ Kesiti</button><button type="button" className={view === 'base' ? 'is-active' : ''} onClick={() => setView('base')}><Mountain size={16} /> Taban Topoğrafyası</button></nav>
      <div className="desreport-summary"><span><strong>{records.length}</strong><small>1B model</small></span><span><strong>{coordinateRecords.length}</strong><small>Koordinatlı</small></span><span><strong>{basePoints.length}</strong><small>Kot hazır</small></span></div>
    </div>
    <main className="desreport-content">
      {view === 'level' ? <><div className="desreport-controls"><label><span>Model derinliği</span><select value={depth} onChange={(event) => setDepth(Number(event.target.value))}>{[100,300,500,700,1000,1250,1500].map((value) => <option key={value} value={value}>{value} m</option>)}</select></label><p>Bu harita AB/2 = derinlik kabul etmez; her DES'in kaydedilmiş 1B modelinden seçilen gerçek model derinliğindeki ρ değeri alınır.</p></div><HeatMap points={levelPoints} title={`${depth} m Model Özdirenç Dağılım Haritası`} subtitle="1B DES modellerinden IDW yatay interpolasyon" unit="Ωm" svgId="desreport-level-svg" /></> : null}
      {view === 'section' ? <SectionView records={records} /> : null}
      {view === 'base' ? <><div className="desreport-controls"><label><span>Taban sınırı</span><select value={Math.min(boundary, maxBoundary)} onChange={(event) => setBoundary(Number(event.target.value))}>{Array.from({ length: maxBoundary }, (_, index) => index + 1).map((value) => <option key={value} value={value}>{value}. / {value + 1}. tabaka sınırı</option>)}</select></label><p>Taban kotu = DES arazi kotu − seçilen elektriksel tabaka sınır derinliği. En az 3 E/N/Z bilgili DES gerektirir.</p></div><HeatMap points={basePoints} title="Elektriksel Taban Topoğrafyası" subtitle={`${boundary}. tabaka tabanı · kot bazlı IDW yüzey`} unit="m" svgId="desreport-base-svg" /></> : null}
      <div className="desreport-note"><Layers3 size={18} /><div><strong>Raporlama notu</strong><span>Renkli haritalar koordinatlı 1B DES modellerinin IDW interpolasyonudur; bağımsız 2B/3B rezistivite inversiyonu değildir. Jeolojik yorum, sondaj ve saha jeolojisi ile birlikte yapılmalıdır.</span></div></div>
    </main>
  </section></div>
}
