import { useEffect, useMemo, useState, type ChangeEvent } from 'react'
import { createPortal } from 'react-dom'
import JSZip from 'jszip'
import { CheckCircle2, FileDown, Upload, X } from 'lucide-react'
import { DEFAULT_EXPORT_POLYGON_STYLE } from '../exportStyle'
import { formatPoint, polygonsToGeoJson, polygonsToKml, readSpatialFile } from '../geo'
import type { CoordinateFormat, ExportPolygonStyle, PolygonLayer } from '../types'
import ExportPolygonStyleControls from './ExportPolygonStyleControls'

const FIELD_POINTS_KEY = 'evren-jeofizik-gis-field-points-v1'
const WORKSPACE_KEY = 'evren-jeofizik-gis-workspace-v1'
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

type PendingImport = {
  file: File
  name: string
  size: number
  layers: PolygonLayer[]
  fieldPoints: FieldPoint[]
}

const SYMBOLS: FieldPointSymbol[] = ['pin', 'flag', 'camera', 'warning', 'sample', 'target', 'note', 'vehicle']
const COORDINATE_OPTIONS: Array<{ value: CoordinateFormat; label: string }> = [
  { value: 'latlon', label: 'Lat / Lon' },
  { value: 'utm', label: 'UTM' },
  { value: 'dms', label: 'DMS' },
  { value: 'ddm', label: 'DDM' },
]

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

function readStoredPolygons(): PolygonLayer[] {
  try {
    const values = JSON.parse(localStorage.getItem(WORKSPACE_KEY) || '[]') as Partial<PolygonLayer>[]
    if (!Array.isArray(values)) return []
    return values.flatMap((value, index) => {
      if (!Array.isArray(value.points) || !Array.isArray(value.desPoints)) return []
      return [{
        id: value.id || `polygon-${index}`,
        name: value.name || `Poligon ${index + 1}`,
        color: value.color || '#1597e5',
        strokeWidth: value.strokeWidth,
        strokeOpacity: value.strokeOpacity,
        fillOpacity: value.fillOpacity,
        points: value.points,
        desPoints: value.desPoints,
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

function csvEscape(value: string | number) {
  const text = String(value ?? '')
  return `"${text.replaceAll('"', '""')}"`
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

function fieldPointPlacemark(point: FieldPoint) {
  return `<Placemark><name>${xmlEscape(point.name)}</name><description>${xmlEscape(point.description)}</description><ExtendedData><Data name="evren:type"><value>field-point</value></Data><Data name="evren:symbol"><value>${xmlEscape(point.symbol)}</value></Data><Data name="evren:note"><value>${xmlEscape(point.note)}</value></Data><Data name="evren:description"><value>${xmlEscape(point.description)}</value></Data><Data name="evren:createdAt"><value>${point.createdAt}</value></Data><Data name="evren:updatedAt"><value>${point.updatedAt}</value></Data></ExtendedData><Point><coordinates>${point.lng},${point.lat},0</coordinates></Point></Placemark>`
}

function combinedKml(polygons: PolygonLayer[], points: FieldPoint[], style?: ExportPolygonStyle) {
  const spatial = polygons.filter((layer) => layer.points.length || layer.desPoints.length)
  const field = points.map(fieldPointPlacemark).join('')
  if (!spatial.length) return `<?xml version="1.0" encoding="UTF-8"?><kml xmlns="http://www.opengis.net/kml/2.2"><Document><name>Evren Jeofizik</name>${field}</Document></kml>`
  return polygonsToKml(spatial, style).replace('</Document>', `${field}</Document>`)
}

function combinedGeoJson(polygons: PolygonLayer[], points: FieldPoint[], style?: ExportPolygonStyle) {
  const spatial = polygonsToGeoJson(polygons.filter((layer) => layer.points.length), style) as { type: string; features: any[] }
  const desFeatures = polygons.flatMap((layer) => layer.desPoints.map((point) => ({
    type: 'Feature',
    geometry: { type: 'Point', coordinates: [point.lng, point.lat] },
    properties: { evrenType: 'des-point', name: point.name || 'DES', parentLayerId: layer.id, parentLayerName: layer.name },
  })))
  const fieldFeatures = points.map((point) => ({
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
  }))
  return { type: 'FeatureCollection', name: 'Evren Jeofizik Projesi', features: [...spatial.features, ...desFeatures, ...fieldFeatures] }
}

function combinedCsv(polygons: PolygonLayer[], points: FieldPoint[], format: CoordinateFormat) {
  const rows = ['Tür,Katman / Nokta,Sıra,Koordinat,Sembol,Not,Açıklama']
  polygons.forEach((layer) => {
    layer.points.forEach((point, index) => rows.push([
      csvEscape(layer.points.length >= 3 ? 'Poligon' : 'Hat'),
      csvEscape(layer.name),
      index + 1,
      csvEscape(formatPoint(point, format)),
      '', '', '',
    ].join(',')))
    layer.desPoints.forEach((point, index) => rows.push([
      csvEscape('DES'),
      csvEscape(point.name || layer.name),
      index + 1,
      csvEscape(formatPoint(point, format)),
      '', '', '',
    ].join(',')))
  })
  points.forEach((point, index) => rows.push([
    csvEscape('Saha Noktası'),
    csvEscape(point.name),
    index + 1,
    csvEscape(formatPoint({ id: point.id, lat: point.lat, lng: point.lng }, format)),
    csvEscape(point.symbol),
    csvEscape(point.note),
    csvEscape(point.description),
  ].join(',')))
  return rows.join('\n')
}

function combinedGpx(polygons: PolygonLayer[], points: FieldPoint[]) {
  const fieldWaypoints = points.map((point) => `<wpt lat="${point.lat}" lon="${point.lng}"><name>${xmlEscape(point.name)}</name><cmt>${xmlEscape(point.note)}</cmt><desc>${xmlEscape(point.description)}</desc><type>${xmlEscape(point.symbol)}</type><extensions><evren:kind>field-point</evren:kind><evren:symbol>${xmlEscape(point.symbol)}</evren:symbol><evren:createdAt>${point.createdAt}</evren:createdAt><evren:updatedAt>${point.updatedAt}</evren:updatedAt></extensions></wpt>`).join('')
  const desWaypoints = polygons.flatMap((layer) => layer.desPoints.map((point) => `<wpt lat="${point.lat}" lon="${point.lng}"><name>${xmlEscape(point.name || 'DES')}</name><type>DES</type><extensions><evren:kind>des-point</evren:kind><evren:parentLayer>${xmlEscape(layer.name)}</evren:parentLayer></extensions></wpt>`)).join('')
  const tracks = polygons.filter((layer) => layer.points.length).map((layer) => {
    const trackPoints = layer.points.length >= 3 ? [...layer.points, layer.points[0]] : layer.points
    return `<trk><name>${xmlEscape(layer.name)}</name><extensions><evren:kind>${layer.points.length >= 3 ? 'polygon' : 'line'}</evren:kind></extensions><trkseg>${trackPoints.map((point) => `<trkpt lat="${point.lat}" lon="${point.lng}"></trkpt>`).join('')}</trkseg></trk>`
  }).join('')
  return `<?xml version="1.0" encoding="UTF-8"?><gpx version="1.1" creator="Evren Jeofizik GIS" xmlns="http://www.topografix.com/GPX/1/1" xmlns:evren="https://evrenjeofizik.com/gis">${fieldWaypoints}${desWaypoints}${tracks}</gpx>`
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

function parseFieldKml(text: string) {
  const doc = new DOMParser().parseFromString(text, 'application/xml')
  if (elements(doc, 'parsererror').length) throw new Error('KML dosyası okunamadı.')
  const hasSpatialGeometry = elements(doc, 'Polygon').length > 0 || elements(doc, 'LineString').length > 0
  return elements(doc, 'Placemark').flatMap((placemark, index) => {
    const pointNode = elements(placemark, 'Point')[0]
    if (!pointNode) return []
    const data = new Map<string, string>()
    elements(placemark, 'Data').forEach((node) => {
      const key = node.getAttribute('name') || ''
      if (key) data.set(key, firstText(node, 'value'))
    })
    const kind = data.get('evren:type') || ''
    if (kind === 'des-point') return []
    if (hasSpatialGeometry && kind !== 'field-point') return []
    const [lngText, latText] = (firstText(pointNode, 'coordinates').trim().split(/\s+/)[0] ?? '').split(',')
    const point = importedPoint({
      lat: Number(latText),
      lng: Number(lngText),
      name: firstText(placemark, 'name'),
      note: data.get('evren:note') || '',
      description: data.get('evren:description') || firstText(placemark, 'description'),
      symbol: normalizeSymbol(data.get('evren:symbol')),
      createdAt: parseTime(data.get('evren:createdAt') || ''),
      updatedAt: parseTime(data.get('evren:updatedAt') || ''),
    }, index)
    return point ? [point] : []
  })
}

function parseFieldGpx(text: string) {
  const doc = new DOMParser().parseFromString(text, 'application/xml')
  if (elements(doc, 'parsererror').length) throw new Error('GPX dosyası okunamadı.')
  return elements(doc, 'wpt').flatMap((waypoint, index) => {
    if (firstText(waypoint, 'kind') === 'des-point') return []
    const point = importedPoint({
      lat: Number(waypoint.getAttribute('lat')),
      lng: Number(waypoint.getAttribute('lon')),
      name: firstText(waypoint, 'name'),
      note: firstText(waypoint, 'cmt'),
      description: firstText(waypoint, 'desc'),
      symbol: normalizeSymbol(firstText(waypoint, 'symbol') || firstText(waypoint, 'type')),
      createdAt: parseTime(firstText(waypoint, 'createdAt') || firstText(waypoint, 'time')),
      updatedAt: parseTime(firstText(waypoint, 'updatedAt')),
    }, index)
    return point ? [point] : []
  })
}

function parseFieldGeoJson(text: string) {
  const value = JSON.parse(text) as { type?: string; features?: Array<{ geometry?: { type?: string; coordinates?: unknown[] }; properties?: Record<string, unknown> }> }
  if (value.type !== 'FeatureCollection' || !Array.isArray(value.features)) return []
  return value.features.flatMap((feature, index) => {
    if (feature.geometry?.type !== 'Point' || !Array.isArray(feature.geometry.coordinates)) return []
    const properties = feature.properties ?? {}
    if (properties.evrenType === 'des-point') return []
    const point = importedPoint({
      lng: Number(feature.geometry.coordinates[0]),
      lat: Number(feature.geometry.coordinates[1]),
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

async function readFieldPoints(file: File) {
  const extension = file.name.toLowerCase().split('.').pop() || ''
  if (extension === 'csv') return []
  if (extension === 'kmz') {
    const zip = await JSZip.loadAsync(await file.arrayBuffer())
    const entry = Object.values(zip.files).find((item) => !item.dir && item.name.toLowerCase().endsWith('.kml'))
    if (!entry) throw new Error('KMZ içinde KML bulunamadı.')
    return parseFieldKml(await entry.async('string'))
  }
  const text = await file.text()
  if (extension === 'kml') return parseFieldKml(text)
  if (extension === 'gpx') return parseFieldGpx(text)
  if (extension === 'geojson' || extension === 'json') return parseFieldGeoJson(text)
  return []
}

function setFileOnInput(input: HTMLInputElement, file: File) {
  const transfer = new DataTransfer()
  transfer.items.add(file)
  input.files = transfer.files
  input.dispatchEvent(new Event('change', { bubbles: true }))
}

async function waitForOriginalConfirm(host: HTMLElement, timeoutMs = 3000) {
  const stack = host.closest('.panel-stack')
  const started = Date.now()
  while (Date.now() - started < timeoutMs) {
    const button = Array.from(stack?.querySelectorAll<HTMLButtonElement>('button') ?? []).find((item) => item.textContent?.includes('Haritaya Ekle'))
    if (button) return button
    await new Promise((resolve) => window.setTimeout(resolve, 60))
  }
  return null
}

export default function FieldPointsTransferInlineFeature() {
  const [panel, setPanel] = useState<'import' | 'export' | null>(null)
  const [host, setHost] = useState<HTMLElement | null>(null)
  const [pending, setPending] = useState<PendingImport | null>(null)
  const [reading, setReading] = useState(false)
  const [filename, setFilename] = useState('evren-jeofizik-projesi')
  const [csvFormat, setCsvFormat] = useState<CoordinateFormat>('latlon')
  const [exportStyle, setExportStyle] = useState(DEFAULT_EXPORT_POLYGON_STYLE)
  const [fieldCount, setFieldCount] = useState(() => readStoredPoints().length)
  const [message, setMessage] = useState<{ text: string; error?: boolean } | null>(null)

  const projectStats = useMemo(() => {
    if (!panel) return { layers: 0, polygonPoints: 0, des: 0, field: fieldCount }
    const polygons = readStoredPolygons()
    return {
      layers: polygons.filter((layer) => layer.points.length).length,
      polygonPoints: polygons.reduce((sum, layer) => sum + layer.points.length, 0),
      des: polygons.reduce((sum, layer) => sum + layer.desPoints.length, 0),
      field: fieldCount,
    }
  }, [fieldCount, panel])

  useEffect(() => {
    const discover = () => {
      const active = document.querySelector<HTMLButtonElement>('.smart-dock button.is-active[data-panel-id], .smart-dock-menu button.is-active[data-panel-id]')
      const id = active?.dataset.panelId
      const next = id === 'import' || id === 'export' ? id : null
      const nextHost = next ? document.querySelector<HTMLElement>('.smart-sheet-body .panel-stack > .panel-card:first-child .panel-card-body') : null
      setPanel(next)
      setHost(nextHost)
    }
    discover()
    const observer = new MutationObserver(discover)
    observer.observe(document.body, { childList: true, subtree: true, attributes: true, attributeFilter: ['class'] })
    document.addEventListener('click', discover, true)
    return () => { observer.disconnect(); document.removeEventListener('click', discover, true) }
  }, [])

  useEffect(() => {
    const sync = () => setFieldCount(readStoredPoints().length)
    window.addEventListener(FIELD_POINTS_CHANGED_EVENT, sync)
    window.addEventListener('storage', sync)
    return () => { window.removeEventListener(FIELD_POINTS_CHANGED_EVENT, sync); window.removeEventListener('storage', sync) }
  }, [])

  useEffect(() => {
    if (!message) return
    const timer = window.setTimeout(() => setMessage(null), 3600)
    return () => window.clearTimeout(timer)
  }, [message])

  useEffect(() => {
    if (!host || !panel) return
    const card = host.closest<HTMLElement>('.panel-card')
    const heading = card?.querySelector<HTMLElement>('.panel-card-header h2')
    const subtitle = card?.querySelector<HTMLElement>('.panel-card-header p')
    const oldHeading = heading?.textContent || ''
    const oldSubtitle = subtitle?.textContent || ''
    if (heading) heading.textContent = panel === 'import' ? 'İçe Aktar' : 'Dışa Aktar'
    if (subtitle) subtitle.textContent = panel === 'import' ? 'Proje verisini tek dosyadan otomatik algıla ve ekle' : 'Poligon, DES ve Saha Noktalarını tek dosyada dışa aktar'

    Array.from(host.children).forEach((child) => {
      const element = child as HTMLElement
      if (!element.hasAttribute('data-unified-transfer-root')) element.style.display = 'none'
    })

    const stack = host.closest<HTMLElement>('.panel-stack')
    const hideLegacyPreview = () => {
      if (panel !== 'import' || !stack) return
      Array.from(stack.querySelectorAll<HTMLElement>(':scope > .panel-card')).forEach((item, index) => {
        if (index === 0) return
        if (item.querySelector('h2')?.textContent?.includes('İçe Aktarma Önizlemesi')) item.style.display = 'none'
      })
    }
    hideLegacyPreview()
    const observer = new MutationObserver(hideLegacyPreview)
    if (stack) observer.observe(stack, { childList: true, subtree: true })

    return () => {
      observer.disconnect()
      Array.from(host.children).forEach((child) => (child as HTMLElement).style.removeProperty('display'))
      if (heading) heading.textContent = oldHeading
      if (subtitle) subtitle.textContent = oldSubtitle
    }
  }, [host, panel])

  const importFile = async (event: ChangeEvent<HTMLInputElement>) => {
    const input = event.target
    const file = input.files?.[0]
    if (!file) return
    setReading(true)
    setPending(null)
    setMessage(null)
    try {
      const lower = file.name.toLowerCase()
      let layers: PolygonLayer[] = []
      if (!lower.endsWith('.gpx')) {
        try { layers = await readSpatialFile(file) } catch { layers = [] }
      }
      const fieldPoints = await readFieldPoints(file)
      if (!layers.length && !fieldPoints.length) throw new Error('Dosyada desteklenen poligon, hat veya Saha Noktası bulunamadı.')
      setPending({ file, name: file.name, size: file.size, layers, fieldPoints })

      if (layers.length && host) {
        const originalInput = host.querySelector<HTMLInputElement>('input[type="file"]')
        if (originalInput) setFileOnInput(originalInput, file)
      }
      setMessage({ text: `${layers.length} katman ve ${fieldPoints.length} Saha Noktası bulundu. Önizlemeyi kontrol edin.` })
    } catch (error) {
      setMessage({ text: error instanceof Error ? error.message : 'Dosya okunamadı.', error: true })
    } finally {
      setReading(false)
      input.value = ''
    }
  }

  const confirmImport = async () => {
    if (!pending || !host) return
    setReading(true)
    try {
      if (pending.layers.length) {
        let confirm = await waitForOriginalConfirm(host)
        if (!confirm) {
          const originalInput = host.querySelector<HTMLInputElement>('input[type="file"]')
          if (originalInput) setFileOnInput(originalInput, pending.file)
          confirm = await waitForOriginalConfirm(host)
        }
        if (!confirm) throw new Error('Mekânsal katmanlar hazırlanamadı. Dosyayı yeniden seçin.')
        confirm.click()
      }

      if (pending.fieldPoints.length) {
        const existing = readStoredPoints()
        const now = Date.now()
        const imported = pending.fieldPoints.map((point, index) => ({ ...point, id: uid(`field-import-${index}`), updatedAt: now }))
        saveStoredPoints([...existing, ...imported])
        setFieldCount(existing.length + imported.length)
      }

      setMessage({ text: `${pending.layers.length} katman ve ${pending.fieldPoints.length} Saha Noktası projeye eklendi.` })
      setPending(null)
    } catch (error) {
      setMessage({ text: error instanceof Error ? error.message : 'İçe aktarma tamamlanamadı.', error: true })
    } finally {
      setReading(false)
    }
  }

  const exportProject = async (format: 'kml' | 'kmz' | 'geojson' | 'csv' | 'gpx') => {
    const polygons = readStoredPolygons()
    const points = readStoredPoints()
    const hasData = polygons.some((layer) => layer.points.length || layer.desPoints.length) || points.length > 0
    if (!hasData) {
      setMessage({ text: 'Dışa aktarmak için proje verisi ekleyin.', error: true })
      return
    }
    const name = safeName(filename)
    if (format === 'kml') downloadBlob(combinedKml(polygons, points, exportStyle), `${name}.kml`, 'application/vnd.google-earth.kml+xml;charset=utf-8')
    if (format === 'kmz') {
      const zip = new JSZip()
      zip.file('doc.kml', combinedKml(polygons, points, exportStyle))
      downloadBlob(await zip.generateAsync({ type: 'blob', compression: 'DEFLATE', compressionOptions: { level: 6 } }), `${name}.kmz`, 'application/vnd.google-earth.kmz')
    }
    if (format === 'geojson') downloadBlob(JSON.stringify(combinedGeoJson(polygons, points, exportStyle), null, 2), `${name}.geojson`, 'application/geo+json;charset=utf-8')
    if (format === 'csv') downloadBlob(combinedCsv(polygons, points, csvFormat), `${name}.csv`, 'text/csv;charset=utf-8')
    if (format === 'gpx') downloadBlob(combinedGpx(polygons, points), `${name}.gpx`, 'application/gpx+xml;charset=utf-8')
    setMessage({ text: `Tüm proje verileri ${format.toUpperCase()} olarak tek dosyada hazırlandı.` })
  }

  if (!host || !panel) return null

  const status = message ? <p className={`form-note${message.error ? ' warning' : ''}`}>{message.text}</p> : null
  const commonStyle = <style>{`
    .unified-transfer{display:grid;gap:12px}
    .unified-transfer-summary{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:6px}
    .unified-transfer-summary span{display:grid;gap:2px;padding:8px;border:1px solid #e7edf3;border-radius:10px;background:#f8fafc;text-align:center}
    .unified-transfer-summary small{font-size:7px;color:#94a3b8}.unified-transfer-summary strong{font-size:11px;color:#334155}
    .unified-transfer-preview{display:grid;gap:8px;padding:10px;border:1px solid #bfdbfe;border-radius:12px;background:#eff6ff}
    .unified-transfer-preview-head{display:flex;align-items:center;justify-content:space-between;gap:8px}.unified-transfer-preview-head strong{font-size:10px}.unified-transfer-preview-head small{font-size:8px;color:#64748b}
    .unified-transfer-preview-list{display:grid;gap:5px}.unified-transfer-preview-list span{display:flex;align-items:center;justify-content:space-between;gap:8px;font-size:8px;color:#64748b}.unified-transfer-preview-list b{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:#334155}
    .unified-transfer-confirm{display:flex;gap:7px}.unified-transfer-confirm button{flex:1;height:34px;display:flex;align-items:center;justify-content:center;gap:5px;border:0;border-radius:9px;font-size:9px;font-weight:800;cursor:pointer}.unified-transfer-confirm button:first-child{background:#e8eef4;color:#64748b}.unified-transfer-confirm button:last-child{background:#2563eb;color:white}
    .unified-transfer-field{display:grid;gap:5px}.unified-transfer-field>span{font-size:8px;font-weight:800;color:#64748b}.unified-transfer-field input,.unified-transfer-field select{width:100%;height:40px;padding:0 10px;border:1px solid #dce4ed;border-radius:10px;background:#fff;color:#172033;font-size:10px;outline:none}
    .unified-export-grid{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:7px}.unified-export-grid button{height:58px;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:5px;border:1px solid #dfe7ef;border-radius:11px;background:#f8fafc;color:#475569;font-size:9px;font-weight:800;cursor:pointer}.unified-export-grid button:hover{border-color:#93c5fd;background:#eff6ff;color:#1d4ed8}
    .unified-transfer-note{margin:0;padding:8px 9px;border-radius:9px;background:#f8fafc;color:#64748b;font-size:8px;line-height:1.45}
    @media(max-width:700px){.unified-transfer-summary{grid-template-columns:repeat(2,minmax(0,1fr))}.unified-export-grid{grid-template-columns:repeat(2,minmax(0,1fr))}}
  `}</style>

  if (panel === 'import') return createPortal(
    <section className="unified-transfer" data-unified-transfer-root="true">
      {commonStyle}
      <label className={`dropzone tall${reading ? ' is-busy' : ''}`}>
        <Upload size={32} />
        <strong>{reading ? 'Proje dosyası analiz ediliyor…' : 'Dosyayı buraya sürükle veya tıkla'}</strong>
        <small>KML · KMZ · GeoJSON · JSON · CSV · GPX — içerik otomatik algılanır</small>
        <input type="file" accept=".kml,.kmz,.geojson,.json,.csv,.gpx,text/csv,application/gpx+xml" onChange={importFile} disabled={reading} />
      </label>
      {pending && <div className="unified-transfer-preview">
        <div className="unified-transfer-preview-head"><strong>Tek Dosya Önizlemesi</strong><small>{pending.name} · {(pending.size / 1024).toFixed(1)} KB</small></div>
        <div className="unified-transfer-summary"><span><small>Katman</small><strong>{pending.layers.length}</strong></span><span><small>Geometri Noktası</small><strong>{pending.layers.reduce((sum, layer) => sum + layer.points.length, 0)}</strong></span><span><small>Saha Noktası</small><strong>{pending.fieldPoints.length}</strong></span><span><small>Toplam</small><strong>{pending.layers.reduce((sum, layer) => sum + layer.points.length, 0) + pending.fieldPoints.length}</strong></span></div>
        <div className="unified-transfer-preview-list">
          {pending.layers.slice(0, 4).map((layer) => <span key={layer.id}><b>Katman · {layer.name}</b><small>{layer.points.length} nokta</small></span>)}
          {pending.fieldPoints.slice(0, 4).map((point) => <span key={point.id}><b>Saha · {point.name}</b><small>{point.lat.toFixed(5)}, {point.lng.toFixed(5)}</small></span>)}
        </div>
        <div className="unified-transfer-confirm"><button type="button" onClick={() => setPending(null)} disabled={reading}><X size={14} /> Vazgeç</button><button type="button" onClick={() => void confirmImport()} disabled={reading}><CheckCircle2 size={14} /> Projeye Ekle</button></div>
      </div>}
      <p className="unified-transfer-note">Poligon, hat ve Saha Noktaları aynı dosyada bulunabilir. Sistem verileri türüne göre ayırır ve mevcut projeyi silmeden ekler.</p>
      {status}
    </section>, host,
  )

  return createPortal(
    <section className="unified-transfer" data-unified-transfer-root="true">
      {commonStyle}
      <div className="unified-transfer-summary"><span><small>Katman</small><strong>{projectStats.layers}</strong></span><span><small>Koordinat</small><strong>{projectStats.polygonPoints}</strong></span><span><small>DES</small><strong>{projectStats.des}</strong></span><span><small>Saha Noktası</small><strong>{projectStats.field}</strong></span></div>
      <label className="unified-transfer-field"><span>Dosya adı</span><input value={filename} onChange={(event) => setFilename(event.target.value)} placeholder="evren-jeofizik-projesi" /></label>
      <label className="unified-transfer-field"><span>CSV Koordinat Formatı</span><select value={csvFormat} onChange={(event) => setCsvFormat(event.target.value as CoordinateFormat)}>{COORDINATE_OPTIONS.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}</select></label>
      <ExportPolygonStyleControls value={exportStyle} onChange={setExportStyle} />
      <div className="unified-export-grid">
        <button type="button" onClick={() => void exportProject('kml')}><FileDown size={19} />KML</button>
        <button type="button" onClick={() => void exportProject('kmz')}><FileDown size={19} />KMZ</button>
        <button type="button" onClick={() => void exportProject('geojson')}><FileDown size={19} />GeoJSON</button>
        <button type="button" onClick={() => void exportProject('csv')}><FileDown size={19} />CSV</button>
        <button type="button" onClick={() => void exportProject('gpx')}><FileDown size={19} />GPX</button>
      </div>
      <p className="unified-transfer-note">Her düğme tüm proje verisini tek dosyada dışa aktarır: poligon/hat, DES ve Saha Noktaları. Saha noktalarının ad, koordinat, sembol, not ve açıklamaları korunur. Fotoğraflar cihazdaki saha kaydında kalır.</p>
      {status}
    </section>, host,
  )
}
