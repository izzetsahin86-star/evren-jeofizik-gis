import { useEffect, useMemo, useState, type ChangeEvent } from 'react'
import JSZip from 'jszip'
import { AlertTriangle, Box, Database, Download, Eye, FileArchive, Layers3, RefreshCw, X } from 'lucide-react'
import './UndergroundModelFeature.css'
import './UndergroundModelV2Feature.css'

const STORAGE_KEY = 'evren-jeofizik-gis-underground-model-v1'
const OPEN_EVENT = 'evren-open-underground-model-v2'

type Tab = 'log' | 'section' | 'terrain' | 'surfaces' | 'export'
type SurfaceMode = 'top' | 'bottom'

type Interval = {
  id: string
  from: number
  to: number
  lithology: string
  note: string
  color: string
}

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

type Sample = { e: number; n: number; z: number; name: string }
type GridPoint = Sample & { row: number; col: number }
type SectionItem = Borehole & { distance: number; offset: number }

const finite = (value: unknown, fallback = 0) => {
  const parsed = Number(value)
  return Number.isFinite(parsed) ? parsed : fallback
}

function readBoreholes(): Borehole[] {
  try {
    const raw = JSON.parse(localStorage.getItem(STORAGE_KEY) || 'null') as { boreholes?: unknown[] } | null
    if (!raw || !Array.isArray(raw.boreholes)) return []
    return raw.boreholes.map((item, index) => {
      const value = item && typeof item === 'object' ? item as Record<string, unknown> : {}
      const intervalsRaw = Array.isArray(value.intervals) ? value.intervals : []
      const intervals: Interval[] = intervalsRaw.map((entry, intervalIndex) => {
        const interval = entry && typeof entry === 'object' ? entry as Record<string, unknown> : {}
        return {
          id: typeof interval.id === 'string' && interval.id ? interval.id : `lit-${index}-${intervalIndex}`,
          from: Math.max(0, finite(interval.from)),
          to: Math.max(0, finite(interval.to)),
          lithology: typeof interval.lithology === 'string' && interval.lithology.trim() ? interval.lithology.trim() : 'Bilinmiyor',
          note: typeof interval.note === 'string' ? interval.note : '',
          color: typeof interval.color === 'string' && interval.color ? interval.color : '#7890a3',
        }
      }).sort((a, b) => a.from - b.from)
      return {
        id: typeof value.id === 'string' && value.id ? value.id : `bh-${index}`,
        name: typeof value.name === 'string' && value.name.trim() ? value.name.trim() : `Sondaj ${index + 1}`,
        easting: finite(value.easting),
        northing: finite(value.northing),
        elevation: finite(value.elevation),
        zone: Math.max(1, Math.min(60, Math.round(finite(value.zone, 36)))),
        hemisphere: value.hemisphere === 'S' ? 'S' : 'N',
        totalDepth: Math.max(0, finite(value.totalDepth)),
        waterLevel: value.waterLevel === null || value.waterLevel === undefined || value.waterLevel === '' ? null : finite(value.waterLevel),
        temperature: value.temperature === null || value.temperature === undefined || value.temperature === '' ? null : finite(value.temperature),
        note: typeof value.note === 'string' ? value.note : '',
        intervals,
      }
    })
  } catch {
    return []
  }
}

function hasCoordinates(hole: Borehole) {
  return Number.isFinite(hole.easting) && Number.isFinite(hole.northing) && hole.easting !== 0 && hole.northing !== 0
}

function ascii(value: string) {
  return value.normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/ı/g, 'i').replace(/İ/g, 'I').replace(/[^A-Za-z0-9_-]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 28).toUpperCase() || 'MODEL'
}

function terrainSamples(holes: Borehole[]): Sample[] {
  return holes.filter(hasCoordinates).map((hole) => ({ e: hole.easting, n: hole.northing, z: hole.elevation, name: hole.name }))
}

function lithologyNames(holes: Borehole[]) {
  const names = new Set<string>()
  holes.forEach((hole) => hole.intervals.forEach((interval) => names.add(interval.lithology)))
  return Array.from(names)
}

function layerSamples(holes: Borehole[], lithology: string, mode: SurfaceMode): Sample[] {
  const result: Sample[] = []
  holes.forEach((hole) => {
    if (!hasCoordinates(hole)) return
    const interval = hole.intervals.find((item) => item.lithology === lithology)
    if (!interval) return
    const depth = mode === 'top' ? interval.from : interval.to
    result.push({ e: hole.easting, n: hole.northing, z: hole.elevation - depth, name: hole.name })
  })
  return result
}

function idw(e: number, n: number, samples: Sample[]) {
  let weighted = 0
  let totalWeight = 0
  for (const sample of samples) {
    const distanceSquared = (e - sample.e) ** 2 + (n - sample.n) ** 2
    if (distanceSquared < 0.000001) return sample.z
    const weight = 1 / distanceSquared
    weighted += sample.z * weight
    totalWeight += weight
  }
  return totalWeight ? weighted / totalWeight : 0
}

function makeGrid(samples: Sample[], size = 8): GridPoint[] {
  if (samples.length < 3) return []
  const minE0 = Math.min(...samples.map((sample) => sample.e))
  const maxE0 = Math.max(...samples.map((sample) => sample.e))
  const minN0 = Math.min(...samples.map((sample) => sample.n))
  const maxN0 = Math.max(...samples.map((sample) => sample.n))
  const padE = Math.max(10, (maxE0 - minE0) * 0.08)
  const padN = Math.max(10, (maxN0 - minN0) * 0.08)
  const minE = minE0 - padE
  const maxE = maxE0 + padE
  const minN = minN0 - padN
  const maxN = maxN0 + padN
  const grid: GridPoint[] = []
  for (let row = 0; row < size; row += 1) {
    for (let col = 0; col < size; col += 1) {
      const e = minE + (maxE - minE) * col / (size - 1)
      const n = minN + (maxN - minN) * row / (size - 1)
      grid.push({ e, n, z: idw(e, n, samples), name: '', row, col })
    }
  }
  return grid
}

function farthestPair(holes: Borehole[]): [Borehole, Borehole] | null {
  let first: Borehole | null = null
  let second: Borehole | null = null
  let best = -1
  for (let i = 0; i < holes.length; i += 1) {
    for (let j = i + 1; j < holes.length; j += 1) {
      const a = holes[i]
      const b = holes[j]
      if (!a || !b) continue
      const distance = Math.hypot(b.easting - a.easting, b.northing - a.northing)
      if (distance > best) {
        best = distance
        first = a
        second = b
      }
    }
  }
  return first && second ? [first, second] : null
}

function makeSection(holes: Borehole[]): SectionItem[] {
  const valid = holes.filter(hasCoordinates)
  const pair = farthestPair(valid)
  if (!pair) return []
  const [start, end] = pair
  const dx = end.easting - start.easting
  const dy = end.northing - start.northing
  const length = Math.max(1, Math.hypot(dx, dy))
  const ux = dx / length
  const uy = dy / length
  return valid.map((hole) => {
    const rx = hole.easting - start.easting
    const ry = hole.northing - start.northing
    return { ...hole, distance: rx * ux + ry * uy, offset: Math.abs(rx * -uy + ry * ux) }
  }).sort((a, b) => a.distance - b.distance)
}

function SurfaceView({ samples, title, color }: { samples: Sample[]; title: string; color: string }) {
  const grid = useMemo(() => makeGrid(samples), [samples])
  if (samples.length < 3 || grid.length === 0) {
    return <div className="underground-empty"><AlertTriangle size={32} /><strong>En az 3 kontrol noktası gerekiyor</strong><span>Yüzey yalnız gerçek E/N/Z verilerinden üretilir.</span></div>
  }
  const size = 8
  const minE = Math.min(...grid.map((point) => point.e))
  const maxE = Math.max(...grid.map((point) => point.e))
  const minN = Math.min(...grid.map((point) => point.n))
  const maxN = Math.max(...grid.map((point) => point.n))
  const minZ = Math.min(...grid.map((point) => point.z))
  const maxZ = Math.max(...grid.map((point) => point.z))
  const spanE = Math.max(1, maxE - minE)
  const spanN = Math.max(1, maxN - minN)
  const spanZ = Math.max(1, maxZ - minZ)
  const project = (point: GridPoint) => {
    const e = (point.e - minE) / spanE
    const n = (point.n - minN) / spanN
    const z = (point.z - minZ) / spanZ
    return { x: 100 + e * 520 + n * 145, y: 250 - n * 105 + e * 28 - z * 120 }
  }
  const cells: Array<{ key: string; points: string; opacity: number }> = []
  const at = (row: number, col: number) => grid[row * size + col]
  for (let row = size - 2; row >= 0; row -= 1) {
    for (let col = 0; col < size - 1; col += 1) {
      const a = at(row, col); const b = at(row, col + 1); const c = at(row + 1, col + 1); const d = at(row + 1, col)
      if (!a || !b || !c || !d) continue
      const pa = project(a); const pb = project(b); const pc = project(c); const pd = project(d)
      const averageZ = (a.z + b.z + c.z + d.z) / 4
      cells.push({ key: `${row}-${col}`, points: `${pa.x},${pa.y} ${pb.x},${pb.y} ${pc.x},${pc.y} ${pd.x},${pd.y}`, opacity: 0.2 + ((averageZ - minZ) / spanZ) * 0.5 })
    }
  }
  return <div className="underground-preview-card u2-surface-card"><svg viewBox="0 0 860 360" className="underground-preview-svg">
    {cells.map((cell) => <polygon key={cell.key} points={cell.points} fill={color} fillOpacity={cell.opacity} stroke="#486679" strokeWidth="0.8" />)}
    <text x="28" y="28" fill="#e8f4fb" fontSize="14" fontWeight="700">{title}</text>
    <text x="28" y="48" fill="#88a9bd" fontSize="10">IDW · {samples.length} kontrol noktası · Z {minZ.toFixed(1)}–{maxZ.toFixed(1)} m</text>
  </svg></div>
}

function WellLog({ hole }: { hole: Borehole | null }) {
  if (!hole) return <div className="underground-empty"><Database size={32} /><strong>Kuyu seçin</strong></div>
  const depth = Math.max(1, hole.totalDepth, ...hole.intervals.map((interval) => interval.to))
  const y = (value: number) => 55 + value / depth * 470
  return <div className="u2-log-wrap"><svg viewBox="0 0 720 590" className="u2-log-svg">
    <text x="28" y="28" fill="#eaf5fc" fontSize="15" fontWeight="700">{hole.name} · Kuyu Logu</text>
    <text x="28" y="45" fill="#87a9bc" fontSize="10">Kot {hole.elevation.toFixed(2)} m · Derinlik {hole.totalDepth.toFixed(2)} m · UTM {hole.zone}{hole.hemisphere}</text>
    {Array.from({ length: 11 }, (_, index) => index * depth / 10).map((d) => <g key={d}><line x1="65" y1={y(d)} x2="650" y2={y(d)} stroke="#29475b" strokeDasharray="3 6" /><text x="16" y={y(d)+4} fill="#91afc0" fontSize="9">{d.toFixed(0)} m</text></g>)}
    <rect x="90" y="55" width="190" height="470" fill="#0d1e2a" stroke="#426477" />
    {hole.intervals.map((interval) => <g key={interval.id}><rect x="90" y={y(interval.from)} width="190" height={Math.max(2, y(interval.to)-y(interval.from))} fill={interval.color} /><text x="300" y={(y(interval.from)+y(interval.to))/2+4} fill="#e7f2f8" fontSize="11" fontWeight="700">{interval.lithology}</text><text x="420" y={(y(interval.from)+y(interval.to))/2+4} fill="#90afc0" fontSize="9">{interval.from.toFixed(1)}–{interval.to.toFixed(1)} m · Z {(hole.elevation-interval.to).toFixed(1)} / {(hole.elevation-interval.from).toFixed(1)}</text></g>)}
    {hole.waterLevel !== null ? <g><line x1="80" y1={y(hole.waterLevel)} x2="295" y2={y(hole.waterLevel)} stroke="#51b9e8" strokeWidth="3" /><text x="300" y={y(hole.waterLevel)-5} fill="#70c9ef" fontSize="10">Su seviyesi {hole.waterLevel.toFixed(1)} m</text></g> : null}
  </svg></div>
}

function SectionView({ holes }: { holes: Borehole[] }) {
  const items = useMemo(() => makeSection(holes), [holes])
  if (items.length < 2) return <div className="underground-empty"><AlertTriangle size={32} /><strong>Kesit için en az 2 koordinatlı sondaj gerekiyor</strong></div>
  const minD = Math.min(...items.map((item) => item.distance))
  const maxD = Math.max(...items.map((item) => item.distance))
  const spanD = Math.max(1, maxD - minD)
  const maxZ = Math.max(...items.map((item) => item.elevation))
  const minZ = Math.min(...items.map((item) => item.elevation - item.totalDepth))
  const spanZ = Math.max(1, maxZ - minZ)
  const x = (distance: number) => 78 + (distance - minD) / spanD * 700
  const y = (z: number) => 55 + (maxZ - z) / spanZ * 430
  const names = lithologyNames(items)
  return <div className="u2-section-wrap"><svg viewBox="0 0 850 540" className="u2-section-svg">
    <text x="25" y="26" fill="#eaf5fc" fontSize="15" fontWeight="700">A – A′ Jeolojik Kesit</text>
    <text x="25" y="44" fill="#86a8ba" fontSize="10">Profil {spanD.toFixed(1)} m · Kot {minZ.toFixed(1)}–{maxZ.toFixed(1)} m</text>
    <polyline points={items.map((hole) => `${x(hole.distance)},${y(hole.elevation)}`).join(' ')} fill="none" stroke="#9ab6a0" strokeWidth="2.2" />
    {names.map((name) => {
      const points: string[] = []
      let color = '#7890a3'
      items.forEach((hole) => {
        const interval = hole.intervals.find((item) => item.lithology === name)
        if (!interval) return
        color = interval.color
        points.push(`${x(hole.distance)},${y(hole.elevation-interval.from)}`)
      })
      return points.length >= 2 ? <polyline key={name} points={points.join(' ')} fill="none" stroke={color} strokeWidth="2" strokeDasharray="6 4" /> : null
    })}
    {items.map((hole) => <g key={hole.id}>{hole.intervals.map((interval) => <rect key={interval.id} x={x(hole.distance)-5} y={y(hole.elevation-interval.from)} width="10" height={Math.max(2,y(hole.elevation-interval.to)-y(hole.elevation-interval.from))} fill={interval.color} />)}<text x={x(hole.distance)+7} y={y(hole.elevation)-5} fill="#e4f0f6" fontSize="9">{hole.name}</text></g>)}
    <text x="65" y="520" fill="#eaf5fc" fontSize="12">A</text><text x="790" y="520" fill="#eaf5fc" fontSize="12">A′</text>
  </svg></div>
}

function addLayer(values: string[], name: string, color: number) {
  values.push('0','LAYER','2',name,'70','0','62',String(color),'6','CONTINUOUS')
}

function addFace(values: string[], layer: string, a: GridPoint, b: GridPoint, c: GridPoint, d: GridPoint) {
  values.push('0','3DFACE','8',layer,'10',String(a.e),'20',String(a.n),'30',String(a.z),'11',String(b.e),'21',String(b.n),'31',String(b.z),'12',String(c.e),'22',String(c.n),'32',String(c.z),'13',String(d.e),'23',String(d.n),'33',String(d.z))
}

function professionalDxf(holes: Borehole[]) {
  const valid = holes.filter(hasCoordinates)
  const names = lithologyNames(valid)
  const layers = ['BH_COLLAR','BH_TRACE','BH_LABEL','WATER_LEVEL','TOPO_SURFACE','SECTION_AA',...names.map((name)=>`LITH_${ascii(name)}`),...names.map((name)=>`SURF_${ascii(name)}`)]
  const values: string[] = ['0','SECTION','2','HEADER','9','$ACADVER','1','AC1015','0','ENDSEC','0','SECTION','2','TABLES','0','TABLE','2','LAYER','70',String(layers.length)]
  layers.forEach((layer, index) => addLayer(values, layer, index < 4 ? 2 + index : 8))
  values.push('0','ENDTAB','0','ENDSEC','0','SECTION','2','ENTITIES')
  valid.forEach((hole) => {
    values.push('0','POINT','8','BH_COLLAR','10',String(hole.easting),'20',String(hole.northing),'30',String(hole.elevation))
    values.push('0','LINE','8','BH_TRACE','10',String(hole.easting),'20',String(hole.northing),'30',String(hole.elevation),'11',String(hole.easting),'21',String(hole.northing),'31',String(hole.elevation-hole.totalDepth))
    values.push('0','TEXT','8','BH_LABEL','10',String(hole.easting+2),'20',String(hole.northing+2),'30',String(hole.elevation+1),'40','2.5','1',ascii(hole.name))
    hole.intervals.forEach((interval) => values.push('0','LINE','8',`LITH_${ascii(interval.lithology)}`,'10',String(hole.easting),'20',String(hole.northing),'30',String(hole.elevation-interval.from),'11',String(hole.easting),'21',String(hole.northing),'31',String(hole.elevation-interval.to)))
    if (hole.waterLevel !== null) values.push('0','LINE','8','WATER_LEVEL','10',String(hole.easting-3),'20',String(hole.northing),'30',String(hole.elevation-hole.waterLevel),'11',String(hole.easting+3),'21',String(hole.northing),'31',String(hole.elevation-hole.waterLevel))
  })
  const addGrid = (grid: GridPoint[], layer: string) => {
    const size = 8
    if (grid.length !== size * size) return
    const at = (row: number, col: number) => grid[row * size + col]
    for (let row = 0; row < size - 1; row += 1) for (let col = 0; col < size - 1; col += 1) {
      const a=at(row,col), b=at(row,col+1), c=at(row+1,col+1), d=at(row+1,col)
      if (a && b && c && d) addFace(values,layer,a,b,c,d)
    }
  }
  addGrid(makeGrid(terrainSamples(valid)), 'TOPO_SURFACE')
  names.forEach((name) => addGrid(makeGrid(layerSamples(valid,name,'top')), `SURF_${ascii(name)}`))
  const pair = farthestPair(valid)
  if (pair) values.push('0','LINE','8','SECTION_AA','10',String(pair[0].easting),'20',String(pair[0].northing),'30',String(pair[0].elevation),'11',String(pair[1].easting),'21',String(pair[1].northing),'31',String(pair[1].elevation))
  values.push('0','ENDSEC','0','EOF')
  return values.join('\r\n')
}

function csvCell(value: unknown) { return `"${String(value ?? '').replace(/"/g,'""')}"` }
function rowsCsv(rows: unknown[][]) { return '\ufeff' + rows.map((row) => row.map(csvCell).join(';')).join('\r\n') }
function surfaceCsv(holes: Borehole[]) {
  const rows: unknown[][] = [['SONDAJ','EASTING','NORTHING','COLLAR_Z','LITOLOJI','TAVAN_Z','TABAN_Z']]
  holes.filter(hasCoordinates).forEach((hole) => hole.intervals.forEach((interval) => rows.push([hole.name,hole.easting.toFixed(3),hole.northing.toFixed(3),hole.elevation.toFixed(3),interval.lithology,(hole.elevation-interval.from).toFixed(3),(hole.elevation-interval.to).toFixed(3)])))
  return rowsCsv(rows)
}
function sectionCsv(holes: Borehole[]) {
  const rows: unknown[][] = [['SONDAJ','PROFIL_M','HAT_OFSET_M','EASTING','NORTHING','KOT_Z','DERINLIK_M']]
  makeSection(holes).forEach((hole) => rows.push([hole.name,hole.distance.toFixed(3),hole.offset.toFixed(3),hole.easting.toFixed(3),hole.northing.toFixed(3),hole.elevation.toFixed(3),hole.totalDepth.toFixed(2)]))
  return rowsCsv(rows)
}
function download(blob: Blob, fileName: string) {
  const url = URL.createObjectURL(blob)
  const link = document.createElement('a')
  link.href = url
  link.download = fileName
  document.body.appendChild(link)
  link.click()
  link.remove()
  window.setTimeout(() => URL.revokeObjectURL(url), 500)
}

export default function UndergroundModelV2Feature() {
  const [open, setOpen] = useState(false)
  const [tab, setTab] = useState<Tab>('log')
  const [holes, setHoles] = useState<Borehole[]>(readBoreholes)
  const [selectedId, setSelectedId] = useState('')
  const [selectedLithology, setSelectedLithology] = useState('')
  const [surfaceMode, setSurfaceMode] = useState<SurfaceMode>('top')

  const names = useMemo(() => lithologyNames(holes), [holes])
  const selected = holes.find((hole) => hole.id === selectedId) ?? holes[0] ?? null
  const activeLithology = selectedLithology && names.includes(selectedLithology) ? selectedLithology : names[0] ?? ''
  const terrain = useMemo(() => terrainSamples(holes), [holes])
  const currentLayer = useMemo(() => activeLithology ? layerSamples(holes,activeLithology,surfaceMode) : [], [holes,activeLithology,surfaceMode])
  const surfaceCount = useMemo(() => names.filter((name) => layerSamples(holes,name,'top').length >= 3).length, [holes,names])
  const sectionReady = useMemo(() => makeSection(holes).length >= 2, [holes])

  const reload = () => {
    const next = readBoreholes()
    setHoles(next)
    if (!next.some((hole) => hole.id === selectedId)) setSelectedId(next[0]?.id ?? '')
  }

  useEffect(() => {
    const show = () => { reload(); setOpen(true) }
    window.addEventListener(OPEN_EVENT, show)
    return () => window.removeEventListener(OPEN_EVENT, show)
  }, [selectedId])

  useEffect(() => {
    if (!open) return
    const previous = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    const close = (event: KeyboardEvent) => { if (event.key === 'Escape') setOpen(false) }
    window.addEventListener('keydown', close)
    return () => { document.body.style.overflow = previous; window.removeEventListener('keydown', close) }
  }, [open])

  const exportPackage = async () => {
    const zip = new JSZip()
    zip.file('evren-profesyonel-3d-v2.dxf', professionalDxf(holes))
    zip.file('katman-yuzey-kontrol-noktalari.csv', surfaceCsv(holes))
    zip.file('AA-jeolojik-kesit.csv', sectionCsv(holes))
    zip.file('evren-3d-model-v1-veri.json', localStorage.getItem(STORAGE_KEY) || JSON.stringify({ version: 1, boreholes: holes }, null, 2))
    zip.file('OKU-BENI-V2.txt', 'EVREN GIS 3B MODEL V2\r\n\r\nDXF katmanlari: BH_COLLAR, BH_TRACE, BH_LABEL, WATER_LEVEL, TOPO_SURFACE, SECTION_AA, LITH_*, SURF_*.\r\nTOPO_SURFACE sondaj agiz kotlarindan IDW ile uretilir. SURF_* litoloji tavan kotlarindan, en az 3 sondaj varsa uretilir.\r\nModel sondajlar arasi enterpolasyondur; saha verisiyle kontrol edilmelidir.')
    const blob = await zip.generateAsync({ type: 'blob', compression: 'DEFLATE', compressionOptions: { level: 6 } })
    download(blob, 'evren-3d-model-v2-profesyonel-paket.zip')
  }

  if (!open) return null
  return <div className="underground-overlay u2-overlay" role="dialog" aria-modal="true" aria-label="3B Model V2 Profesyonel Studio"><section className="underground-shell u2-shell">
    <header className="underground-header"><div className="underground-title"><span className="underground-title-icon"><Layers3 size={23}/></span><div><small>EVREN GIS · JEOLOJİK MODELLEME</small><h2>3B Model V2 · Profesyonel Studio</h2></div></div><div className="u2-header-actions"><button type="button" onClick={reload} title="V1 verilerini yenile"><RefreshCw size={16}/></button><button type="button" className="underground-close" onClick={()=>setOpen(false)}><X size={20}/></button></div></header>
    <div className="underground-stats"><span><strong>{holes.length}</strong><small>Sondaj</small></span><span><strong>{terrain.length>=3?'Hazır':'Eksik'}</strong><small>Arazi yüzeyi</small></span><span><strong>{surfaceCount}</strong><small>Katman yüzeyi</small></span><span><strong>{sectionReady?'A–A′':'—'}</strong><small>Jeolojik kesit</small></span></div>
    <nav className="underground-tabs u2-tabs"><button className={tab==='log'?'is-active':''} onClick={()=>setTab('log')}><Database size={15}/> Kuyu Logu</button><button className={tab==='section'?'is-active':''} onClick={()=>setTab('section')}><Eye size={15}/> Jeolojik Kesit</button><button className={tab==='terrain'?'is-active':''} onClick={()=>setTab('terrain')}><Box size={15}/> Gerçek Arazi</button><button className={tab==='surfaces'?'is-active':''} onClick={()=>setTab('surfaces')}><Layers3 size={15}/> Katman Yüzeyleri</button><button className={tab==='export'?'is-active':''} onClick={()=>setTab('export')}><FileArchive size={15}/> Pro DXF</button></nav>
    <div className="underground-content u2-content">
      {holes.length===0 ? <div className="underground-empty"><AlertTriangle size={34}/><strong>V1 modelinde sondaj bulunamadı</strong><span>Önce “3B Model” ekranından sondaj, kot ve litoloji verilerini girin.</span></div> : null}
      {holes.length>0 && tab==='log' ? <div className="u2-pane"><div className="u2-toolbar"><div><strong>Profesyonel Kuyu Logu</strong><small>Litoloji, derinlik, mutlak Z ve su seviyesi</small></div><select value={selected?.id ?? ''} onChange={(event: ChangeEvent<HTMLSelectElement>)=>setSelectedId(event.target.value)}>{holes.map((hole)=><option key={hole.id} value={hole.id}>{hole.name}</option>)}</select></div><WellLog hole={selected}/></div> : null}
      {holes.length>0 && tab==='section' ? <div className="u2-pane"><div className="u2-toolbar"><div><strong>A–A′ Jeolojik Kesit</strong><small>En uzak iki sondaj arasında otomatik profil</small></div></div><SectionView holes={holes}/><div className="u2-info"><AlertTriangle size={15}/><span>Sondajlar arası çizgiler korelasyon/enterpolasyondur; saha verisi ile kontrol edilmelidir.</span></div></div> : null}
      {holes.length>0 && tab==='terrain' ? <div className="u2-pane"><div className="u2-toolbar"><div><strong>Gerçek Arazi Yüzeyi</strong><small>Sondaj ağızlarının gerçek E/N/Z kotlarından IDW yüzey</small></div><span className="u2-badge">{terrain.length} kot noktası</span></div><SurfaceView samples={terrain} title="Arazi / Topografya Yüzeyi" color="#62a47c"/><div className="u2-info"><AlertTriangle size={15}/><span>Bu sürüm DEM uydurmaz; yalnız girilmiş sondaj ağız kotlarını kullanır.</span></div></div> : null}
      {holes.length>0 && tab==='surfaces' ? <div className="u2-pane"><div className="u2-toolbar"><div><strong>Litoloji Katman Yüzeyi</strong><small>Birimin tavan veya taban mutlak Z kotunu modelleyin</small></div><div className="u2-controls"><select value={activeLithology} onChange={(event: ChangeEvent<HTMLSelectElement>)=>setSelectedLithology(event.target.value)}>{names.map((name)=><option key={name}>{name}</option>)}</select><select value={surfaceMode} onChange={(event: ChangeEvent<HTMLSelectElement>)=>setSurfaceMode(event.target.value==='bottom'?'bottom':'top')}><option value="top">Tavan yüzeyi</option><option value="bottom">Taban yüzeyi</option></select></div></div>{activeLithology ? <SurfaceView samples={currentLayer} title={`${activeLithology} · ${surfaceMode==='top'?'Tavan':'Taban'} Yüzeyi`} color={holes.flatMap((hole)=>hole.intervals).find((interval)=>interval.lithology===activeLithology)?.color ?? '#8b6bb0'}/> : <div className="underground-empty"><Layers3 size={32}/><strong>Litoloji verisi yok</strong></div>}</div> : null}
      {holes.length>0 && tab==='export' ? <div className="underground-export-pane u2-export"><div className="underground-export-hero"><span><FileArchive size={28}/></span><div><small>NETCAD / NETPROMINE · V2</small><h3>Profesyonel Katmanlı 3B DXF</h3><p>Sondaj, su seviyesi, topoğrafya 3DFACE, litoloji ve katman tavan yüzeyleri ayrı DXF katmanlarında.</p></div></div><div className="u2-layer-list"><span>BH_COLLAR</span><span>BH_TRACE</span><span>BH_LABEL</span><span>WATER_LEVEL</span><span>TOPO_SURFACE</span><span>SECTION_AA</span><span>LITH_*</span><span>SURF_*</span></div><div className="underground-export-grid"><button type="button" onClick={()=>void exportPackage()}><FileArchive size={21}/><span><strong>V2 Profesyonel Paket</strong><small>DXF + kesit/yüzey CSV + JSON</small></span></button><button type="button" onClick={()=>download(new Blob([professionalDxf(holes)],{type:'application/dxf;charset=utf-8'}),'evren-profesyonel-3d-v2.dxf')}><Download size={21}/><span><strong>Sadece Pro DXF</strong><small>Katmanlı 3DFACE model</small></span></button></div></div> : null}
    </div>
  </section></div>
}
