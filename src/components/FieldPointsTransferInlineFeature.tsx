import { useEffect, useState, type ChangeEvent } from 'react'
import { createPortal } from 'react-dom'
import JSZip from 'jszip'
import { CheckCircle2, FileDown, MapPinned, Upload, X } from 'lucide-react'

const FIELD_POINTS_KEY = 'evren-jeofizik-gis-field-points-v1'
const FIELD_POINTS_CHANGED_EVENT = 'evren-field-points-changed'

type FieldPointSymbol = 'pin' | 'flag' | 'camera' | 'warning' | 'sample' | 'target' | 'note' | 'vehicle'

type FieldPoint = {
  id: string
  name: string
  note: string
  description: string
  lat: number
  lng: number
  symbol: FieldPointSymbol
  photoId?: string
  createdAt: number
  updatedAt: number
}

const SYMBOLS: FieldPointSymbol[] = ['pin', 'flag', 'camera', 'warning', 'sample', 'target', 'note', 'vehicle']

function uid(prefix = 'field-import') {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
}

function normalizeSymbol(value: unknown): FieldPointSymbol {
  return typeof value === 'string' && SYMBOLS.includes(value as FieldPointSymbol) ? value as FieldPointSymbol : 'pin'
}

function readStoredPoints(): FieldPoint[] {
  try {
    const values = JSON.parse(localStorage.getItem(FIELD_POINTS_KEY) || '[]') as Partial<FieldPoint>[]
    if (!Array.isArray(values)) return []
    return values.flatMap((value, index) => {
      const lat = Number(value.lat)
      const lng = Number(value.lng)
      if (!Number.isFinite(lat) || !Number.isFinite(lng)) return []
      const now = Date.now()
      return [{
        id: typeof value.id === 'string' && value.id ? value.id : uid(`field-${index}`),
        name: typeof value.name === 'string' && value.name.trim() ? value.name : `Saha Noktası ${index + 1}`,
        note: typeof value.note === 'string' ? value.note : '',
        description: typeof value.description === 'string' ? value.description : '',
        lat,
        lng,
        symbol: normalizeSymbol(value.symbol),
        photoId: typeof value.photoId === 'string' && value.photoId ? value.photoId : undefined,
        createdAt: typeof value.createdAt === 'number' ? value.createdAt : now,
        updatedAt: typeof value.updatedAt === 'number' ? value.updatedAt : now,
      }]
    })
  } catch {
    return []
  }
}

function saveStoredPoints(points: FieldPoint[]) {
  localStorage.setItem(FIELD_POINTS_KEY, JSON.stringify(points))
  window.dispatchEvent(new CustomEvent(FIELD_POINTS_CHANGED_EVENT))
}

function xmlEscape(value: string) {
  return value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;').replaceAll("'", '&apos;')
}

function safeName(value: string) {
  return value.trim().replace(/[^a-zA-Z0-9ğüşöçıİĞÜŞÖÇ_-]+/g, '-') || 'evren-jeofizik-projesi'
}

function downloadBlob(value: string | Blob, filename: string, type?: string) {
  const blob = typeof value === 'string' ? new Blob([value], { type: type ?? 'text/plain;charset=utf-8' }) : value
  const url = URL.createObjectURL(blob)
  const anchor = document.createElement('a')
  anchor.href = url
  anchor.download = filename
  document.body.appendChild(anchor)
  anchor.click()
  anchor.remove()
  window.setTimeout(() => URL.revokeObjectURL(url), 1000)
}

function pointsToKml(points: FieldPoint[]) {
  const placemarks = points.map((point) => `    <Placemark>\n      <name>${xmlEscape(point.name)}</name>\n      <description>${xmlEscape(point.description)}</description>\n      <ExtendedData>\n        <Data name="evren:type"><value>field-point</value></Data>\n        <Data name="evren:symbol"><value>${xmlEscape(point.symbol)}</value></Data>\n        <Data name="evren:note"><value>${xmlEscape(point.note)}</value></Data>\n        <Data name="evren:description"><value>${xmlEscape(point.description)}</value></Data>\n        <Data name="evren:createdAt"><value>${point.createdAt}</value></Data>\n        <Data name="evren:updatedAt"><value>${point.updatedAt}</value></Data>\n      </ExtendedData>\n      <Point><coordinates>${point.lng},${point.lat},0</coordinates></Point>\n    </Placemark>`).join('\n')
  return `<?xml version="1.0" encoding="UTF-8"?>\n<kml xmlns="http://www.opengis.net/kml/2.2">\n  <Document>\n    <name>Evren Jeofizik Saha Noktaları</name>\n${placemarks}\n  </Document>\n</kml>\n`
}

function pointsToGpx(points: FieldPoint[]) {
  const waypoints = points.map((point) => `  <wpt lat="${point.lat}" lon="${point.lng}">\n    <name>${xmlEscape(point.name)}</name>\n    <cmt>${xmlEscape(point.note)}</cmt>\n    <desc>${xmlEscape(point.description)}</desc>\n    <type>${xmlEscape(point.symbol)}</type>\n    <extensions>\n      <evren:symbol>${xmlEscape(point.symbol)}</evren:symbol>\n      <evren:createdAt>${point.createdAt}</evren:createdAt>\n      <evren:updatedAt>${point.updatedAt}</evren:updatedAt>\n    </extensions>\n  </wpt>`).join('\n')
  return `<?xml version="1.0" encoding="UTF-8"?>\n<gpx version="1.1" creator="Evren Jeofizik GIS" xmlns="http://www.topografix.com/GPX/1/1" xmlns:evren="https://evrenjeofizik.com/gis">\n${waypoints}\n</gpx>\n`
}

function pointsToGeoJson(points: FieldPoint[]) {
  return {
    type: 'FeatureCollection',
    name: 'Evren Jeofizik Saha Noktaları',
    features: points.map((point) => ({
      type: 'Feature',
      geometry: { type: 'Point', coordinates: [point.lng, point.lat] },
      properties: {
        evrenType: 'field-point', name: point.name, note: point.note, description: point.description,
        symbol: point.symbol, createdAt: point.createdAt, updatedAt: point.updatedAt,
      },
    })),
  }
}

function elements(root: ParentNode, name: string) {
  return Array.from((root as Document | Element).getElementsByTagNameNS('*', name))
}

function firstText(root: ParentNode, name: string) {
  return elements(root, name)[0]?.textContent?.trim() ?? ''
}

function parseTime(value: string, fallback = Date.now()) {
  if (!value) return fallback
  const numeric = Number(value)
  if (Number.isFinite(numeric) && numeric > 0) return numeric
  const parsed = Date.parse(value)
  return Number.isFinite(parsed) ? parsed : fallback
}

function importedPoint(input: Partial<FieldPoint> & { lat: number; lng: number }, index: number): FieldPoint | null {
  if (!Number.isFinite(input.lat) || !Number.isFinite(input.lng) || input.lat < -90 || input.lat > 90 || input.lng < -180 || input.lng > 180) return null
  const now = Date.now()
  return {
    id: uid(`field-${index}`),
    name: typeof input.name === 'string' && input.name.trim() ? input.name.trim() : `Saha Noktası ${index + 1}`,
    note: typeof input.note === 'string' ? input.note.trim() : '',
    description: typeof input.description === 'string' ? input.description.trim() : '',
    lat: input.lat,
    lng: input.lng,
    symbol: normalizeSymbol(input.symbol),
    createdAt: typeof input.createdAt === 'number' ? input.createdAt : now,
    updatedAt: typeof input.updatedAt === 'number' ? input.updatedAt : now,
  }
}

function parseKml(text: string) {
  const doc = new DOMParser().parseFromString(text, 'application/xml')
  if (elements(doc, 'parsererror').length) throw new Error('KML dosyası okunamadı.')
  return elements(doc, 'Placemark').flatMap((placemark, index) => {
    const pointNode = elements(placemark, 'Point')[0]
    if (!pointNode) return []
    const [lngText, latText] = (firstText(pointNode, 'coordinates').trim().split(/\s+/)[0] ?? '').split(',')
    const data = new Map<string, string>()
    elements(placemark, 'Data').forEach((node) => {
      const key = node.getAttribute('name') || ''
      if (key) data.set(key, firstText(node, 'value'))
    })
    const point = importedPoint({
      lat: Number(latText), lng: Number(lngText), name: firstText(placemark, 'name'),
      note: data.get('evren:note') || '',
      description: data.get('evren:description') || firstText(placemark, 'description'),
      symbol: normalizeSymbol(data.get('evren:symbol')),
      createdAt: parseTime(data.get('evren:createdAt') || ''), updatedAt: parseTime(data.get('evren:updatedAt') || ''),
    }, index)
    return point ? [point] : []
  })
}

function parseGpx(text: string) {
  const doc = new DOMParser().parseFromString(text, 'application/xml')
  if (elements(doc, 'parsererror').length) throw new Error('GPX dosyası okunamadı.')
  return elements(doc, 'wpt').flatMap((waypoint, index) => {
    const point = importedPoint({
      lat: Number(waypoint.getAttribute('lat')), lng: Number(waypoint.getAttribute('lon')),
      name: firstText(waypoint, 'name'), note: firstText(waypoint, 'cmt'), description: firstText(waypoint, 'desc'),
      symbol: normalizeSymbol(firstText(waypoint, 'symbol') || firstText(waypoint, 'type')),
      createdAt: parseTime(firstText(waypoint, 'createdAt') || firstText(waypoint, 'time')),
      updatedAt: parseTime(firstText(waypoint, 'updatedAt')),
    }, index)
    return point ? [point] : []
  })
}

function parseGeoJson(text: string) {
  const value = JSON.parse(text) as { type?: string; features?: Array<{ geometry?: { type?: string; coordinates?: unknown[] }; properties?: Record<string, unknown> }> }
  if (value.type !== 'FeatureCollection' || !Array.isArray(value.features)) return []
  return value.features.flatMap((feature, index) => {
    if (feature.geometry?.type !== 'Point' || !Array.isArray(feature.geometry.coordinates)) return []
    const properties = feature.properties ?? {}
    const point = importedPoint({
      lng: Number(feature.geometry.coordinates[0]), lat: Number(feature.geometry.coordinates[1]),
      name: typeof properties.name === 'string' ? properties.name : '',
      note: typeof properties.note === 'string' ? properties.note : '',
      description: typeof properties.description === 'string' ? properties.description : '',
      symbol: normalizeSymbol(properties.symbol),
      createdAt: parseTime(properties.createdAt == null ? '' : String(properties.createdAt)),
      updatedAt: parseTime(properties.updatedAt == null ? '' : String(properties.updatedAt)),
    }, index)
    return point ? [point] : []
  })
}

async function readFieldFile(file: File) {
  const extension = file.name.toLowerCase().split('.').pop() || ''
  if (extension === 'kmz') {
    const zip = await JSZip.loadAsync(await file.arrayBuffer())
    const entry = Object.values(zip.files).find((item) => !item.dir && item.name.toLowerCase().endsWith('.kml'))
    if (!entry) throw new Error('KMZ içinde KML bulunamadı.')
    return parseKml(await entry.async('string'))
  }
  const text = await file.text()
  if (extension === 'kml') return parseKml(text)
  if (extension === 'gpx') return parseGpx(text)
  if (extension === 'geojson' || extension === 'json') return parseGeoJson(text)
  throw new Error('Desteklenmeyen saha noktası dosyası.')
}

export default function FieldPointsTransferInlineFeature() {
  const [panel, setPanel] = useState<'import' | 'export' | null>(null)
  const [host, setHost] = useState<HTMLElement | null>(null)
  const [pending, setPending] = useState<{ name: string; size: number; points: FieldPoint[] } | null>(null)
  const [reading, setReading] = useState(false)
  const [count, setCount] = useState(() => readStoredPoints().length)
  const [message, setMessage] = useState<{ text: string; error?: boolean } | null>(null)

  useEffect(() => {
    const discover = () => {
      const active = document.querySelector<HTMLButtonElement>('.bottom-dock button.is-active[data-panel-id]')
      const id = active?.dataset.panelId
      const next = id === 'import' || id === 'export' ? id : null
      setPanel(next)
      setHost(next ? document.querySelector<HTMLElement>('.workspace-panel-scroll .panel-stack > .panel-card:first-child .panel-card-body') : null)
    }
    discover()
    const observer = new MutationObserver(discover)
    observer.observe(document.body, { childList: true, subtree: true, attributes: true, attributeFilter: ['class'] })
    document.addEventListener('click', discover, true)
    return () => { observer.disconnect(); document.removeEventListener('click', discover, true) }
  }, [])

  useEffect(() => {
    const sync = () => setCount(readStoredPoints().length)
    window.addEventListener(FIELD_POINTS_CHANGED_EVENT, sync)
    window.addEventListener('storage', sync)
    return () => { window.removeEventListener(FIELD_POINTS_CHANGED_EVENT, sync); window.removeEventListener('storage', sync) }
  }, [])

  useEffect(() => {
    if (!message) return
    const timer = window.setTimeout(() => setMessage(null), 3200)
    return () => window.clearTimeout(timer)
  }, [message])

  const importFile = async (event: ChangeEvent<HTMLInputElement>) => {
    const input = event.target
    const file = input.files?.[0]
    if (!file) return
    setReading(true)
    setPending(null)
    try {
      const points = await readFieldFile(file)
      if (!points.length) throw new Error('Dosyada saha noktası bulunamadı.')
      setPending({ name: file.name, size: file.size, points })
      setMessage({ text: `${points.length} saha noktası bulundu. Önizlemeyi kontrol edin.` })
    } catch (error) {
      setMessage({ text: error instanceof Error ? error.message : 'Dosya okunamadı.', error: true })
    } finally {
      setReading(false)
      input.value = ''
    }
  }

  const confirmImport = () => {
    if (!pending) return
    const existing = readStoredPoints()
    const now = Date.now()
    const imported = pending.points.map((point, index) => ({ ...point, id: uid(`field-import-${index}`), updatedAt: now }))
    saveStoredPoints([...existing, ...imported])
    setCount(existing.length + imported.length)
    setMessage({ text: `${imported.length} saha noktası eklendi.` })
    setPending(null)
  }

  const currentProjectName = () => {
    const input = host?.querySelector<HTMLInputElement>('.form-field input')
    return safeName(input?.value || 'evren-jeofizik-projesi')
  }

  const exportPlain = (format: 'kml' | 'gpx' | 'geojson') => {
    const points = readStoredPoints()
    if (!points.length) return
    const name = `${currentProjectName()}-saha-noktalari`
    if (format === 'kml') downloadBlob(pointsToKml(points), `${name}.kml`, 'application/vnd.google-earth.kml+xml;charset=utf-8')
    if (format === 'gpx') downloadBlob(pointsToGpx(points), `${name}.gpx`, 'application/gpx+xml;charset=utf-8')
    if (format === 'geojson') downloadBlob(JSON.stringify(pointsToGeoJson(points), null, 2), `${name}.geojson`, 'application/geo+json;charset=utf-8')
    setMessage({ text: `${points.length} saha noktası ${format.toUpperCase()} olarak hazırlandı.` })
  }

  const exportKmz = async () => {
    const points = readStoredPoints()
    if (!points.length) return
    const zip = new JSZip()
    zip.file('doc.kml', pointsToKml(points))
    const blob = await zip.generateAsync({ type: 'blob', compression: 'DEFLATE', compressionOptions: { level: 6 } })
    downloadBlob(blob, `${currentProjectName()}-saha-noktalari.kmz`)
    setMessage({ text: `${points.length} saha noktası KMZ olarak hazırlandı.` })
  }

  if (!host || !panel) return null

  const status = message ? <p className={`form-note${message.error ? ' warning' : ''}`}>{message.text}</p> : null
  const commonStyle = <style>{`.field-transfer-inline{display:grid;gap:9px;margin-top:12px;padding-top:12px;border-top:1px solid #e8edf2}.field-transfer-title{display:flex;align-items:center;justify-content:space-between;gap:8px}.field-transfer-title span{display:flex;align-items:center;gap:7px}.field-transfer-title strong{font-size:10px;color:#334155}.field-transfer-title small{font-size:8px;color:#94a3b8}.field-transfer-actions{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:7px}.field-transfer-actions button{height:48px;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:3px;border:1px solid #e2e8f0;border-radius:11px;background:#f8fafc;color:#475569;font-size:9px;font-weight:800;cursor:pointer}.field-transfer-actions button:disabled{opacity:.4;cursor:not-allowed}.field-transfer-preview{display:grid;gap:7px;padding:9px;border:1px solid #fde68a;border-radius:11px;background:#fffbeb}.field-transfer-preview-head{display:flex;justify-content:space-between;gap:8px;font-size:9px}.field-transfer-preview-head small{color:#92400e}.field-transfer-preview-list{display:grid;gap:4px}.field-transfer-preview-list span{display:flex;justify-content:space-between;gap:8px;font-size:8px;color:#64748b}.field-transfer-preview-list strong{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:#334155}.field-transfer-confirm{display:flex;gap:7px}.field-transfer-confirm button{flex:1;height:31px;display:flex;align-items:center;justify-content:center;gap:5px;border:0;border-radius:8px;font-size:9px;font-weight:800;cursor:pointer}.field-transfer-confirm button:first-child{background:#eef2f6;color:#64748b}.field-transfer-confirm button:last-child{background:#2563eb;color:white}@media(max-width:700px){.field-transfer-actions{grid-template-columns:repeat(2,minmax(0,1fr))}}`}</style>

  if (panel === 'import') return createPortal(
    <section className="field-transfer-inline">
      {commonStyle}
      <div className="field-transfer-title"><span><MapPinned size={16} /><strong>Saha Noktaları</strong></span><small>KML · KMZ · GPX · GeoJSON</small></div>
      <label className={`dropzone${reading ? ' is-busy' : ''}`}><Upload size={25} /><strong>{reading ? 'Saha noktaları okunuyor…' : 'Saha noktası dosyası seç'}</strong><small>Mevcut saha noktalarına eklenir</small><input type="file" accept=".kml,.kmz,.gpx,.geojson,.json,application/gpx+xml" onChange={importFile} disabled={reading} /></label>
      {pending && <div className="field-transfer-preview"><div className="field-transfer-preview-head"><strong>{pending.points.length} saha noktası bulundu</strong><small>{pending.name} · {(pending.size / 1024).toFixed(1)} KB</small></div><div className="field-transfer-preview-list">{pending.points.slice(0, 5).map((point) => <span key={point.id}><strong>{point.name}</strong><small>{point.lat.toFixed(5)}, {point.lng.toFixed(5)}</small></span>)}</div><div className="field-transfer-confirm"><button type="button" onClick={() => setPending(null)}><X size={14} /> Vazgeç</button><button type="button" onClick={confirmImport}><CheckCircle2 size={14} /> Saha Noktalarına Ekle</button></div></div>}
      {status}
    </section>, host,
  )

  return createPortal(
    <section className="field-transfer-inline">
      {commonStyle}
      <div className="field-transfer-title"><span><MapPinned size={16} /><strong>Saha Noktaları</strong></span><small>{count} kayıt · üstteki dosya adı kullanılır</small></div>
      <div className="field-transfer-actions">
        <button type="button" disabled={!count} onClick={() => exportPlain('kml')}><FileDown size={17} />KML</button>
        <button type="button" disabled={!count} onClick={() => void exportKmz()}><FileDown size={17} />KMZ</button>
        <button type="button" disabled={!count} onClick={() => exportPlain('gpx')}><FileDown size={17} />GPX</button>
        <button type="button" disabled={!count} onClick={() => exportPlain('geojson')}><FileDown size={17} />GeoJSON</button>
      </div>
      <p className="form-note">Ad, koordinat, sembol, not ve açıklama korunur. Fotoğraflar cihazdaki saha kaydında kalır.</p>
      {status}
    </section>, host,
  )
}
