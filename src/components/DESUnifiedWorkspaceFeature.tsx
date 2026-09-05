import { useEffect, useMemo, useRef, useState, type ChangeEvent } from 'react'
import JSZip from 'jszip'
import { Activity, AlertTriangle, CheckCircle2, Database, FileSpreadsheet, Layers3, MapPinned, Save, Sparkles, Trash2, Upload, X } from 'lucide-react'
import { prepareObserved, responseFor, type DesLayerModel } from './DESProfessionalEngine'
import { finalizeDualAnalysis, runDualLayerCount, type DualAnalysisResult } from './DESDualInversionEngine'
import './DESUnifiedWorkspaceFeature.css'

const OPEN_EVENT = 'evren-open-des-workspace'
const RECORDS_KEY = 'evren-jeofizik-gis-des-analysis-v1'
const PROFESSIONAL_KEY = 'evren-jeofizik-gis-des-professional-v2'
const CALIBRATION_KEY = 'evren-jeofizik-gis-des-calibration-v1'
const DUAL_KEY = 'evren-jeofizik-gis-des-dual-inversion-v1'
const PIPELINE_KEY = 'evren-jeofizik-gis-des-auto-pipeline-v1'

type ViewTab = 'summary' | 'data' | 'model' | 'validation' | 'report'
type CellValue = string | number | null

type DesMeasurement = {
  ab2: number
  mn: number
  current: number | null
  voltage: number | null
  currentReverse: number | null
  voltageReverse: number | null
  k: number | null
  rhoForward: number | null
  rhoReverse: number | null
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

type ProfessionalSaved = {
  recordId: string
  layers: DesLayerModel[]
  rms: number
  curveType: string
  method: string
  updatedAt: number
}

type PipelineState = {
  sourceSignature: string
  status: 'ready' | 'error'
  message: string
  updatedAt: number
}

type PipelineStore = Record<string, PipelineState>
type ProfessionalStore = Record<string, ProfessionalSaved>
type DualStore = Record<string, DualAnalysisResult>

function uid() { return `des-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}` }
function finiteOrNull(value: unknown) {
  if (value === '' || value === null || value === undefined) return null
  const number = Number(String(value).replace(',', '.'))
  return Number.isFinite(number) ? number : null
}
function fold(value: unknown) {
  return String(value ?? '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/ı/g, 'i').replace(/İ/g, 'i').replace(/ş/g, 's').replace(/Ş/g, 's').replace(/ğ/g, 'g').replace(/Ğ/g, 'g').replace(/ç/g, 'c').replace(/Ç/g, 'c').replace(/ö/g, 'o').replace(/Ö/g, 'o').replace(/ü/g, 'u').replace(/Ü/g, 'u').trim().toLowerCase()
}
function readJson<T>(key: string, fallback: T): T {
  try { const value = JSON.parse(localStorage.getItem(key) || '') as T; return value ?? fallback } catch { return fallback }
}
function normalizeRecord(value: Partial<DesRecord>, index: number): DesRecord | null {
  if (!Array.isArray(value.measurements)) return null
  const measurements = value.measurements.map((item) => ({
    ab2: Number(item.ab2), mn: Number(item.mn), current: finiteOrNull(item.current), voltage: finiteOrNull(item.voltage),
    currentReverse: finiteOrNull(item.currentReverse), voltageReverse: finiteOrNull(item.voltageReverse), k: finiteOrNull(item.k),
    rhoForward: finiteOrNull(item.rhoForward), rhoReverse: finiteOrNull(item.rhoReverse), rho: Number(item.rho),
  })).filter((item) => Number.isFinite(item.ab2) && item.ab2 > 0 && Number.isFinite(item.mn) && item.mn > 0 && Number.isFinite(item.rho) && item.rho > 0)
  if (!measurements.length) return null
  const number = finiteOrNull(value.number)
  return {
    id: typeof value.id === 'string' && value.id ? value.id : uid(), name: typeof value.name === 'string' && value.name.trim() ? value.name.trim() : `DES ${number ?? index + 1}`,
    number, fileName: typeof value.fileName === 'string' ? value.fileName : '', province: typeof value.province === 'string' ? value.province : '', district: typeof value.district === 'string' ? value.district : '',
    easting: finiteOrNull(value.easting), northing: finiteOrNull(value.northing), elevation: finiteOrNull(value.elevation), zone: Math.max(1, Math.min(60, Math.round(Number(value.zone) || 36))),
    hemisphere: value.hemisphere === 'S' ? 'S' : 'N', note: typeof value.note === 'string' ? value.note : '', measurements,
    importedAt: Number(value.importedAt) || Date.now(), updatedAt: Number(value.updatedAt) || Date.now(),
  }
}
function readRecords() {
  const raw = readJson<Array<Partial<DesRecord>>>(RECORDS_KEY, [])
  return raw.map(normalizeRecord).filter((item): item is DesRecord => Boolean(item))
}
function columnIndex(address: string) {
  const letters = address.match(/[A-Z]+/i)?.[0]?.toUpperCase() || 'A'; let result = 0
  for (let index = 0; index < letters.length; index += 1) result = result * 26 + letters.charCodeAt(index) - 64
  return result - 1
}
function sharedStringsFromXml(xml: string) {
  const doc = new DOMParser().parseFromString(xml, 'application/xml')
  return Array.from(doc.getElementsByTagName('si')).map((item) => Array.from(item.getElementsByTagName('t')).map((node) => node.textContent || '').join(''))
}
function cellValue(cell: Element, sharedStrings: string[]): CellValue {
  const type = cell.getAttribute('t') || ''
  if (type === 'inlineStr') return Array.from(cell.getElementsByTagName('t')).map((node) => node.textContent || '').join('')
  const raw = cell.getElementsByTagName('v')[0]?.textContent
  if (raw === null || raw === undefined) return null
  if (type === 's') return sharedStrings[Number(raw)] ?? ''
  if (type === 'str' || type === 'e') return raw
  const number = Number(raw); return Number.isFinite(number) ? number : raw
}
function rowsFromSheet(xml: string, sharedStrings: string[]) {
  const doc = new DOMParser().parseFromString(xml, 'application/xml'); const rows = new Map<number, Map<number, CellValue>>()
  Array.from(doc.getElementsByTagName('row')).forEach((rowNode) => {
    const rowNumber = Number(rowNode.getAttribute('r')) || rows.size + 1; const columns = new Map<number, CellValue>()
    Array.from(rowNode.getElementsByTagName('c')).forEach((cell) => columns.set(columnIndex(cell.getAttribute('r') || 'A1'), cellValue(cell, sharedStrings)))
    rows.set(rowNumber, columns)
  })
  return rows
}
function findHeader(rows: Map<number, Map<number, CellValue>>) {
  for (const [rowNumber, columns] of rows) {
    let ab2: number | null = null; let mn: number | null = null; let current: number | null = null; let voltage: number | null = null
    let currentReverse: number | null = null; let voltageReverse: number | null = null; let k: number | null = null; let rho: number | null = null
    let rhoAverage: number | null = null; let rhoForward: number | null = null; let rhoReverse: number | null = null
    for (const [column, value] of columns) {
      const text = fold(value).replace(/[\s_.-]+/g, '')
      if (text === 'ab/2' || text === 'ab2') ab2 = column
      else if (text === 'mn' || text === 'mn/2') mn = column
      else if (text === 'i' || text === 'iduz' || text === 'iduzakim') current = column
      else if (text === 'iters' || text === 'itersakim') currentReverse = column
      else if (text === 'v' || text === 'vduz' || text === 'vduzvoltaj') voltage = column
      else if (text === 'vters' || text === 'vtersvoltaj') voltageReverse = column
      else if (text === 'k') k = column
      else if (text === 'rort' || text === 'rortalama' || text === 'rhoort' || text === 'rhoortalama') rhoAverage = column
      else if (text === 'r1' || text === 'rho1') rhoForward = column
      else if (text === 'r2' || text === 'rho2') rhoReverse = column
      else if (text === 'r' || text === 'rho' || text.includes('ozdirenc')) rho = column
    }
    const selectedRho = rhoAverage ?? rho
    if (ab2 !== null && mn !== null && selectedRho !== null) return { rowNumber, ab2, mn, current, voltage, currentReverse, voltageReverse, k, rho: selectedRho, rhoForward, rhoReverse }
  }
  return null
}
function cellBelowLabel(rows: Map<number, Map<number, CellValue>>, label: string) {
  for (const [rowNumber, columns] of rows) for (const [column, value] of columns) {
    if (fold(value) !== label) continue; const below = rows.get(rowNumber + 1)?.get(column); if (typeof below === 'string' && below.trim()) return below.trim()
  }
  return ''
}
function numberRightOfLabel(rows: Map<number, Map<number, CellValue>>, label: string, distance = 4) {
  for (const [, columns] of rows) for (const [column, value] of columns) {
    if (fold(value) !== label) continue
    for (let offset = 1; offset <= distance; offset += 1) { const number = finiteOrNull(columns.get(column + offset)); if (number !== null) return number }
  }
  return null
}
async function parseDesWorkbook(file: File): Promise<DesRecord> {
  if (!file.name.toLowerCase().endsWith('.xlsx')) throw new Error('Sadece .xlsx DES dosyaları destekleniyor.')
  const zip = await JSZip.loadAsync(await file.arrayBuffer()); const sharedEntry = zip.file('xl/sharedStrings.xml')
  const sharedStrings = sharedEntry ? sharedStringsFromXml(await sharedEntry.async('text')) : []
  const sheetNames = Object.keys(zip.files).filter((name) => /^xl\/worksheets\/sheet\d+\.xml$/i.test(name)).sort()
  let rows: Map<number, Map<number, CellValue>> | null = null; let header: ReturnType<typeof findHeader> = null
  for (const sheetName of sheetNames) {
    const entry = zip.file(sheetName); if (!entry) continue
    const candidateRows = rowsFromSheet(await entry.async('text'), sharedStrings); const candidateHeader = findHeader(candidateRows)
    if (candidateHeader) { rows = candidateRows; header = candidateHeader; break }
  }
  if (!rows || !header) throw new Error('AB/2, MN ve r / rort sütunları bulunamadı.')
  const measurements: DesMeasurement[] = []
  Array.from(rows.entries()).sort((a, b) => a[0] - b[0]).forEach(([rowNumber, columns]) => {
    if (rowNumber <= header!.rowNumber) return
    const ab2 = finiteOrNull(columns.get(header!.ab2)); const mn = finiteOrNull(columns.get(header!.mn)); const rho = finiteOrNull(columns.get(header!.rho))
    if (ab2 === null || ab2 <= 0 || mn === null || mn <= 0 || rho === null || rho <= 0) return
    measurements.push({ ab2, mn, current: header!.current === null ? null : finiteOrNull(columns.get(header!.current)), voltage: header!.voltage === null ? null : finiteOrNull(columns.get(header!.voltage)),
      currentReverse: header!.currentReverse === null ? null : finiteOrNull(columns.get(header!.currentReverse)), voltageReverse: header!.voltageReverse === null ? null : finiteOrNull(columns.get(header!.voltageReverse)),
      k: header!.k === null ? null : finiteOrNull(columns.get(header!.k)), rhoForward: header!.rhoForward === null ? null : finiteOrNull(columns.get(header!.rhoForward)), rhoReverse: header!.rhoReverse === null ? null : finiteOrNull(columns.get(header!.rhoReverse)), rho })
  })
  if (measurements.length < 3) throw new Error('Yeterli geçerli DES ölçümü bulunamadı.')
  const desNumber = numberRightOfLabel(rows, 'des') ?? finiteOrNull(file.name.match(/des\D*(\d+)/i)?.[1])
  return { id: uid(), name: desNumber !== null ? `DES ${desNumber}` : file.name.replace(/\.xlsx$/i, ''), number: desNumber, fileName: file.name,
    province: cellBelowLabel(rows, 'ili'), district: cellBelowLabel(rows, 'ilcesi'), easting: numberRightOfLabel(rows, 'y', 3), northing: numberRightOfLabel(rows, 'x', 3), elevation: null, zone: 36, hemisphere: 'N', note: '', measurements, importedAt: Date.now(), updatedAt: Date.now() }
}
function repeatMax(record: DesRecord) {
  const groups = new Map<number, number[]>(); record.measurements.forEach((item) => groups.set(item.ab2, [...(groups.get(item.ab2) || []), item.rho]))
  return Math.max(0, ...Array.from(groups.values()).filter((values) => values.length > 1).map((values) => { const mean = values.reduce((sum, value) => sum + value, 0) / values.length; return mean > 0 ? (Math.max(...values) - Math.min(...values)) / mean * 100 : 0 }))
}
function formulaMismatchCount(record: DesRecord) {
  return record.measurements.filter((item) => {
    if (item.k === null || item.rho <= 0) return false
    const forward = item.current !== null && item.voltage !== null && item.current !== 0 ? item.k * item.voltage / item.current : null
    const reverse = item.currentReverse !== null && item.voltageReverse !== null && item.currentReverse !== 0 ? item.k * item.voltageReverse / item.currentReverse : null
    const calculated = forward !== null && reverse !== null ? (forward + reverse) / 2 : forward ?? reverse
    return calculated !== null && Number.isFinite(calculated) && Math.abs(calculated - item.rho) / item.rho * 100 > 1
  }).length
}
function signature(record: DesRecord) { return record.measurements.map((item) => `${item.ab2}:${item.mn}:${item.rho}`).join('|') }
function cloneRecord(record: DesRecord): DesRecord { return { ...record, measurements: record.measurements.map((item) => ({ ...item })) } }
function formatNumber(value: number | null, digits = 1) { return value === null || !Number.isFinite(value) ? '—' : value.toFixed(digits) }

function LayerColumn({ layers }: { layers: DesLayerModel[] }) {
  if (!layers.length) return <div className="duw-empty-card"><Layers3 size={30} /><strong>Model henüz yok</strong><span>Excel yüklenince otomatik oluşturulur.</span></div>
  const finiteDepth = layers.slice(0, -1).reduce((sum, layer) => sum + (layer.thickness || 0), 0); let cursor = 0
  return <div className="duw-layer-column">{layers.map((layer, index) => { const top = cursor; const thickness = layer.thickness; if (thickness !== null) cursor += thickness; const height = thickness === null ? 96 : Math.max(46, Math.min(150, (thickness / Math.max(1, finiteDepth)) * 360)); const hue = 240 - Math.min(240, Math.max(0, Math.log10(Math.max(.1, layer.rho)) / 4 * 240)); return <div key={layer.id} className="duw-layer-block" style={{ height, background: `hsl(${hue} 72% 46%)` }}><strong>Tabaka {index + 1}</strong><span>{layer.rho.toFixed(1)} Ωm</span><small>{thickness === null ? `${top.toFixed(1)} m +` : `${top.toFixed(1)}–${cursor.toFixed(1)} m`}</small></div> })}</div>
}

export default function DESUnifiedWorkspaceFeature() {
  const [open, setOpen] = useState(false); const [view, setView] = useState<ViewTab>('summary')
  const [records, setRecords] = useState<DesRecord[]>(readRecords); const [selectedId, setSelectedId] = useState<string | null>(() => readRecords()[0]?.id ?? null)
  const [draft, setDraft] = useState<DesRecord | null>(() => readRecords()[0] ? cloneRecord(readRecords()[0]) : null)
  const [dualStore, setDualStore] = useState<DualStore>(() => readJson<DualStore>(DUAL_KEY, {})); const [professionalStore, setProfessionalStore] = useState<ProfessionalStore>(() => readJson<ProfessionalStore>(PROFESSIONAL_KEY, {}))
  const [pipelineStore, setPipelineStore] = useState<PipelineStore>(() => readJson<PipelineStore>(PIPELINE_KEY, {})); const [busyId, setBusyId] = useState<string | null>(null)
  const [progress, setProgress] = useState(''); const [status, setStatus] = useState(''); const fileRef = useRef<HTMLInputElement | null>(null)
  const selected = records.find((record) => record.id === selectedId) ?? records[0] ?? null
  const analysis = selected ? dualStore[selected.id] ?? null : null; const model = selected ? professionalStore[selected.id] ?? null : null

  useEffect(() => { const show = () => { const next = readRecords(); setRecords(next); setSelectedId(next[0]?.id ?? null); setDraft(next[0] ? cloneRecord(next[0]) : null); setDualStore(readJson<DualStore>(DUAL_KEY, {})); setProfessionalStore(readJson<ProfessionalStore>(PROFESSIONAL_KEY, {})); setPipelineStore(readJson<PipelineStore>(PIPELINE_KEY, {})); setStatus(''); setOpen(true) }; window.addEventListener(OPEN_EVENT, show); return () => window.removeEventListener(OPEN_EVENT, show) }, [])
  useEffect(() => { if (!open) return; const previous = document.body.style.overflow; document.body.style.overflow = 'hidden'; return () => { document.body.style.overflow = previous } }, [open])
  useEffect(() => { if (!selected) { setDraft(null); return }; setDraft(cloneRecord(selected)) }, [selected?.id])

  const persistRecords = (next: DesRecord[]) => { localStorage.setItem(RECORDS_KEY, JSON.stringify(next)); setRecords(next); window.dispatchEvent(new CustomEvent('evren-des-analysis-changed')) }
  const processRecord = async (record: DesRecord) => {
    setBusyId(record.id); setStatus(''); try {
      const observed = prepareObserved(record.measurements); if (observed.length < 4) throw new Error('Otomatik model için en az 4 benzersiz AB/2 noktası gerekli.')
      const results = []
      for (const count of [3, 4, 5, 6]) { setProgress(`${record.name} · ${count} tabakalı model Motor A + Motor B çözülüyor…`); await new Promise<void>((resolve) => window.setTimeout(resolve, 20)); results.push(runDualLayerCount(observed, count)) }
      const analysisResult = finalizeDualAnalysis(results); if (!analysisResult) throw new Error('Otomatik model sonucu üretilemedi.')
      const dual = readJson<DualStore>(DUAL_KEY, {}); dual[record.id] = analysisResult; localStorage.setItem(DUAL_KEY, JSON.stringify(dual)); setDualStore(dual)
      const professional = readJson<ProfessionalStore>(PROFESSIONAL_KEY, {}); const previous = professional[record.id]
      const layers = analysisResult.recommended.consensusLayers.map((layer, index) => ({ ...layer, interpretation: previous?.layers[index]?.interpretation || '' }))
      professional[record.id] = { recordId: record.id, layers, rms: analysisResult.recommended.consensusRms, curveType: analysisResult.recommended.consensusCurveType, method: 'DES Otomatik Çalışma · Motor A/B konsensus · BIC + iç tutarlılık', updatedAt: Date.now() }
      localStorage.setItem(PROFESSIONAL_KEY, JSON.stringify(professional)); setProfessionalStore(professional)
      const pipeline = readJson<PipelineStore>(PIPELINE_KEY, {}); pipeline[record.id] = { sourceSignature: signature(record), status: 'ready', message: `${analysisResult.recommended.layerCount} tabaka · ${analysisResult.confidenceLabel}`, updatedAt: Date.now() }
      localStorage.setItem(PIPELINE_KEY, JSON.stringify(pipeline)); setPipelineStore(pipeline); window.dispatchEvent(new CustomEvent('evren-des-professional-changed'))
      setStatus(`${record.name} otomatik tamamlandı · ${analysisResult.recommended.layerCount} tabaka · RMS %${analysisResult.recommended.consensusRms.toFixed(2)} · ${analysisResult.confidenceLabel}.`)
    } catch (error) {
      const pipeline = readJson<PipelineStore>(PIPELINE_KEY, {}); pipeline[record.id] = { sourceSignature: signature(record), status: 'error', message: error instanceof Error ? error.message : 'Otomatik işlem tamamlanamadı.', updatedAt: Date.now() }; localStorage.setItem(PIPELINE_KEY, JSON.stringify(pipeline)); setPipelineStore(pipeline); setStatus(pipeline[record.id].message)
    } finally { setProgress(''); setBusyId(null) }
  }

  const importFiles = async (event: ChangeEvent<HTMLInputElement>) => {
    const files = Array.from(event.target.files || []); event.target.value = ''; if (!files.length) return
    setStatus('Excel dosyaları okunuyor…'); const imported: DesRecord[] = []; const errors: string[] = []
    for (const file of files) { try { imported.push(await parseDesWorkbook(file)) } catch (error) { errors.push(`${file.name}: ${error instanceof Error ? error.message : 'okunamadı'}`) } }
    if (!imported.length) { setStatus(errors.join(' · ') || 'Dosya okunamadı.'); return }
    const next = [...records]; const effective: DesRecord[] = []
    imported.forEach((record) => { const index = next.findIndex((item) => item.fileName === record.fileName && item.number === record.number); if (index >= 0) { const previous = next[index]; const merged = { ...record, id: previous.id, elevation: previous.elevation ?? record.elevation, zone: previous.zone, hemisphere: previous.hemisphere, note: previous.note, updatedAt: Date.now() }; next[index] = merged; effective.push(merged) } else { next.push(record); effective.push(record) } })
    persistRecords(next); setSelectedId(effective[0].id); setDraft(cloneRecord(effective[0])); setView('summary')
    for (const record of effective) await processRecord(record)
    if (errors.length) setStatus((current) => `${current} · Okunamayan: ${errors.join(' · ')}`)
  }

  const saveDraft = async () => {
    if (!draft || busyId) return
    const cleaned = { ...draft, updatedAt: Date.now(), measurements: draft.measurements.map((item) => ({ ...item, ab2: Number(item.ab2), mn: Number(item.mn), rho: Number(item.rho) })).filter((item) => Number.isFinite(item.ab2) && item.ab2 > 0 && Number.isFinite(item.mn) && item.mn > 0 && Number.isFinite(item.rho) && item.rho > 0) }
    const next = records.map((record) => record.id === cleaned.id ? cleaned : record); persistRecords(next); setDraft(cloneRecord(cleaned)); await processRecord(cleaned)
  }
  const removeSelected = () => {
    if (!selected || busyId || !window.confirm(`${selected.name} ve buna bağlı tüm DES model sonuçları silinsin mi?`)) return
    persistRecords(records.filter((record) => record.id !== selected.id)); [PROFESSIONAL_KEY, CALIBRATION_KEY, DUAL_KEY, PIPELINE_KEY].forEach((key) => { const store = readJson<Record<string, unknown>>(key, {}); delete store[selected.id]; localStorage.setItem(key, JSON.stringify(store)) })
    const next = records.filter((record) => record.id !== selected.id); const first = next[0] ?? null; setSelectedId(first?.id ?? null); setDraft(first ? cloneRecord(first) : null); setDualStore(readJson<DualStore>(DUAL_KEY, {})); setProfessionalStore(readJson<ProfessionalStore>(PROFESSIONAL_KEY, {})); setPipelineStore(readJson<PipelineStore>(PIPELINE_KEY, {})); setStatus(`${selected.name} silindi.`)
  }

  const qc = useMemo(() => selected ? { repeats: repeatMax(selected), mismatches: formulaMismatchCount(selected) } : null, [selected])
  const reportReady = selected ? selected.easting !== null && selected.northing !== null && Boolean(model?.layers.length) : false
  const levelMapCount = records.filter((record) => record.easting !== null && record.northing !== null && Boolean(professionalStore[record.id]?.layers.length || dualStore[record.id]?.recommended?.consensusLayers.length)).length
  const pipe = selected ? pipelineStore[selected.id] : undefined

  if (!open) return null
  return <div className="desworkspace-overlay" role="dialog" aria-modal="true" aria-label="DES Çalışması">
    <section className="desworkspace-shell">
      <header className="duw-head"><div><span><Sparkles size={22} /></span><div><small>EVREN GIS · OTOMATİK DES İŞ AKIŞI</small><h2>DES Çalışması</h2></div></div><button type="button" onClick={() => !busyId && setOpen(false)} disabled={Boolean(busyId)} aria-label="DES çalışmasını kapat"><X size={20} /></button></header>
      <div className="duw-layout">
        <aside className="duw-sidebar"><div className="duw-import"><button type="button" className="primary" onClick={() => fileRef.current?.click()} disabled={Boolean(busyId)}><Upload size={16} /> Excel Ekle</button><input ref={fileRef} type="file" hidden multiple accept=".xlsx,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" onChange={(event) => void importFiles(event)} /></div>
          <div className="duw-record-list">{records.map((record) => { const state = pipelineStore[record.id]; return <button type="button" key={record.id} className={selected?.id === record.id ? 'is-active' : ''} onClick={() => setSelectedId(record.id)} disabled={Boolean(busyId)}><i className={state?.status === 'error' ? 'bad' : state?.status === 'ready' ? 'good' : ''} /><span><strong>{record.name}</strong><small>{record.measurements.length} ölçüm · {state?.status === 'ready' ? 'Hazır' : state?.status === 'error' ? 'Kontrol' : 'İşlenmemiş'}</small></span></button> })}{!records.length ? <div className="duw-no-record"><FileSpreadsheet size={30} /><strong>DES Excel ekleyin</strong><span>Eski ve yeni DES Excel düzeni otomatik tanınır.</span></div> : null}</div>
        </aside>
        <main className="duw-main">{!selected || !draft ? <div className="duw-start"><Sparkles size={42} /><strong>Excel'i yükle, gerisini sistem yapsın</strong><span>Veri kontrolü, 3–6 tabaka taraması, Dual Inversion, Professional model ve rapor hazırlığı otomatik çalışır.</span><button onClick={() => fileRef.current?.click()}><Upload size={16} /> DES Excel Seç</button></div> : <>
          <div className="duw-toolbar"><div><small>SEÇİLİ KAYIT</small><h3>{selected.name}</h3><span>{selected.fileName} · {selected.measurements.length} ölçüm</span></div><div><button className="danger" onClick={removeSelected} disabled={Boolean(busyId)}><Trash2 size={15} /> Sil</button><button className="primary" onClick={() => void saveDraft()} disabled={Boolean(busyId)}><Save size={15} /> {busyId === selected.id ? 'Hesaplanıyor…' : 'Kaydet + Yeniden Hesapla'}</button></div></div>
          <nav className="duw-tabs"><button className={view === 'summary' ? 'active' : ''} onClick={() => setView('summary')}><Sparkles size={15} /> Özet</button><button className={view === 'data' ? 'active' : ''} onClick={() => setView('data')}><Database size={15} /> Veri</button><button className={view === 'model' ? 'active' : ''} onClick={() => setView('model')}><Layers3 size={15} /> Model</button><button className={view === 'validation' ? 'active' : ''} onClick={() => setView('validation')}><CheckCircle2 size={15} /> Doğrulama</button><button className={view === 'report' ? 'active' : ''} onClick={() => setView('report')}><MapPinned size={15} /> Rapor</button></nav>
          {progress ? <div className="duw-progress"><span />{progress}</div> : null}{status ? <div className="duw-status">{status}</div> : null}
          <div className="duw-scroll">
            {view === 'summary' ? <><div className="duw-steps">{[['Excel / Ham Veri', true], ['Kalite Kontrolü', true], ['Dual Inversion', Boolean(analysis)], ['Professional Model', Boolean(model)], ['İç Doğrulama', Boolean(analysis)], ['Rapor Verisi', reportReady]].map(([label, ready]) => <article key={String(label)} className={ready ? 'ready' : ''}>{ready ? <CheckCircle2 size={19} /> : <AlertTriangle size={19} />}<div><strong>{label}</strong><span>{ready ? 'Hazır' : 'Eksik / bekliyor'}</span></div></article>)}</div>
              <div className="duw-summary-grid"><article><small>Ölçüm</small><strong>{selected.measurements.length}</strong><span>Benzersiz AB/2: {prepareObserved(selected.measurements).length}</span></article><article><small>Kalite</small><strong>{qc?.mismatches ? 'Kontrol' : qc && qc.repeats > 10 ? 'Kontrol' : 'İyi'}</strong><span>Formül uyuşmazlığı {qc?.mismatches ?? 0} · tekrar maks. %{qc?.repeats.toFixed(2) ?? '0.00'}</span></article><article><small>Önerilen Model</small><strong>{analysis ? `${analysis.recommended.layerCount} tabaka` : '—'}</strong><span>{analysis?.recommended.consensusCurveType || 'Henüz model yok'}</span></article><article><small>Konsensus RMS</small><strong>{analysis ? `%${analysis.recommended.consensusRms.toFixed(2)}` : '—'}</strong><span>{analysis?.confidenceLabel || 'Henüz hesaplanmadı'}</span></article></div>
              <div className="duw-auto-note"><Sparkles size={20} /><div><strong>Otomatik işlem açık</strong><span>Yeni Excel yüklendiğinde veya Kaydet + Yeniden Hesapla dediğinde bütün model zinciri yeniden çalışır. IPI2Win/RES1D harici doğrulaması otomatikmiş gibi gösterilmez.</span></div></div></> : null}
            {view === 'data' ? <><div className="duw-form-grid"><label><span>DES Adı</span><input value={draft.name} onChange={(e) => setDraft({ ...draft, name: e.target.value })} /></label><label><span>DES No</span><input value={draft.number ?? ''} onChange={(e) => setDraft({ ...draft, number: finiteOrNull(e.target.value) })} /></label><label><span>İl</span><input value={draft.province} onChange={(e) => setDraft({ ...draft, province: e.target.value })} /></label><label><span>İlçe</span><input value={draft.district} onChange={(e) => setDraft({ ...draft, district: e.target.value })} /></label><label><span>Doğu E / Y</span><input value={draft.easting ?? ''} onChange={(e) => setDraft({ ...draft, easting: finiteOrNull(e.target.value) })} /></label><label><span>Kuzey N / X</span><input value={draft.northing ?? ''} onChange={(e) => setDraft({ ...draft, northing: finiteOrNull(e.target.value) })} /></label><label><span>Kot Z</span><input value={draft.elevation ?? ''} onChange={(e) => setDraft({ ...draft, elevation: finiteOrNull(e.target.value) })} /></label><label><span>UTM Zon</span><input value={draft.zone} onChange={(e) => setDraft({ ...draft, zone: Math.max(1, Math.min(60, Number(e.target.value) || 36)) })} /></label><label className="wide"><span>Not</span><input value={draft.note} onChange={(e) => setDraft({ ...draft, note: e.target.value })} /></label></div>
              <div className="duw-table"><table><thead><tr><th>#</th><th>AB/2</th><th>MN</th><th>ρa (Ωm)</th><th>K</th></tr></thead><tbody>{draft.measurements.map((item, index) => <tr key={index}><td>{index + 1}</td><td><input value={item.ab2} onChange={(e) => { const measurements = draft.measurements.map((row, i) => i === index ? { ...row, ab2: Number(e.target.value) } : row); setDraft({ ...draft, measurements }) }} /></td><td><input value={item.mn} onChange={(e) => { const measurements = draft.measurements.map((row, i) => i === index ? { ...row, mn: Number(e.target.value) } : row); setDraft({ ...draft, measurements }) }} /></td><td><input value={item.rho} onChange={(e) => { const measurements = draft.measurements.map((row, i) => i === index ? { ...row, rho: Number(e.target.value) } : row); setDraft({ ...draft, measurements }) }} /></td><td>{formatNumber(item.k, 3)}</td></tr>)}</tbody></table></div></> : null}
            {view === 'model' ? <div className="duw-model-grid"><LayerColumn layers={model?.layers || []} /><div className="duw-model-table"><div className="duw-card-title"><strong>Önerilen 1B Elektriksel Model</strong><span>Motor A + B konsensus sonucu</span></div>{model?.layers.map((layer, index) => <div className="duw-model-row" key={layer.id}><strong>{index + 1}</strong><span>{layer.rho.toFixed(2)} Ωm</span><span>{layer.thickness === null ? 'Yarı sonsuz' : `${layer.thickness.toFixed(2)} m`}</span><input placeholder="Jeolojik yorum" value={draft.note && false ? '' : layer.interpretation} readOnly /></div>)}{model ? <div className="duw-model-foot"><span>RMS <b>%{model.rms.toFixed(2)}</b></span><span>Eğri <b>{model.curveType}</b></span></div> : null}</div></div> : null}
            {view === 'validation' ? <>{analysis ? <><div className="duw-validation-stats"><article><small>Motor A RMS</small><strong>%{analysis.recommended.motorA.rms.toFixed(2)}</strong></article><article><small>Motor B RMS</small><strong>%{analysis.recommended.motorB.rms.toFixed(2)}</strong></article><article><small>Konsensus RMS</small><strong>%{analysis.recommended.consensusRms.toFixed(2)}</strong></article><article><small>İç Tutarlılık</small><strong>%{analysis.recommended.consistency.toFixed(0)}</strong></article></div><div className="duw-scan"><div className="duw-scan-row head"><span>Model</span><span>A RMS</span><span>B RMS</span><span>Kons.</span><span>Tutarlılık</span><span>BIC</span></div>{analysis.results.map((item) => <div className={`duw-scan-row${item.layerCount === analysis.recommended.layerCount ? ' recommended' : ''}`} key={item.layerCount}><span>{item.layerCount} tabaka</span><span>{item.motorA.rms.toFixed(2)}</span><span>{item.motorB.rms.toFixed(2)}</span><span>{item.consensusRms.toFixed(2)}</span><span>%{item.consistency.toFixed(0)}</span><span>{item.meanBic.toFixed(1)}</span></div>)}</div><div className="duw-auto-note"><CheckCircle2 size={20} /><div><strong>{analysis.confidenceLabel}</strong><span>{analysis.methodNote}</span></div></div></> : <div className="duw-empty-card"><Activity size={30} /><strong>Doğrulama sonucu yok</strong><span>Dosyayı kaydettiğinde otomatik hazırlanır.</span></div>}</> : null}
            {view === 'report' ? <div className="duw-report-grid"><article className={reportReady ? 'ready' : ''}><MapPinned size={22} /><div><strong>Seçili DES rapor verisi</strong><span>{reportReady ? 'Koordinat + 1B model hazır' : 'Koordinat veya model eksik'}</span></div></article><article className={levelMapCount >= 3 ? 'ready' : ''}><MapPinned size={22} /><div><strong>Derinlik özdirenç haritası</strong><span>{levelMapCount}/3 koordinatlı model · {levelMapCount >= 3 ? 'hazır' : 'en az 3 gerekli'}</span></div></article><article className={levelMapCount >= 2 ? 'ready' : ''}><Layers3 size={22} /><div><strong>A–A′ kesiti</strong><span>{levelMapCount >= 2 ? 'Model verileri hazır' : 'En az 2 koordinatlı DES gerekli'}</span></div></article><article className={records.filter((record) => record.elevation !== null && professionalStore[record.id]?.layers.length).length >= 3 ? 'ready' : ''}><MapPinned size={22} /><div><strong>Taban topoğrafyası</strong><span>Kot + model bulunan en az 3 DES gerekir</span></div></article><div className="duw-report-note"><strong>Rapor tarafı otomatik besleniyor</strong><span>Bu ekran yeni bir 2B/3B inversiyon üretmez. Kaydedilen 1B DES modelleri, koordinatlar ve kotlar mevcut DES Rapor harita motorunun girdisidir.</span></div></div> : null}
          </div></>}
        </main>
      </div>
    </section>
  </div>
}
