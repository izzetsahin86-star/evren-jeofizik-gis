import { useEffect, useMemo, useState } from 'react'
import JSZip from 'jszip'
import { AlertTriangle, Box, Database, Download, Eye, FileArchive, Layers3, RefreshCw, X } from 'lucide-react'
import './UndergroundModelFeature.css'
import './UndergroundModelV2Feature.css'

const STORAGE_KEY = 'evren-jeofizik-gis-underground-model-v1'
const OPEN_EVENT = 'evren-open-underground-model-v2'

type Tab = 'log' | 'section' | 'terrain' | 'surfaces' | 'export'
type SurfaceMode = 'top' | 'bottom'

type Interval = { id: string; from: number; to: number; lithology: string; note: string; color: string }
type Borehole = {
  id: string
  name: string
  easting: number
  northing: number
  elevation: number
  zone: number
  hemisphere: 'N' | 'S'
  totalDepth: number
  waterLevel: number | null
  temperature: number | null
  note: string
  intervals: Interval[]
}
type Sample = { e: number; n: number; z: number; name?: string }
type GridPoint = Sample & { row: number; col: number }

type SectionItem = Borehole & { distance: number; offset: number }

const finite = (value: unknown, fallback = 0) => {
  const number = Number(value)
  return Number.isFinite(number) ? number : fallback
}

function normalizeInterval(value: Partial<Interval>, index: number): Interval {
  return {
    id: typeof value.id === 'string' && value.id ? value.id : `lit-${index}`,
    from: Math.max(0, finite(value.from)),
    to: Math.max(0, finite(value.to)),
    lithology: typeof value.lithology === 'string' && value.lithology.trim() ? value.lithology.trim() : 'Bilinmiyor',
    note: typeof value.note === 'string' ? value.note : '',
    color: typeof value.color === 'string' && value.color ? value.color : '#7890a3',
  }
}

function readBoreholes(): Borehole[] {
  try {
    const raw = JSON.parse(localStorage.getItem(STORAGE_KEY) || 'null') as { boreholes?: Array<Partial<Borehole>> } | null
    if (!raw || !Array.isArray(raw.boreholes)) return []
    return raw.boreholes.map((value, index) => ({
      id: typeof value.id === 'string' && value.id ? value.id : `bh-${index}`,
      name: typeof value.name === 'string' && value.name.trim() ? value.name.trim() : `Sondaj ${index + 1}`,
      easting: finite(value.easting),
      northing: finite(value.northing),
      elevation: finite(value.elevation),
      zone: Math.max(1, Math.min(60, Math.round(finite(value.zone, 36)))),
      hemisphere: value.hemisphere === 'S' ? 'S' : 'N',
      totalDepth: Math.max(0, finite(value.totalDepth)),
      waterLevel: value.waterLevel === null || value.waterLevel === undefined ? null : finite(value.waterLevel),
      temperature: value.temperature === null || value.temperature === undefined ? null : finite(value.temperature),
      note: typeof value.note === 'string' ? value.note : '',
      intervals: Array.isArray(value.intervals) ? value.intervals.map(normalizeInterval).sort((a, b) => a.from - b.from) : [],
    }))
  } catch {
    return []
  }
}

function validGeometry(hole: Borehole) {
  return Number.isFinite(hole.easting) && Number.isFinite(hole.northing) && hole.easting !== 0 && hole.northing !== 0
}

function ascii(value: string) {
  return value.normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/ı/g, 'i').replace(/İ/g, 'I').replace(/[^A-Za-z0-9_-]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 28).toUpperCase() || 'MODEL'
}

function idw(e: number, n: number, samples: Sample[], power = 2) {
  let weighted = 0
  let weights = 0
  for (const sample of samples) {
    const dx = e - sample.e
    const dy = n - sample.n
    const d2 = dx * dx + dy * dy
    if (d2 < 0.000001) return sample.z
    const w = 1 / Math.pow(Math.sqrt(d2), power)
    weighted += sample.z * w
    weights += w
  }
  return weights ? weighted / weights : 0
}

function boundsFor(samples: Sample[]) {
  const east = samples.map((s) => s.e)
  const north = samples.map((s) => s.n)
  const minE0 = Math.min(...east)
  const maxE0 = Math.max(...east)
  const minN0 = Math.min(...north)
  const maxN0 = Math.max(...north)
  const padE = Math.max(10, (maxE0 - minE0) * 0.08)
  const padN = Math.max(10, (maxN0 - minN0) * 0.08)
  return { minE: minE0 - padE, maxE: maxE0 + padE, minN: minN0 - padN, maxN: maxN0 + padN }
}

function gridFromSamples(samples: Sample[], size = 9): GridPoint[] {
  if (samples.length < 3) return []
  const bounds = boundsFor(samples)
  const points: GridPoint[] = []
  for (let row = 0; row < size; row += 1) {
    for (let col = 0; col < size; col += 1) {
      const e = bounds.minE + (bounds.maxE - bounds.minE) * col / (size - 1)
      const n = bounds.minN + (bounds.maxN - bounds.minN) * row / (size - 1)
      points.push({ e, n, z: idw(e, n, samples), row, col })
    }
  }
  return points
}

function farthestPair(holes: Borehole[]) {
  let pair: [Borehole, Borehole] | null = null
  let best = -1
  holes.forEach((a, i) => holes.slice(i + 1).forEach((b) => {
    const d = Math.hypot(b.easting - a.easting, b.northing - a.northing)
    if (d > best) { best = d; pair = [a, b] }
  }))
  return pair
}

function sectionItems(holes: Borehole[]): SectionItem[] {
  const valid = holes.filter(validGeometry)
  const pair = farthestPair(valid)
  if (!pair) return []
  const [a, b] = pair
  const dx = b.easting - a.easting
  const dy = b.northing - a.northing
  const length = Math.max(1, Math.hypot(dx, dy))
  const ux = dx / length
  const uy = dy / length
  return valid.map((hole) => {
    const rx = hole.easting - a.easting
    const ry = hole.northing - a.northing
    return { ...hole, distance: rx * ux + ry * uy, offset: Math.abs(rx * -uy + ry * ux) }
  }).sort((x, y) => x.distance - y.distance)
}

function surfaceSamples(holes: Borehole[], lithology: string, mode: SurfaceMode): Sample[] {
  return holes.flatMap((hole) => {
    if (!validGeometry(hole)) return []
    const interval = hole.intervals.find((item) => item.lithology === lithology)
    if (!interval) return []
    const depth = mode === 'top' ? interval.from : interval.to
    return [{ e: hole.easting, n: hole.northing, z: hole.elevation - depth, name: hole.name }]
  })
}

function terrainSamples(holes: Borehole[]): Sample[] {
  return holes.filter(validGeometry).map((hole) => ({ e: hole.easting, n: hole.northing, z: hole.elevation, name: hole.name }))
}

function projectGrid(grid: GridPoint[], size = 9) {
  if (!grid.length) return { polygons: [] as Array<{ key: string; points: string; z: number }>, dots: [] as Array<{ x: number; y: number }> }
  const minE = Math.min(...grid.map((p) => p.e)); const maxE = Math.max(...grid.map((p) => p.e)
  const minN = Math.min(...grid.map((p) => p.n)); const maxN = Math.max(...grid.map((p) => p.n)
  const minZ = Math.min(...grid.map((p) => p.z)); const maxZ = Math.max(...grid.map((p) => p.z))
  const spanE = Math.max(1, maxE - minE); const spanN = Math.max(1, maxN - minN); const spanZ = Math.max(1, maxZ - minZ)
  const projected = grid.map((p) => {
    const e = (p.e - minE) / spanE; const n = (p.n - minN) / spanN; const z = (p.z - minZ) / spanZ
    return { ...p, x: 105 + e * 510 + n * 145, y: 235 - n * 105 + e * 28 - z * 115 }
  })
  const at = (row: number, col: number) => projected[row * size + col]
  const polygons: Array<{ key: string; points: string; z: number }> = []
  for (let row = size - 2; row >= 0; row -= 1) {
    for (let col = 0; col < size - 1; col += 1) {
      const a = at(row, col); const b = at(row, col + 1); const c = at(row + 1, col + 1); const d = at(row + 1, col)
      polygons.push({ key: `${row}-${col}`, points: `${a.x},${a.y} ${b.x},${b.y} ${c.x},${c.y} ${d.x},${d.y}`, z: (a.z + b.z + c.z + d.z) / 4 })
    }
  }
  return { polygons, dots: projected.map((p) => ({ x: p.x, y: p.y })) }
}

function SurfacePreview({ samples, title, color }: { samples: Sample[]; title: string; color: string }) {
  const grid = useMemo(() => gridFromSamples(samples), [samples])
  if (samples.length < 3) return <div className="underground-empty"><AlertTriangle size={32} /><strong>En az 3 gerçek kot noktası gerekiyor</strong><span>Yüzey, yalnız sondajlardan gelen E/N/Z değerlerinden üretilir.</span></div>
  const { polygons } = projectGrid(grid)
  const minZ = Math.min(...grid.map((p) => p.z)); const maxZ = Math.max(...grid.map((p) => p.z))
  return <div className="underground-preview-card u2-surface-card">
    <svg viewBox="0 0 860 360" className="underground-preview-svg" role="img" aria-label={title}>
      <rect x="0" y="0" width="860" height="360" fill="transparent" />
      {polygons.map((poly) => <polygon key={poly.key} points={poly.points} fill={color} fillOpacity={0.18 + poly.z * 0.44} stroke="#47657a" strokeOpacity="0.72" strokeWidth="0.8" />)}
      {samples.map((sample, index) => {
        const minE = Math.min(...samples.map((s) => s.e)); const maxE = Math.max(...samples.map((s) => s.e)); const minN = Math.min(...samples.map((s) => s.n)); const maxN = Math.max(...samples.map((s) => s.n))
        const x = 105 + ((sample.e - minE) / Math.max(1, maxE - minE)) * 510 + ((sample.n - minN) / Math.max(1, maxN - minN)) * 145
        const y = 235 - ((sample.n - minN) / Math.max(1, maxN - minN)) * 105 + ((sample.e - minE) / Math.max(1, maxE - minE)) * 28 - ((sample.z - minZ) / Math.max(1, maxZ - minZ)) * 115
        return <g key={`${sample.name}-${index}`}><circle cx={x} cy={y} r="4" fill="#eef8ff" stroke="#1597e5" strokeWidth="2" /><text x={x + 7} y={y - 6} fill="#dcecf7" fontSize="9">{sample.name}</text></g>
      })}
      <text x="28" y="28" fill="#e8f4fb" fontSize="14" fontWeight="700">{title}</text>
      <text x="28" y="48" fill="#88a9bd" fontSize="10">IDW yüzey · Min Z {minZ.toFixed(1)} m · Maks Z {maxZ.toFixed(1)} m · {samples.length} kontrol noktası</text>
    </svg>
  </div>
}

function BoreholeLog({ hole }: { hole: Borehole | null }) {
  if (!hole) return <div className="underground-empty"><Database size={32} /><strong>Kuyu seçin</strong><span>V1 modelindeki sondajlardan biri seçildiğinde profesyonel log çizilir.</span></div>
  const depth = Math.max(1, hole.totalDepth, ...hole.intervals.map((i) => i.to))
  const y = (d: number) => 55 + d / depth * 470
  return <div className="u2-log-wrap">
    <svg viewBox="0 0 720 590" className="u2-log-svg" role="img" aria-label={`${hole.name} kuyu logu`}>
      <text x="28" y="28" fill="#eaf5fc" fontSize="15" fontWeight="700">{hole.name} · Kuyu Logu</text>
      <text x="28" y="45" fill="#87a9bc" fontSize="10">Kot {hole.elevation.toFixed(2)} m · Derinlik {hole.totalDepth.toFixed(2)} m · UTM {hole.zone}{hole.hemisphere}</text>
      {Array.from({ length: 11 }, (_, i) => i * depth / 10).map((d) => <g key={d}><line x1="65" y1={y(d)} x2="640" y2={y(d)} stroke="#29475b" strokeDasharray="3 6" /><text x="18" y={y(d) + 4} fill="#91afc0" fontSize="9">{d.toFixed(0)} m</text></g>)}
      <rect x="90" y="55" width="190" height="470" fill="#0d1e2a" stroke="#426477" />
      {hole.intervals.map((interval) => <g key={interval.id}>
        <rect x="90" y={y(interval.from)} width="190" height={Math.max(2, y(interval.to) - y(interval.from))} fill={interval.color} fillOpacity="0.9" />
        <text x="300" y={(y(interval.from) + y(interval.to)) / 2 + 4} fill="#e7f2f8" fontSize="11" fontWeight="700">{interval.lithology}</text>
        <text x="420" y={(y(interval.from) + y(interval.to)) / 2 + 4} fill="#90afc0" fontSize="9">{interval.from.toFixed(1)}–{interval.to.toFixed(1)} m · Z {(hole.elevation - interval.to).toFixed(1)} / {(hole.elevation - interval.from).toFixed(1)}</text>
      </g>)}
      {hole.waterLevel !== null ? <g><line x1="80" y1={y(hole.waterLevel)} x2="295" y2={y(hole.waterLevel)} stroke="#51b9e8" strokeWidth="3" /><text x="300" y={y(hole.waterLevel) - 5} fill="#70c9ef" fontSize="10">Su seviyesi {hole.waterLevel.toFixed(1)} m</text></g> : null}
      <line x1="65" y1="55" x2="65" y2="525" stroke="#8ba7b8" strokeWidth="1.5" />
    </svg>
    <div className="u2-log-meta"><span><strong>E</strong>{hole.easting.toFixed(3)}</span><span><strong>N</strong>{hole.northing.toFixed(3)}</span><span><strong>Z</strong>{hole.elevation.toFixed(2)} m</span><span><strong>Sıcaklık</strong>{hole.temperature === null ? '—' : `${hole.temperature.toFixed(1)} °C`}</span></div>
  </div>
}

function SectionPreview({ holes }: { holes: Borehole[] }) {
  const items = useMemo(() => sectionItems(holes), [holes])
  if (items.length < 2) return <div className="underground-empty"><AlertTriangle size={32} /><strong>Kesit için en az 2 koordinatlı sondaj gerekiyor</strong><span>A–A′ hattı en uzak iki sondaj arasında otomatik kurulur.</span></div>
  const minD = Math.min(...items.map((h) => h.distance)); const maxD = Math.max(...items.map((h) => h.distance)); const spanD = Math.max(1, maxD - minD)
  const maxZ = Math.max(...items.map((h) => h.elevation)); const minZ = Math.min(...items.map((h) => h.elevation - h.totalDepth)); const spanZ = Math.max(1, maxZ - minZ)
  const x = (d: number) => 78 + (d - minD) / spanD * 700
  const y = (z: number) => 55 + (maxZ - z) / spanZ * 430
  const lithologies = Array.from(new Set(items.flatMap((h) => h.intervals.map((i) => i.lithology))))
  return <div className="u2-section-wrap"><svg viewBox="0 0 850 540" className="u2-section-svg" role="img" aria-label="A-A jeolojik kesit">
    <text x="25" y="26" fill="#eaf5fc" fontSize="15" fontWeight="700">A – A′ Jeolojik Kesit</text>
    <text x="25" y="44" fill="#86a8ba" fontSize="10">Otomatik profil · Uzunluk {spanD.toFixed(1)} m · Kot aralığı {minZ.toFixed(1)}–{maxZ.toFixed(1)} m</text>
    {Array.from({ length: 6 }, (_, i) => maxZ - i * spanZ / 5).map((zv) => <g key={zv}><line x1="62" y1={y(zv)} x2="795" y2={y(zv)} stroke="#29475b" strokeDasharray="4 7" /><text x="12" y={y(zv) + 4} fill="#8faebe" fontSize="9">{zv.toFixed(0)}</text></g>)}
    <polyline points={items.map((h) => `${x(h.distance)},${y(h.elevation)}`).join(' ')} fill="none" stroke="#9ab6a0" strokeWidth="2.2" />
    {lithologies.map((name) => {
      const points = items.flatMap((h) => { const interval = h.intervals.find((i) => i.lithology === name); return interval ? [[x(h.distance), y(h.elevation - interval.from)] as [number, number]] : [] })
      if (points.length < 2) return null
      const color = items.flatMap((h) => h.intervals).find((i) => i.lithology === name)?.color || '#7b91a2'
      return <polyline key={name} points={points.map((p) => p.join(',')).join(' ')} fill="none" stroke={color} strokeWidth="2" strokeDasharray="6 4" opacity="0.9" />
    })}
    {items.map((hole) => <g key={hole.id}>
      {hole.intervals.map((interval) => <rect key={interval.id} x={x(hole.distance) - 5} y={y(hole.elevation - interval.from)} width="10" height={Math.max(2, y(hole.elevation - interval.to) - y(hole.elevation - interval.from))} fill={interval.color} />)}
      <line x1={x(hole.distance)} y1={y(hole.elevation)} x2={x(hole.distance)} y2={y(hole.elevation - hole.totalDepth)} stroke="#dbe8ef" strokeOpacity="0.5" />
      {hole.waterLevel !== null ? <line x1={x(hole.distance) - 9} y1={y(hole.elevation - hole.waterLevel)} x2={x(hole.distance) + 9} y2={y(hole.elevation - hole.waterLevel)} stroke="#4fc3f7" strokeWidth="2.5" /> : null}
      <text x={x(hole.distance) + 7} y={y(hole.elevation) - 5} fill="#e4f0f6" fontSize="9" fontWeight="700">{hole.name}</text>
      <text x={x(hole.distance) + 7} y={y(hole.elevation) + 8} fill="#7598aa" fontSize="8">ofset {hole.offset.toFixed(0)} m</text>
    </g>)}
    <text x="65" y="520" fill="#eaf5fc" fontSize="12" fontWeight="700">A</text><text x="790" y="520" fill="#eaf5fc" fontSize="12" fontWeight="700">A′</text>
  </svg></div>
}

function dxfLayer(values: string[], name: string, color: number) { values.push('0', 'LAYER', '2', name, '70', '0', '62', String(color), '6', 'CONTINUOUS') }
function dxfFace(values: string[], layer: string, a: GridPoint, b: GridPoint, c: GridPoint, d: GridPoint) {
  values.push('0', '3DFACE', '8', layer, '10', String(a.e), '20', String(a.n), '30', String(a.z), '11', String(b.e), '21', String(b.n), '31', String(b.z), '12', String(c.e), '22', String(c.n), '32', String(c.z), '13', String(d.e), '23', String(d.n), '33', String(d.z))
}

function professionalDxf(holes: Borehole[]) {
  const valid = holes.filter(validGeometry)
  const lithologies = Array.from(new Set(valid.flatMap((h) => h.intervals.map((i) => i.lithology))))
  const layers = ['BH_COLLAR', 'BH_TRACE', 'BH_LABEL', 'WATER_LEVEL', 'TOPO_SURFACE', 'SECTION_AA', ...lithologies.flatMap((l) => [`LITH_${ascii(l)}`, `SURF_${ascii(l)}`])]
  const v: string[] = ['0','SECTION','2','HEADER','9','$ACADVER','1','AC1015','0','ENDSEC','0','SECTION','2','TABLES','0','TABLE','2','LAYER','70',String(layers.length)]
  layers.forEach((layer, index) => dxfLayer(v, layer, index < 4 ? [2, 7, 3, 4][index] : 8))
  v.push('0','ENDTAB','0','ENDSEC','0','SECTION','2','ENTITIES')
  valid.forEach((hole) => {
    v.push('0','POINT','8','BH_COLLAR','10',String(hole.easting),'20',String(hole.northing),'30',String(hole.elevation))
    v.push('0','LINE','8','BH_TRACE','10',String(hole.easting),'20',String(hole.northing),'30',String(hole.elevation),'11',String(hole.easting),'21',String(hole.northing),'31',String(hole.elevation-hole.totalDepth))
    v.push('0','TEXT','8','BH_LABEL','10',String(hole.easting+2),'20',String(hole.northing+2),'30',String(hole.elevation+1),'40','2.5','1',ascii(hole.name))
    hole.intervals.forEach((i) => v.push('0','LINE','8',`LITH_${ascii(i.lithology)}`,'10',String(hole.easting),'20',String(hole.northing),'30',String(hole.elevation-i.from),'11',String(hole.easting),'21',String(hole.northing),'31',String(hole.elevation-i.to)))
    if (hole.waterLevel !== null) v.push('0','LINE','8','WATER_LEVEL','10',String(hole.easting-3),'20',String(hole.northing),'30',String(hole.elevation-hole.waterLevel),'11',String(hole.easting+3),'21',String(hole.northing),'31',String(hole.elevation-hole.waterLevel))
  })
  const topo = gridFromSamples(terrainSamples(valid), 10)
  if (topo.length) for (let r=0;r<9;r+=1) for (let c=0;c<9;c+=1) { const at=(rr:number,cc:number)=>topo[rr*10+cc]; dxfFace(v,'TOPO_SURFACE',at(r,c),at(r,c+1),at(r+1,c+1),at(r+1,c)) }
  lithologies.forEach((lith) => {
    const grid = gridFromSamples(surfaceSamples(valid, lith, 'top'), 10)
    if (!grid.length) return
    for (let r=0;r<9;r+=1) for (let c=0;c<9;c+=1) { const at=(rr:number,cc:number)=>grid[rr*10+cc]; dxfFace(v,`SURF_${ascii(lith)}`,at(r,c),at(r,c+1),at(r+1,c+1),at(r+1,c)) }
  })
  const pair = farthestPair(valid)
  if (pair) v.push('0','LINE','8','SECTION_AA','10',String(pair[0].easting),'20',String(pair[0].northing),'30',String(pair[0].elevation),'11',String(pair[1].easting),'21',String(pair[1].northing),'31',String(pair[1].elevation))
  v.push('0','ENDSEC','0','EOF')
  return v.join('\r\n')
}

function csv(value: unknown) { return `"${String(value ?? '').replace(/"/g, '""')}"` }
function surfaceCsv(holes: Borehole[]) {
  const rows: unknown[][] = [['SONDAJ','EASTING','NORTHING','COLLAR_Z','LITOLOJI','TAVAN_Z','TABAN_Z']]
  holes.filter(validGeometry).forEach((h) => h.intervals.forEach((i) => rows.push([h.name,h.easting.toFixed(3),h.northing.toFixed(3),h.elevation.toFixed(3),i.lithology,(h.elevation-i.from).toFixed(3),(h.elevation-i.to).toFixed(3)])))
  return '\ufeff' + rows.map((r) => r.map(csv).join(';')).join('\r\n')
}
function sectionCsv(holes: Borehole[]) {
  const rows: unknown[][] = [['SONDAJ','PROFIL_M','HAT_OFSET_M','EASTING','NORTHING','KOT_Z','DERINLIK_M']]
  sectionItems(holes).forEach((h) => rows.push([h.name,h.distance.toFixed(3),h.offset.toFixed(3),h.easting.toFixed(3),h.northing.toFixed(3),h.elevation.toFixed(3),h.totalDepth.toFixed(2)]))
  return '\ufeff' + rows.map((r) => r.map(csv).join(';')).join('\r\n')
}
function download(blob: Blob, name: string) { const url=URL.createObjectURL(blob); const a=document.createElement('a'); a.href=url; a.download=name; document.body.appendChild(a); a.click(); a.remove(); setTimeout(()=>URL.revokeObjectURL(url),500) }

export default function UndergroundModelV2Feature() {
  const [open, setOpen] = useState(false)
  const [tab, setTab] = useState<Tab>('log')
  const [holes, setHoles] = useState<Borehole[]>(readBoreholes)
  const [selectedId, setSelectedId] = useState<string>('')
  const [lithology, setLithology] = useState('')
  const [surfaceMode, setSurfaceMode] = useState<SurfaceMode>('top')

  const lithologies = useMemo(() => Array.from(new Set(holes.flatMap((h) => h.intervals.map((i) => i.lithology)))), [holes])
  const selected = holes.find((h) => h.id === selectedId) ?? holes[0] ?? null
  const selectedLithology = lithology && lithologies.includes(lithology) ? lithology : lithologies[0] || ''
  const terrain = useMemo(() => terrainSamples(holes), [holes])
  const layerSamples = useMemo(() => selectedLithology ? surfaceSamples(holes, selectedLithology, surfaceMode) : [], [holes, selectedLithology, surfaceMode])
  const surfaceCount = useMemo(() => lithologies.filter((l) => surfaceSamples(holes, l, 'top').length >= 3).length, [holes, lithologies])

  const reload = () => { const next=readBoreholes(); setHoles(next); if (!next.some((h)=>h.id===selectedId)) setSelectedId(next[0]?.id || '') }
  useEffect(() => { const show=()=>{ reload(); setOpen(true) }; window.addEventListener(OPEN_EVENT, show); return()=>window.removeEventListener(OPEN_EVENT, show) }, [selectedId])
  useEffect(() => { if (!open) return; const prev=document.body.style.overflow; document.body.style.overflow='hidden'; const esc=(e:KeyboardEvent)=>{if(e.key==='Escape')setOpen(false)}; window.addEventListener('keydown',esc); return()=>{document.body.style.overflow=prev;window.removeEventListener('keydown',esc)} }, [open])

  const exportPackage = async () => {
    const zip = new JSZip()
    zip.file('evren-profesyonel-3d-v2.dxf', professionalDxf(holes))
    zip.file('katman-yuzey-kontrol-noktalari.csv', surfaceCsv(holes))
    zip.file('AA-jeolojik-kesit.csv', sectionCsv(holes))
    zip.file('evren-3d-model-v1-veri.json', localStorage.getItem(STORAGE_KEY) || JSON.stringify({ version:1,boreholes:holes }, null, 2))
    zip.file('OKU-BENI-V2.txt', ['EVREN GIS 3B MODEL V2','', 'DXF katmanlari: BH_COLLAR, BH_TRACE, BH_LABEL, WATER_LEVEL, TOPO_SURFACE, SECTION_AA, LITH_*, SURF_*.', 'TOPO_SURFACE sondaj agiz kotlarindan IDW ile uretilir.', 'SURF_* litoloji tavan kotlarindan, en az 3 sondaj verisi varsa uretilir.', 'Jeolojik model ara degerleme urunudur; sondajlar arasindaki belirsizlik saha verisiyle kontrol edilmelidir.'].join('\r\n'))
    download(await zip.generateAsync({type:'blob',compression:'DEFLATE',compressionOptions:{level:6}}), 'evren-3d-model-v2-profesyonel-paket.zip')
  }

  if (!open) return null
  return <div className="underground-overlay u2-overlay" role="dialog" aria-modal="true" aria-label="3B Model V2 Profesyonel Studio">
    <section className="underground-shell u2-shell">
      <header className="underground-header"><div className="underground-title"><span className="underground-title-icon"><Layers3 size={23}/></span><div><small>EVREN GIS · JEOLOJİK MODELLEME</small><h2>3B Model V2 · Profesyonel Studio</h2></div></div><div className="u2-header-actions"><button type="button" onClick={reload} title="V1 verilerini yenile"><RefreshCw size={16}/></button><button type="button" className="underground-close" onClick={()=>setOpen(false)} aria-label="Kapat"><X size={20}/></button></div></header>
      <div className="underground-stats"><span><strong>{holes.length}</strong><small>Sondaj</small></span><span><strong>{terrain.length >= 3 ? 'Hazır' : 'Eksik'}</strong><small>Arazi yüzeyi</small></span><span><strong>{surfaceCount}</strong><small>Katman yüzeyi</small></span><span><strong>{sectionItems(holes).length >= 2 ? 'A–A′' : '—'}</strong><small>Jeolojik kesit</small></span></div>
      <nav className="underground-tabs u2-tabs">
        <button className={tab==='log'?'is-active':''} onClick={()=>setTab('log')}><Database size={15}/> Kuyu Logu</button>
        <button className={tab==='section'?'is-active':''} onClick={()=>setTab('section')}><Eye size={15}/> Jeolojik Kesit</button>
        <button className={tab==='terrain'?'is-active':''} onClick={()=>setTab('terrain')}><Box size={15}/> Gerçek Arazi</button>
        <button className={tab==='surfaces'?'is-active':''} onClick={()=>setTab('surfaces')}><Layers3 size={15}/> Katman Yüzeyleri</button>
        <button className={tab==='export'?'is-active':''} onClick={()=>setTab('export')}><FileArchive size={15}/> Pro DXF</button>
      </nav>
      <div className="underground-content u2-content">
        {!holes.length ? <div className="underground-empty"><AlertTriangle size={34}/><strong>V1 modelinde sondaj bulunamadı</strong><span>Önce “3B Model” ekranından sondaj, kot ve litoloji verilerini girin.</span></div> : null}
        {holes.length && tab==='log' ? <div className="u2-pane"><div className="u2-toolbar"><div><strong>Profesyonel Kuyu Logu</strong><small>Litoloji, derinlik, mutlak Z, su seviyesi ve kuyu bilgileri</small></div><select value={selected?.id || ''} onChange={(e)=>setSelectedId(e.target.value)}>{holes.map((h)=><option key={h.id} value={h.id}>{h.name}</option>)}</select></div><BoreholeLog hole={selected}/></div> : null}
        {holes.length && tab==='section' ? <div className="u2-pane"><div className="u2-toolbar"><div><strong>A–A′ Jeolojik Kesit</strong><small>En uzak iki sondaj arasında otomatik profil; diğer kuyular hatta izdüşürülür</small></div></div><SectionPreview holes={holes}/><div className="u2-info"><AlertTriangle size={15}/><span>Kesit korelasyonu sondajlardaki aynı litoloji adlarının tavan kotlarını bağlar. Sondajlar arası alan yorum/enterpolasyondur.</span></div></div> : null}
        {holes.length && tab==='terrain' ? <div className="u2-pane"><div className="u2-toolbar"><div><strong>Gerçek Arazi Yüzeyi</strong><small>Sondaj ağızlarının gerçek E/N/Z kotlarından IDW yüzey</small></div><span className="u2-badge">{terrain.length} kot noktası</span></div><SurfacePreview samples={terrain} title="Arazi / Topografya Yüzeyi" color="#62a47c"/><div className="u2-info"><AlertTriangle size={15}/><span>Bu yüzey DEM uydurmaz; yalnız girilmiş sondaj ağız kotlarını kullanır. Daha fazla kot noktası eklendikçe topoğrafik temsil güçlenir.</span></div></div> : null}
        {holes.length && tab==='surfaces' ? <div className="u2-pane"><div className="u2-toolbar"><div><strong>Litoloji Katman Yüzeyi</strong><small>Seçilen birimin tavan veya taban mutlak kotunu modelleyin</small></div><div className="u2-controls"><select value={selectedLithology} onChange={(e)=>setLithology(e.target.value)}>{lithologies.map((l)=><option key={l}>{l}</option>)}</select><select value={surfaceMode} onChange={(e)=>setSurfaceMode(e.target.value==='bottom'?'bottom':'top')}><option value="top">Tavan yüzeyi</option><option value="bottom">Taban yüzeyi</option></select></div></div>{selectedLithology ? <SurfacePreview samples={layerSamples} title={`${selectedLithology} · ${surfaceMode==='top'?'Tavan':'Taban'} Yüzeyi`} color={holes.flatMap((h)=>h.intervals).find((i)=>i.lithology===selectedLithology)?.color || '#8b6bb0'}/> : <div className="underground-empty"><Layers3 size={32}/><strong>Litoloji verisi yok</strong></div>}<div className="u2-surface-summary"><span><strong>{layerSamples.length}</strong><small>Kontrol noktası</small></span><span><strong>{layerSamples.length ? Math.min(...layerSamples.map((s)=>s.z)).toFixed(1) : '—'} m</strong><small>Min Z</small></span><span><strong>{layerSamples.length ? Math.max(...layerSamples.map((s)=>s.z)).toFixed(1) : '—'} m</strong><small>Maks Z</small></span></div></div> : null}
        {holes.length && tab==='export' ? <div className="underground-export-pane u2-export"><div className="underground-export-hero"><span><FileArchive size={28}/></span><div><small>NETCAD / NETPROMINE · PROFESYONEL V2</small><h3>Katmanlı 3B DXF Model Paketi</h3><p>Sondaj eksenleri, litoloji segmentleri, su seviyeleri, topografya 3DFACE yüzeyi, katman tavan yüzeyleri ve A–A′ hattını ayrı DXF katmanlarında üretir.</p></div></div><div className="u2-layer-list"><span>BH_COLLAR</span><span>BH_TRACE</span><span>BH_LABEL</span><span>WATER_LEVEL</span><span>TOPO_SURFACE</span><span>SECTION_AA</span><span>LITH_*</span><span>SURF_*</span></div><div className="underground-export-grid"><button type="button" onClick={()=>void exportPackage()}><FileArchive size={21}/><span><strong>V2 Profesyonel Paketi</strong><small>3B DXF + yüzey/kesit CSV + model yedeği</small></span></button><button type="button" onClick={()=>download(new Blob([professionalDxf(holes)],{type:'application/dxf;charset=utf-8'}),'evren-profesyonel-3d-v2.dxf')}><Download size={21}/><span><strong>Sadece Pro DXF</strong><small>Netcad için katmanlı 3DFACE model</small></span></button></div><div className="u2-info"><AlertTriangle size={15}/><span>Yüzeyler yalnız en az 3 sondaj kontrol noktası bulunan litolojiler için DXF’e eklenir. Bu yaklaşım veri olmayan bölgelerde sahte kesinlik üretmez.</span></div></div> : null}
      </div>
    </section>
  </div>
}
