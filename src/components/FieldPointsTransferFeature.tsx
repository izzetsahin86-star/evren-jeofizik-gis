import { useEffect, useState, type ChangeEvent } from 'react'
import { createPortal } from 'react-dom'
import JSZip from 'jszip'
import { CheckCircle2, Download, FileDown, FileUp, MapPinned, Upload, X } from 'lucide-react'
import { Card, Field } from './PanelUi'

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
      return [{
        id: typeof value.id === 'string' && value.id ? value.id : uid(`field-${index}`),
        name: typeof value.name === 'string' && value.name.trim() ? value.name : `Saha Noktası ${index + 1}`,
        note: typeof value.note === 'string' ? value.note : '',
        description: typeof value.description === 'string' ? value.description : '',
        lat,
        lng,
        symbol: normalizeSymbol(value.symbol),
        photoId: typeof value.photoId === 'string' && value.photoId ? value.photoId : undefined,
        createdAt: typeof value.createdAt === 'number' ? value.createdAt : Date.now(),
        updatedAt: typeof value.updatedAt === 'number' ? value.updatedAt : Date.now(),
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
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&apos;')
}

function safeFileName(value: string) {
  return value.trim().replace(/[^a-zA-Z0-9ğüşöçıİĞÜŞÖÇ_-]+/g, '-') || 'evren-saha-noktalari'
}

function downloadBlob(blob: Blob | string, filename: string, mimeType?: string) {
  const value = typeof blob === 'string' ? new Blob([blob], { type: mimeType ?? 'text/plain;charset=utf-8' }) : blob
  const url = URL.createObjectURL(value)
  const anchor = document.createElement('a')
  anchor.href = url
  anchor.download = filename
  document.body.appendChild(anchor)
  anchor.click()
  anchor.remove()
  window.setTimeout(() => URL.revokeObjectURL(url), 1000)
}

function pointToKml(point: FieldPoint) {
  return `    <Placemark>\n      <name>${xmlEscape(point.name)}</name>\n      <description>${xmlEscape(point.description)}</description>\n      <ExtendedData>\n        <Data name="evren:type"><value>field-point</value></Data>\n        <Data name="evren:symbol"><value>${xmlEscape(point.symbol)}</value></Data>\n        <Data name="evren:note"><value>${xmlEscape(point.note)}</value></Data>\n        <Data name="evren:description"><value>${xmlEscape(point.description)}</value></Data>\n        <Data name="evren:createdAt"><value>${point.createdAt}</value></Data>\n        <Data name="evren:updatedAt"><value>${point.updatedAt}</value></Data>\n      </ExtendedData>\n      <Point><coordinates>${point.lng},${point.lat},0</coordinates></Point>\n    </Placemark>`
}

function pointsToKml(points: FieldPoint[]) {
  return `<?xml version="1.0" encoding="UTF-8"?>\n<kml xmlns="http://www.opengis.net/kml/2.2">\n  <Document>\n    <name>Evren Jeofizik Saha Noktaları</name>\n${points.map(pointToKml).join('\n')}\n  </Document>\n</kml>\n`
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
        evrenType: 'field-point',
        name: point.name,
        note: point.note,
        description: point.description,
        symbol: point.symbol,
        createdAt: point.createdAt,
        updatedAt: point.updatedAt,
      },
    })),
  }
}

function elementsByLocalName(root: ParentNode, localName: string) {
  return Array.from((root as Document | Element).getElementsByTagNameNS('*', localName))
}

function firstText(root: ParentNode, localName: string) {
  return elementsByLocalName(root, localName)[0]?.textContent?.trim() ?? ''
}

function parseTime(value: string | null | undefined, fallback: number) {
  if (!value) return fallback
  const numeric = Number(value)
  if (Number.isFinite(numeric) && numeric > 0) return numeric
  const date = Date.parse(value)
  return Number.isFinite(date) ? date : fallback
}

function buildImportedPoint(input: Partial<FieldPoint> & { lat: number; lng: number }, index: number): FieldPoint | null {
  if (!Number.isFinite(input.lat) || !Number.isFinite(input.lng) || input.lat < -90 || input.lat > 90 || input.lng < -180 || input.lng > 180) return null
  const now = Date.now()
  return {
    id: uid(`field-import-${index}`),
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
  if (elementsByLocalName(doc, 'parsererror').length) throw new Error('KML dosyası okunamadı.')
  return elementsByLocalName(doc, 'Placemark').flatMap((placemark, index) => {
    const pointNode = elementsByLocalName(placemark, 'Point')[0]
    if (!pointNode) return []
    const coordinateText = firstText(pointNode, 'coordinates')
    const [lngText, latText] = coordinateText.trim().split(/\s+/)[0]?.split(',') ?? []
    const lat = Number(latText)
    const lng = Number(lngText)
    const extended = new Map<string, string>()
    elementsByLocalName(placemark, 'Data').forEach((dataNode) => {
      const key = dataNode.getAttribute('name') || ''
      const value = firstText(dataNode, 'value')
      if (key) extended.set(key, value)
    })
    const description = extended.get('evren:description') || firstText(placemark, 'description')
    const point = buildImportedPoint({
      lat,
      lng,
      name: firstText(placemark, 'name'),
      note: extended.get('evren:note') || '',
      description,
      symbol: normalizeSymbol(extended.get('evren:symbol')),
      createdAt: parseTime(extended.get('evren:createdAt'), Date.now()),
      updatedAt: parseTime(extended.get('evren:updatedAt'), Date.now()),
    }, index)
    return point ? [point] : []
  })
}

function parseGpx(text: string) {
  const doc = new DOMParser().parseFromString(text, 'application/xml')
  if (elementsByLocalName(doc, 'parsererror').length) throw new Error('GPX dosyası okunamadı.')
  return elementsByLocalName(doc, 'wpt').flatMap((waypoint, index) => {
    const lat = Number(waypoint.getAttribute('lat'))
    const lng = Number(waypoint.getAttribute('lon'))
    const extensionSymbol = firstText(waypoint, 'symbol')
    const point = buildImportedPoint({
      lat,
      lng,
      name: firstText(waypoint, 'name'),
      note: firstText(waypoint, 'cmt'),
      description: firstText(waypoint, 'desc'),
      symbol: normalizeSymbol(extensionSymbol || firstText(waypoint, 'type')),
      createdAt: parseTime(firstText(waypoint, 'createdAt') || firstText(waypoint, 'time'), Date.now()),
      updatedAt: parseTime(firstText(waypoint, 'updatedAt'), Date.now()),
    }, index)
    return point ? [point] : []
  })
}

function parseGeoJson(text: string) {
  const value = JSON.parse(text) as { type?: string; features?: Array<{ geometry?: { type?: string; coordinates?: unknown[] }; properties?: Record<string, unknown> }> }
  const features = value.type === 'FeatureCollection' && Array.isArray(value.features) ? value.features : []
  return features.flatMap((feature, index) => {
    if (feature.geometry?.type !== 'Point' || !Array.isArray(feature.geometry.coordinates)) return []
    const lng = Number(feature.geometry.coordinates[0])
    const lat = Number(feature.geometry.coordinates[1])
    const properties = feature.properties ?? {}
    const point = buildImportedPoint({
      lat,
      lng,
      name: typeof properties.name === 'string' ? properties.name : '',
      note: typeof properties.note === 'string' ? properties.note : '',
      description: typeof properties.description === 'string' ? properties.description : '',
      symbol: normalizeSymbol(properties.symbol),
      createdAt: parseTime(typeof properties.createdAt === 'string' || typeof properties.createdAt === 'number' ? String(properties.createdAt) : '', Date.now()),
      updatedAt: parseTime(typeof properties.updatedAt === 'string' || typeof properties.updatedAt === 'number' ? String(properties.updatedAt) : '', Date.now()),
    }, index)
    return point ? [point] : []
  })
}

async function readFieldPointFile(file: File) {
  const extension = file.name.toLowerCase().split('.').pop() || ''
  if (extension === 'kmz') {
    const zip = await JSZip.loadAsync(await file.arrayBuffer())
    const kmlEntry = Object.values(zip.files).find((entry) => !entry.dir && entry.name.toLowerCase().endsWith('.kml'))
    if (!kmlEntry) throw new Error('KMZ içinde KML bulunamadı.')
    return parseKml(await kmlEntry.async('string'))
  }
  const text = await file.text()
  if (extension === 'kml') return parseKml(text)
  if (extension === 'gpx') return parseGpx(text)
  if (extension === 'geojson' || extension === 'json') return parseGeoJson(text)
  throw new Error('Desteklenmeyen saha noktası dosyası.')
}

export default function FieldPointsTransferFeature() {
  const [panel, setPanel] = useState<'import' | 'export' | null>(null)
  const [host, setHost] = useState<HTMLElement | null>(null)
  const [pendingImport, setPendingImport] = useState<{ name: string; size: number; points: FieldPoint[] } | null>(null)
  const [reading, setReading] = useState(false)
  const [filename, setFilename] = useState('evren-saha-noktalari')
  const [pointCount, setPointCount] = useState(() => readStoredPoints().length)
  const [message, setMessage] = useState<{ text: string; tone: 'success' | 'error' | 'info' } | null>(null)

  useEffect(() => {
    const discover = () => {
      const active = document.querySelector<HTMLButtonElement>('.bottom-dock button.is-active[data-panel-id]')
      const id = active?.dataset.panelId
      const nextPanel = id === 'import' || id === 'export' ? id : null
      setPanel(nextPanel)
      setHost(nextPanel ? document.querySelector<HTMLElement>('.workspace-panel-scroll .panel-stack') : null)
    }
    discover()
    const observer = new MutationObserver(discover)
    observer.observe(document.body, { childList: true, subtree: true, attributes: true, attributeFilter: ['class'] })
    document.addEventListener('click', discover, true)
    return () => {
      observer.disconnect()
      document.removeEventListener('click', discover, true)
    }
  }, [])

  useEffect(() => {
    const sync = () => setPointCount(readStoredPoints().length)
    window.addEventListener(FIELD_POINTS_CHANGED_EVENT, sync)
    window.addEventListener('storage', sync)
    return () => {
      window.removeEventListener(FIELD_POINTS_CHANGED_EVENT, sync)
      window.removeEventListener('storage', sync)
    }
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
    setPendingImport(null)
    try {
      const points = await readFieldPointFile(file)
      if (!points.length) throw new Error('Dosyada saha noktası bulunamadı.')
      setPendingImport({ name: file.name, size: file.size, points })
      setMessage({ text: `${points.length} saha noktası bulundu. Önizlemeyi kontrol edin.`, tone: 'info' })
    } catch (error) {
      setMessage({ text: error instanceof Error ? error.message : 'Dosya okunamadı.', tone: 'error' })
    } finally {
      setReading(false)
      input.value = ''
    }
  }

  const confirmImport = () => {
    if (!pendingImport) return
    const existing = readStoredPoints()
    const now = Date.now()
    const imported = pendingImport.points.map((point, index) => ({ ...point, id: uid(`field-import-${index}`), updatedAt: now }))
    saveStoredPoints([...existing, ...imported])
    setPointCount(existing.length + imported.length)
    setMessage({ text: `${imported.length} saha noktası eklendi.`, tone: 'success' })
    setPendingImport(null)
  }

  const exportPlain = (format: 'kml' | 'gpx' | 'geojson') => {
    const points = readStoredPoints()
    if (!points.length) return
    const name = safeFileName(filename)
    if (format === 'kml') downloadBlob(pointsToKml(points), `${name}.kml`, 'application/vnd.google-earth.kml+xml;charset=utf-8')
    if (format === 'gpx') downloadBlob(pointsToGpx(points), `${name}.gpx`, 'application/gpx+xml;charset=utf-8')
    if (format === 'geojson') downloadBlob(JSON.stringify(pointsToGeoJson(points), null, 2), `${name}.geojson`, 'application/geo+json;charset=utf-8')
    setMessage({ text: `${points.length} saha noktası ${format.toUpperCase()} olarak hazırlandı.`, tone: 'success' })
  }

  const exportKmz = async () => {
    const points = readStoredPoints()
    if (!points.length) return
    const name = safeFileName(filename)
    const zip = new JSZip()
    zip.file('doc.kml', pointsToKml(points))
    const blob = await zip.generateAsync({ type: 'blob', compression: 'DEFLATE', compressionOptions: { level: 6 } })
    downloadBlob(blob, `${name}.kmz`)
    setMessage({ text: `${points.length} saha noktası KMZ olarak hazırlandı.`, tone: 'success' })
  }

  if (!host || !panel) return null

  const status = message ? <p className={`form-note${message.tone === 'error' ? ' warning' : ''}`}>{message.text}</p> : null

  if (panel === 'import') return createPortal(
    <>
      <Card title="Saha Noktaları İçe Aktar" subtitle="Waypoint verilerini mevcut saha noktalarına ekler" icon={<MapPinned size={19} />} tone="purple">
        <label className={`dropzone tall${reading ? ' is-busy' : ''}`}><Upload size={30} /><strong>{reading ? 'Saha noktaları okunuyor…' : 'Saha noktası dosyası seç'}</strong><small>KML, KMZ, GPX, GeoJSON ve JSON</small><input type="file" accept=".kml,.kmz,.gpx,.geojson,.json,application/gpx+xml" onChange={importFile} disabled={reading} /></label>
        <p className="form-note">İçe aktarılan noktalar mevcut saha noktalarını silmez; listeye eklenir.</p>
        {status}
      </Card>
      {pendingImport && (
        <Card title="Saha Noktası Önizlemesi" subtitle={`${pendingImport.name} · ${(pendingImport.size / 1024).toFixed(1)} KB`} icon={<FileUp size={19} />} tone="amber">
          <div className="import-summary"><span><small>Saha Noktası</small><strong>{pendingImport.points.length}</strong></span><span><small>Sembollü</small><strong>{pendingImport.points.filter((point) => point.symbol !== 'pin').length}</strong></span><span><small>Not / Açıklama</small><strong>{pendingImport.points.filter((point) => point.note || point.description).length}</strong></span></div>
          <div className="import-preview-list">{pendingImport.points.slice(0, 10).map((point) => <div key={point.id}><span style={{ background: '#2563eb' }} /><strong>{point.name}</strong><small>{point.lat.toFixed(6)}, {point.lng.toFixed(6)} · {point.symbol}</small></div>)}{pendingImport.points.length > 10 && <p>+ {pendingImport.points.length - 10} nokta daha</p>}</div>
          <div className="preview-actions"><button type="button" className="secondary-button" onClick={() => setPendingImport(null)}><X size={16} /> Vazgeç</button><button type="button" className="primary-button" onClick={confirmImport}><CheckCircle2 size={17} /> Saha Noktalarına Ekle</button></div>
        </Card>
      )}
    </>,
    host,
  )

  return createPortal(
    <Card title="Saha Noktaları Dışa Aktar" subtitle={`${pointCount} saha noktası · ad, not, açıklama ve sembol korunur`} icon={<Download size={19} />} tone="purple">
      <Field label="Dosya adı"><input value={filename} onChange={(event) => setFilename(event.target.value)} placeholder="evren-saha-noktalari" /></Field>
      <div className="export-grid">
        <button type="button" disabled={!pointCount} onClick={() => exportPlain('kml')}><FileDown size={20} /><strong>KML</strong></button>
        <button type="button" disabled={!pointCount} onClick={() => void exportKmz()}><FileDown size={20} /><strong>KMZ</strong></button>
        <button type="button" disabled={!pointCount} onClick={() => exportPlain('gpx')}><FileDown size={20} /><strong>GPX</strong></button>
        <button type="button" disabled={!pointCount} onClick={() => exportPlain('geojson')}><FileDown size={20} /><strong>GeoJSON</strong></button>
      </div>
      {!pointCount && <p className="form-note warning">Dışa aktarmak için en az bir Saha noktası ekleyin.</p>}
      <p className="form-note">Fotoğraflar cihazdaki saha kaydında korunur; bu dört aktarım dosyasına gömülmez.</p>
      {status}
    </Card>,
    host,
  )
}
