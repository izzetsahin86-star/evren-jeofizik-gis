import { useEffect, useMemo, useRef, useState, type ChangeEvent } from 'react'
import JSZip from 'jszip'
import {
  Activity,
  AlertTriangle,
  CheckCircle2,
  Database,
  Download,
  FileSpreadsheet,
  MapPin,
  Save,
  Trash2,
  Upload,
  X,
} from 'lucide-react'
import './DESAnalysisFeature.css'

const STORAGE_KEY = 'evren-jeofizik-gis-des-analysis-v1'
const OPEN_EVENT = 'evren-open-des-analysis'

type DesTab = 'data' | 'curve' | 'quality'
type CellValue = string | number | null

type DesMeasurement = {
  ab2: number
  mn: number
  current: number | null
  voltage: number | null
  k: number | null
  rho: number
}

type DesRecord = {
  id: string
  name: string
  number: number | null
  fileName: string
  province: string
  district: string
  easting: number | null
  northing: number | null
  elevation: number | null
  zone: number
  hemisphere: 'N' | 'S'
  note: string
  measurements: DesMeasurement[]
  importedAt: number
  updatedAt: number
}

type RepeatCheck = {
  ab2: number
  values: DesMeasurement[]
  differencePct: number
}

function uid() {
  return `des-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`
}

function fold(value: unknown) {
  return String(value ?? '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/ı/g, 'i')
    .replace(/İ/g, 'i')
    .replace(/ş/g, 's')
    .replace(/Ş/g, 's')
    .replace(/ğ/g, 'g')
    .replace(/Ğ/g, 'g')
    .replace(/ç/g, 'c')
    .replace(/Ç/g, 'c')
    .replace(/ö/g, 'o')
    .replace(/Ö/g, 'o')
    .replace(/ü/g, 'u')
    .replace(/Ü/g, 'u')
    .trim()
    .toLowerCase()
}

function finiteOrNull(value: unknown) {
  if (value === '' || value === null || value === undefined) return null
  const number = Number(String(value).replace(',', '.'))
  return Number.isFinite(number) ? number : null
}

function normalizeRecord(value: Partial<DesRecord>, index: number): DesRecord | null {
  if (!Array.isArray(value.measurements)) return null
  const measurements = value.measurements
    .map((item) => ({
      ab2: Number(item.ab2),
      mn: Number(item.mn),
      current: finiteOrNull(item.current),
      voltage: finiteOrNull(item.voltage),
      k: finiteOrNull(item.k),
      rho: Number(item.rho),
    }))
    .filter((item) => Number.isFinite(item.ab2) && item.ab2 > 0 && Number.isFinite(item.rho) && item.rho > 0)
  if (!measurements.length) return null
  const number = finiteOrNull(value.number)
  return {
    id: typeof value.id === 'string' && value.id ? value.id : uid(),
    name: typeof value.name === 'string' && value.name.trim() ? value.name.trim() : `DES ${number ?? index + 1}`,
    number,
    fileName: typeof value.fileName === 'string' ? value.fileName : '',
    province: typeof value.province === 'string' ? value.province : '',
    district: typeof value.district === 'string' ? value.district : '',
    easting: finiteOrNull(value.easting),
    northing: finiteOrNull(value.northing),
    elevation: finiteOrNull(value.elevation),
    zone: Math.max(1, Math.min(60, Math.round(Number(value.zone) || 36))),
    hemisphere: value.hemisphere === 'S' ? 'S' : 'N',
    note: typeof value.note === 'string' ? value.note : '',
    measurements,
    importedAt: Number(value.importedAt) || Date.now(),
    updatedAt: Number(value.updatedAt) || Date.now(),
  }
}

function readRecords() {
  try {
    const raw = JSON.parse(localStorage.getItem(STORAGE_KEY) || '[]') as Partial<DesRecord>[]
    if (!Array.isArray(raw)) return []
    return raw.map(normalizeRecord).filter((item): item is DesRecord => Boolean(item))
  } catch {
    return []
  }
}

function columnIndex(address: string) {
  const letters = address.match(/[A-Z]+/i)?.[0]?.toUpperCase() || 'A'
  let result = 0
  for (let index = 0; index < letters.length; index += 1) result = result * 26 + letters.charCodeAt(index) - 64
  return result - 1
}

function sharedStringsFromXml(xml: string) {
  const doc = new DOMParser().parseFromString(xml, 'application/xml')
  return Array.from(doc.getElementsByTagName('si')).map((item) => (
    Array.from(item.getElementsByTagName('t')).map((node) => node.textContent || '').join('')
  ))
}

function cellValue(cell: Element, sharedStrings: string[]): CellValue {
  const type = cell.getAttribute('t') || ''
  if (type === 'inlineStr') {
    return Array.from(cell.getElementsByTagName('t')).map((node) => node.textContent || '').join('')
  }
  const raw = cell.getElementsByTagName('v')[0]?.textContent
  if (raw === null || raw === undefined) return null
  if (type === 's') return sharedStrings[Number(raw)] ?? ''
  if (type === 'str' || type === 'e') return raw
  if (type === 'b') return raw === '1' ? 1 : 0
  const number = Number(raw)
  return Number.isFinite(number) ? number : raw
}

function rowsFromSheet(xml: string, sharedStrings: string[]) {
  const doc = new DOMParser().parseFromString(xml, 'application/xml')
  const rows = new Map<number, Map<number, CellValue>>()
  Array.from(doc.getElementsByTagName('row')).forEach((rowNode) => {
    const rowNumber = Number(rowNode.getAttribute('r')) || rows.size + 1
    const columns = new Map<number, CellValue>()
    Array.from(rowNode.getElementsByTagName('c')).forEach((cell) => {
      const address = cell.getAttribute('r') || 'A1'
      columns.set(columnIndex(address), cellValue(cell, sharedStrings))
    })
    rows.set(rowNumber, columns)
  })
  return rows
}

function findHeader(rows: Map<number, Map<number, CellValue>>) {
  for (const [rowNumber, columns] of rows) {
    let ab2: number | null = null
    let mn: number | null = null
    let current: number | null = null
    let voltage: number | null = null
    let k: number | null = null
    let rho: number | null = null
    for (const [column, value] of columns) {
      const text = fold(value).replace(/\s+/g, '')
      if (text === 'ab/2' || text === 'ab2') ab2 = column
      else if (text === 'mn' || text === 'mn/2') mn = column
      else if (text === 'i') current = column
      else if (text === 'v') voltage = column
      else if (text === 'k') k = column
      else if (text === 'r' || text === 'rho' || text.includes('ozdirenc')) rho = column
    }
    if (ab2 !== null && mn !== null && rho !== null) return { rowNumber, ab2, mn, current, voltage, k, rho }
  }
  return null
}

function cellBelowLabel(rows: Map<number, Map<number, CellValue>>, label: string) {
  for (const [rowNumber, columns] of rows) {
    for (const [column, value] of columns) {
      if (fold(value) !== label) continue
      const below = rows.get(rowNumber + 1)?.get(column)
      if (typeof below === 'string' && below.trim()) return below.trim()
    }
  }
  return ''
}

function numberRightOfLabel(rows: Map<number, Map<number, CellValue>>, label: string, distance = 4) {
  for (const [, columns] of rows) {
    for (const [column, value] of columns) {
      if (fold(value) !== label) continue
      for (let offset = 1; offset <= distance; offset += 1) {
        const number = finiteOrNull(columns.get(column + offset))
        if (number !== null) return number
      }
    }
  }
  return null
}

async function parseDesWorkbook(file: File): Promise<DesRecord> {
  if (!file.name.toLowerCase().endsWith('.xlsx')) throw new Error('Bu sürüm .xlsx Excel dosyalarını destekliyor.')
  const zip = await JSZip.loadAsync(await file.arrayBuffer())
  const sharedEntry = zip.file('xl/sharedStrings.xml')
  const sharedStrings = sharedEntry ? sharedStringsFromXml(await sharedEntry.async('text')) : []
  const sheetNames = Object.keys(zip.files).filter((name) => /^xl\/worksheets\/sheet\d+\.xml$/i.test(name)).sort()
  if (!sheetNames.length) throw new Error('Excel içinde çalışma sayfası bulunamadı.')

  let rows: Map<number, Map<number, CellValue>> | null = null
  let header: ReturnType<typeof findHeader> = null
  for (const sheetName of sheetNames) {
    const entry = zip.file(sheetName)
    if (!entry) continue
    const candidateRows = rowsFromSheet(await entry.async('text'), sharedStrings)
    const candidateHeader = findHeader(candidateRows)
    if (candidateHeader) {
      rows = candidateRows
      header = candidateHeader
      break
    }
  }
  if (!rows || !header) throw new Error('AB/2, MN ve r sütunları bulunamadı. DES Excel formatını kontrol edin.')

  const measurements: DesMeasurement[] = []
  Array.from(rows.entries()).sort((a, b) => a[0] - b[0]).forEach(([rowNumber, columns]) => {
    if (rowNumber <= header!.rowNumber) return
    const ab2 = finiteOrNull(columns.get(header!.ab2))
    const mn = finiteOrNull(columns.get(header!.mn))
    const rho = finiteOrNull(columns.get(header!.rho))
    if (ab2 === null || ab2 <= 0 || mn === null || mn <= 0 || rho === null || rho <= 0) return
    measurements.push({
      ab2,
      mn,
      current: header!.current === null ? null : finiteOrNull(columns.get(header!.current)),
      voltage: header!.voltage === null ? null : finiteOrNull(columns.get(header!.voltage)),
      k: header!.k === null ? null : finiteOrNull(columns.get(header!.k)),
      rho,
    })
  })
  if (measurements.length < 3) throw new Error('Yeterli geçerli DES ölçümü bulunamadı.')

  const desNumberFromSheet = numberRightOfLabel(rows, 'des')
  const desNumberFromFile = finiteOrNull(file.name.match(/des\D*(\d+)/i)?.[1])
  const desNumber = desNumberFromSheet ?? desNumberFromFile
  const easting = numberRightOfLabel(rows, 'y', 3)
  const northing = numberRightOfLabel(rows, 'x', 3)
  return {
    id: uid(),
    name: desNumber !== null ? `DES ${desNumber}` : file.name.replace(/\.xlsx$/i, ''),
    number: desNumber,
    fileName: file.name,
    province: cellBelowLabel(rows, 'ili'),
    district: cellBelowLabel(rows, 'ilcesi'),
    easting,
    northing,
    elevation: null,
    zone: 36,
    hemisphere: 'N',
    note: '',
    measurements,
    importedAt: Date.now(),
    updatedAt: Date.now(),
  }
}

function repeatChecks(record: DesRecord): RepeatCheck[] {
  const groups = new Map<number, DesMeasurement[]>()
  record.measurements.forEach((item) => groups.set(item.ab2, [...(groups.get(item.ab2) || []), item]))
  return Array.from(groups.entries())
    .filter(([, values]) => values.length > 1)
    .map(([ab2, values]) => {
      const rhos = values.map((item) => item.rho)
      const mean = rhos.reduce((sum, value) => sum + value, 0) / rhos.length
      const differencePct = mean > 0 ? ((Math.max(...rhos) - Math.min(...rhos)) / mean) * 100 : 0
      return { ab2, values, differencePct }
    })
    .sort((a, b) => a.ab2 - b.ab2)
}

function formulaChecks(record: DesRecord) {
  const valid = record.measurements.flatMap((item) => {
    if (item.current === null || item.voltage === null || item.k === null || item.current === 0) return []
    const calculated = item.k * item.voltage / item.current
    if (!Number.isFinite(calculated) || item.rho <= 0) return []
    const differencePct = Math.abs(calculated - item.rho) / item.rho * 100
    return [{ ...item, calculated, differencePct }]
  })
  const mismatches = valid.filter((item) => item.differencePct > 1)
  const maxDifference = valid.length ? Math.max(...valid.map((item) => item.differencePct)) : 0
  return { checked: valid.length, mismatches, maxDifference }
}

function qualityInfo(record: DesRecord) {
  const repeats = repeatChecks(record)
  const formulas = formulaChecks(record)
  const maxRepeat = repeats.length ? Math.max(...repeats.map((item) => item.differencePct)) : 0
  const coordinateReady = record.easting !== null && record.northing !== null
  if (formulas.mismatches.length || maxRepeat > 10) return { tone: 'danger', label: 'Kontrol gerekli', repeats, formulas, maxRepeat, coordinateReady }
  if (maxRepeat > 5) return { tone: 'warning', label: 'İyi · tekrar kontrolü', repeats, formulas, maxRepeat, coordinateReady }
  return { tone: 'good', label: 'İyi', repeats, formulas, maxRepeat, coordinateReady }
}

function niceLogTicks(min: number, max: number) {
  const values: number[] = []
  const start = Math.floor(Math.log10(min)) - 1
  const end = Math.ceil(Math.log10(max)) + 1
  for (let power = start; power <= end; power += 1) {
    ;[1, 2, 5].forEach((multiplier) => {
      const value = multiplier * 10 ** power
      if (value >= min && value <= max) values.push(value)
    })
  }
  return values
}

function ResistivityCurve({ record }: { record: DesRecord }) {
  const data = record.measurements.filter((item) => item.ab2 > 0 && item.rho > 0)
  if (!data.length) return null
  const minX = Math.min(...data.map((item) => item.ab2)) * 0.9
  const maxX = Math.max(...data.map((item) => item.ab2)) * 1.1
  const minY = Math.min(...data.map((item) => item.rho)) * 0.85
  const maxY = Math.max(...data.map((item) => item.rho)) * 1.15
  const width = 860
  const height = 430
  const left = 76
  const right = 28
  const top = 28
  const bottom = 62
  const innerW = width - left - right
  const innerH = height - top - bottom
  const lx0 = Math.log10(minX)
  const lx1 = Math.log10(maxX)
  const ly0 = Math.log10(minY)
  const ly1 = Math.log10(maxY)
  const x = (value: number) => left + (Math.log10(value) - lx0) / (lx1 - lx0) * innerW
  const y = (value: number) => top + (ly1 - Math.log10(value)) / (ly1 - ly0) * innerH
  const xTicks = niceLogTicks(minX, maxX)
  const yTicks = niceLogTicks(minY, maxY)
  const mnValues = Array.from(new Set(data.map((item) => item.mn))).sort((a, b) => a - b)
  const strokes = ['#38bdf8', '#f59e0b', '#10b981', '#f472b6']

  return (
    <div className="des-chart-card">
      <svg viewBox={`0 0 ${width} ${height}`} className="des-chart" role="img" aria-label={`${record.name} görünür özdirenç eğrisi`}>
        <rect x={left} y={top} width={innerW} height={innerH} className="des-chart-bg" />
        {xTicks.map((tick) => <g key={`x-${tick}`}><line x1={x(tick)} y1={top} x2={x(tick)} y2={top + innerH} className="des-grid" /><text x={x(tick)} y={height - 34} textAnchor="middle" className="des-axis-text">{tick}</text></g>)}
        {yTicks.map((tick) => <g key={`y-${tick}`}><line x1={left} y1={y(tick)} x2={left + innerW} y2={y(tick)} className="des-grid" /><text x={left - 12} y={y(tick) + 4} textAnchor="end" className="des-axis-text">{tick}</text></g>)}
        {mnValues.map((mn, groupIndex) => {
          const group = data.filter((item) => item.mn === mn).sort((a, b) => a.ab2 - b.ab2)
          const points = group.map((item) => `${x(item.ab2)},${y(item.rho)}`).join(' ')
          const stroke = strokes[groupIndex % strokes.length]
          return <g key={mn}><polyline points={points} fill="none" stroke={stroke} strokeWidth="2.4" strokeLinejoin="round" strokeLinecap="round" />{group.map((item, index) => <circle key={`${mn}-${item.ab2}-${index}`} cx={x(item.ab2)} cy={y(item.rho)} r="4" fill={stroke} stroke="#07131f" strokeWidth="1.5"><title>{`AB/2 ${item.ab2} m · MN ${item.mn} m · ρa ${item.rho.toFixed(2)} Ωm`}</title></circle>)}</g>
        })}
        <line x1={left} y1={top + innerH} x2={left + innerW} y2={top + innerH} className="des-axis" />
        <line x1={left} y1={top} x2={left} y2={top + innerH} className="des-axis" />
        <text x={left + innerW / 2} y={height - 8} textAnchor="middle" className="des-axis-title">AB/2 (m) · Log ölçek</text>
        <text transform={`translate(20 ${top + innerH / 2}) rotate(-90)`} textAnchor="middle" className="des-axis-title">Görünür özdirenç ρa (Ωm) · Log ölçek</text>
      </svg>
      <div className="des-chart-legend">{mnValues.map((mn, index) => <span key={mn}><i style={{ background: strokes[index % strokes.length] }} />MN = {mn} m</span>)}</div>
      <p className="des-chart-note">Ham görünür özdirenç eğrisi gösterilir. MN grupları ayrı çizilir; bu V1 ekranında inversiyon veya litoloji tahmini uygulanmaz.</p>
    </div>
  )
}

function downloadJson(records: DesRecord[]) {
  const blob = new Blob([JSON.stringify({ version: 1, records }, null, 2)], { type: 'application/json;charset=utf-8' })
  const url = URL.createObjectURL(blob)
  const link = document.createElement('a')
  link.href = url
  link.download = 'evren-des-analiz-yedek.json'
  document.body.appendChild(link)
  link.click()
  link.remove()
  window.setTimeout(() => URL.revokeObjectURL(url), 500)
}

export default function DESAnalysisFeature() {
  const [open, setOpen] = useState(false)
  const [tab, setTab] = useState<DesTab>('data')
  const [records, setRecords] = useState<DesRecord[]>(readRecords)
  const [selectedId, setSelectedId] = useState<string | null>(() => readRecords()[0]?.id ?? null)
  const [status, setStatus] = useState('')
  const [busy, setBusy] = useState(false)
  const fileInputRef = useRef<HTMLInputElement | null>(null)
  const selected = records.find((record) => record.id === selectedId) ?? records[0] ?? null

  useEffect(() => {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(records))
    window.dispatchEvent(new CustomEvent('evren-des-analysis-changed'))
  }, [records])

  useEffect(() => {
    const show = () => { setOpen(true); setStatus('') }
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

  useEffect(() => {
    if (selectedId && records.some((record) => record.id === selectedId)) return
    setSelectedId(records[0]?.id ?? null)
  }, [records, selectedId])

  const totalMeasurements = useMemo(() => records.reduce((sum, record) => sum + record.measurements.length, 0), [records])
  const readyCount = useMemo(() => records.filter((record) => record.easting !== null && record.northing !== null).length, [records])
  const attentionCount = useMemo(() => records.filter((record) => qualityInfo(record).tone !== 'good').length, [records])

  const updateSelected = (patch: Partial<DesRecord>) => {
    if (!selected) return
    setRecords((current) => current.map((record) => record.id === selected.id ? { ...record, ...patch, updatedAt: Date.now() } : record))
  }

  const importFiles = async (event: ChangeEvent<HTMLInputElement>) => {
    const files = Array.from(event.target.files || [])
    event.target.value = ''
    if (!files.length) return
    setBusy(true)
    const imported: DesRecord[] = []
    const errors: string[] = []
    for (const file of files) {
      try { imported.push(await parseDesWorkbook(file)) }
      catch (error) { errors.push(`${file.name}: ${error instanceof Error ? error.message : 'okunamadı'}`) }
    }
    if (imported.length) {
      setRecords((current) => {
        const next = [...current]
        imported.forEach((record) => {
          const index = next.findIndex((item) => item.fileName === record.fileName && item.number === record.number)
          if (index >= 0) next[index] = { ...record, id: next[index].id, easting: next[index].easting ?? record.easting, northing: next[index].northing ?? record.northing, elevation: next[index].elevation, zone: next[index].zone, hemisphere: next[index].hemisphere, note: next[index].note }
          else next.push(record)
        })
        return next
      })
      setSelectedId(imported[0].id)
      setTab('curve')
    }
    const successText = imported.length ? `${imported.length} DES Excel dosyası başarıyla okundu.` : ''
    const errorText = errors.length ? ` ${errors.join(' · ')}` : ''
    setStatus(`${successText}${errorText}`.trim())
    setBusy(false)
  }

  const removeSelected = () => {
    if (!selected || !window.confirm(`${selected.name} kaydı silinsin mi?`)) return
    setRecords((current) => current.filter((record) => record.id !== selected.id))
    setStatus(`${selected.name} silindi.`)
  }

  if (!open) return null
  const quality = selected ? qualityInfo(selected) : null
  const rhoValues = selected?.measurements.map((item) => item.rho) || []

  return (
    <div className="des-overlay" role="dialog" aria-modal="true" aria-label="DES Analiz">
      <section className="des-shell">
        <header className="des-header">
          <div className="des-title"><span><Activity size={23} /></span><div><small>EVREN GIS · JEOFİZİK</small><h2>DES Analiz</h2></div></div>
          <button type="button" className="des-close" onClick={() => setOpen(false)} aria-label="DES analizi kapat"><X size={20} /></button>
        </header>

        <div className="des-stats">
          <span><strong>{records.length}</strong><small>DES noktası</small></span>
          <span><strong>{totalMeasurements}</strong><small>Ölçüm</small></span>
          <span><strong>{readyCount}</strong><small>Konum hazır</small></span>
          <span className={attentionCount ? 'has-issue' : ''}><strong>{attentionCount}</strong><small>Kontrol</small></span>
        </div>

        <nav className="des-tabs">
          <button type="button" className={tab === 'data' ? 'is-active' : ''} onClick={() => setTab('data')}><Database size={16} /> Veriler</button>
          <button type="button" className={tab === 'curve' ? 'is-active' : ''} onClick={() => setTab('curve')}><Activity size={16} /> Eğri</button>
          <button type="button" className={tab === 'quality' ? 'is-active' : ''} onClick={() => setTab('quality')}><CheckCircle2 size={16} /> Kalite</button>
        </nav>

        <div className="des-content">
          <aside className="des-list-pane">
            <div className="des-import-actions">
              <button type="button" className="primary" disabled={busy} onClick={() => fileInputRef.current?.click()}><Upload size={16} /> {busy ? 'Okunuyor…' : 'Excel Yükle'}</button>
              <button type="button" disabled={!records.length} onClick={() => downloadJson(records)}><Download size={16} /> Yedek</button>
              <input ref={fileInputRef} hidden multiple type="file" accept=".xlsx,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" onChange={(event) => void importFiles(event)} />
            </div>
            <div className="des-list">
              {records.map((record) => {
                const info = qualityInfo(record)
                return <button type="button" key={record.id} className={selected?.id === record.id ? 'is-selected' : ''} onClick={() => setSelectedId(record.id)}><span className={`des-quality-dot ${info.tone}`} /><span><strong>{record.name}</strong><small>{record.measurements.length} ölçüm{record.province ? ` · ${record.province}${record.district ? `/${record.district}` : ''}` : ''}</small></span>{info.tone !== 'good' ? <AlertTriangle size={14} /> : null}</button>
              })}
              {!records.length ? <div className="des-list-empty"><FileSpreadsheet size={28} /><strong>DES Excel yükleyin</strong><span>AB/2 · MN · I · V · K · r düzeni otomatik tanınır.</span></div> : null}
            </div>
          </aside>

          <main className="des-main-pane">
            {!selected ? <div className="des-empty"><FileSpreadsheet size={38} /><strong>Henüz DES verisi yok</strong><span>Gönderdiğin DES 26 / 30 / 34 formatındaki .xlsx dosyalarını doğrudan yükleyebilirsin.</span><button type="button" onClick={() => fileInputRef.current?.click()}><Upload size={16} /> Excel seç</button></div> : null}

            {selected && tab === 'data' ? (
              <div className="des-data-view">
                <div className="des-section-heading"><div><strong>{selected.name}</strong><small>{selected.fileName} · görünür özdirenç saha verisi</small></div><div><button type="button" className="danger" onClick={removeSelected}><Trash2 size={15} /> Sil</button><button type="button" onClick={() => setStatus(`${selected.name} bilgileri kaydedildi.`)}><Save size={15} /> Kaydet</button></div></div>
                <div className="des-meta-grid">
                  <label><span>DES Adı</span><input value={selected.name} onChange={(event) => updateSelected({ name: event.target.value })} /></label>
                  <label><span>DES No</span><input inputMode="numeric" value={selected.number ?? ''} onChange={(event) => updateSelected({ number: finiteOrNull(event.target.value) })} /></label>
                  <label><span>İl</span><input value={selected.province} onChange={(event) => updateSelected({ province: event.target.value })} /></label>
                  <label><span>İlçe</span><input value={selected.district} onChange={(event) => updateSelected({ district: event.target.value })} /></label>
                  <label><span>Doğu E / Y</span><input inputMode="decimal" value={selected.easting ?? ''} onChange={(event) => updateSelected({ easting: finiteOrNull(event.target.value) })} placeholder="Opsiyonel" /></label>
                  <label><span>Kuzey N / X</span><input inputMode="decimal" value={selected.northing ?? ''} onChange={(event) => updateSelected({ northing: finiteOrNull(event.target.value) })} placeholder="Opsiyonel" /></label>
                  <label><span>Kot Z (m)</span><input inputMode="decimal" value={selected.elevation ?? ''} onChange={(event) => updateSelected({ elevation: finiteOrNull(event.target.value) })} placeholder="Opsiyonel" /></label>
                  <label><span>UTM Zon</span><input inputMode="numeric" value={selected.zone} onChange={(event) => updateSelected({ zone: Math.max(1, Math.min(60, Math.round(Number(event.target.value) || 36))) })} /></label>
                  <label><span>Yarımküre</span><select value={selected.hemisphere} onChange={(event) => updateSelected({ hemisphere: event.target.value === 'S' ? 'S' : 'N' })}><option value="N">N · Kuzey</option><option value="S">S · Güney</option></select></label>
                  <label className="span-3"><span>Not</span><input value={selected.note} onChange={(event) => updateSelected({ note: event.target.value })} placeholder="Saha notu / hat bilgisi / açıklama" /></label>
                </div>
                <div className={`des-model-ready ${quality?.coordinateReady ? 'ready' : ''}`}><MapPin size={17} /><div><strong>{quality?.coordinateReady ? '2B / 3B modelleme için konum hazır' : 'Modelleme için koordinat eklenmeli'}</strong><span>DES ölçümleri kaydedildi. E/N koordinatı ve kot eklendiğinde sonraki kesit/3B modelleme aşamasına hazır olur.</span></div></div>
                <div className="des-table-wrap"><table><thead><tr><th>#</th><th>AB/2</th><th>MN</th><th>I</th><th>V</th><th>K</th><th>ρa (Ωm)</th></tr></thead><tbody>{selected.measurements.map((item, index) => <tr key={`${item.ab2}-${item.mn}-${index}`}><td>{index + 1}</td><td>{item.ab2}</td><td>{item.mn}</td><td>{item.current ?? '—'}</td><td>{item.voltage ?? '—'}</td><td>{item.k?.toFixed(3) ?? '—'}</td><td><strong>{item.rho.toFixed(2)}</strong></td></tr>)}</tbody></table></div>
              </div>
            ) : null}

            {selected && tab === 'curve' ? (
              <div className="des-curve-view"><div className="des-section-heading"><div><strong>{selected.name} · Görünür Özdirenç Eğrisi</strong><small>Schlumberger DES saha eğrisi · AB/2 ve ρa logaritmik ölçek</small></div><span className={`des-quality-badge ${quality?.tone}`}>{quality?.label}</span></div><ResistivityCurve record={selected} /><div className="des-curve-summary"><span><strong>{Math.min(...rhoValues).toFixed(1)} Ωm</strong><small>Minimum ρa</small></span><span><strong>{Math.max(...rhoValues).toFixed(1)} Ωm</strong><small>Maksimum ρa</small></span><span><strong>{Math.max(...selected.measurements.map((item) => item.ab2))} m</strong><small>Maks. AB/2</small></span><span><strong>{new Set(selected.measurements.map((item) => item.mn)).size}</strong><small>MN grubu</small></span></div></div>
            ) : null}

            {selected && tab === 'quality' ? (
              <div className="des-quality-view">
                <div className="des-section-heading"><div><strong>Ölçüm Kalite Kontrolü</strong><small>Excel formülü, MN geçiş tekrarları ve veri bütünlüğü</small></div><span className={`des-quality-badge ${quality?.tone}`}>{quality?.label}</span></div>
                <div className="des-quality-grid">
                  <article><CheckCircle2 size={20} /><div><strong>{quality?.formulas.checked ?? 0} satır formül kontrolü</strong><span>K × V / I ile ρa karşılaştırıldı.</span><b>{quality?.formulas.mismatches.length ? `${quality.formulas.mismatches.length} uyumsuz satır` : 'Uyumlu'}</b></div></article>
                  <article><Activity size={20} /><div><strong>{quality?.repeats.length ?? 0} tekrar AB/2 noktası</strong><span>MN değişimindeki ortak ölçüler karşılaştırıldı.</span><b>Maks. fark %{quality?.maxRepeat.toFixed(2)}</b></div></article>
                  <article><Database size={20} /><div><strong>{selected.measurements.length} geçerli ölçüm</strong><span>Hatalı/boş Excel satırları otomatik dışarıda bırakıldı.</span><b>{selected.measurements.every((item) => item.rho > 0) ? 'Veri bütünlüğü iyi' : 'Kontrol gerekli'}</b></div></article>
                  <article><MapPin size={20} /><div><strong>{quality?.coordinateReady ? 'Koordinat mevcut' : 'Koordinat eksik'}</strong><span>2B kesit ve 3B korelasyon için E/N gerekir.</span><b>{quality?.coordinateReady ? `${selected.zone}${selected.hemisphere}` : 'Henüz hazır değil'}</b></div></article>
                </div>
                <div className="des-repeat-section"><h3>MN Geçiş / Tekrar Kontrolü</h3>{quality?.repeats.length ? <div className="des-repeat-list">{quality.repeats.map((item) => <div key={item.ab2} className={item.differencePct > 10 ? 'danger' : item.differencePct > 5 ? 'warning' : 'good'}><span><strong>AB/2 = {item.ab2} m</strong><small>{item.values.map((value) => `MN ${value.mn}: ${value.rho.toFixed(2)} Ωm`).join(' · ')}</small></span><b>%{item.differencePct.toFixed(2)}</b></div>)}</div> : <p className="des-quality-note">Aynı AB/2 değerinde tekrar ölçüm bulunmadı.</p>}</div>
                {quality?.formulas.mismatches.length ? <div className="des-warning-box"><AlertTriangle size={17} /><div><strong>Excel formül uyuşmazlığı bulundu</strong><span>{quality.formulas.mismatches.slice(0, 5).map((item) => `AB/2 ${item.ab2} m (%${item.differencePct.toFixed(2)})`).join(' · ')}</span></div></div> : <div className="des-success-box"><CheckCircle2 size={17} /><div><strong>Görünür özdirenç hesapları tutarlı</strong><span>Kontrol edilebilen satırlarda K × V / I sonucu Excel ρa değerleriyle uyumlu.</span></div></div>}
              </div>
            ) : null}
          </main>
        </div>

        {status ? <div className="des-status">{status}</div> : null}
      </section>
    </div>
  )
}
