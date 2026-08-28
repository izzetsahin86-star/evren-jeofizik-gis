import { Fragment, memo, useCallback, useEffect, useMemo, useRef, useState, type CSSProperties, type MutableRefObject } from 'react'
import L, { type LeafletMouseEvent, type Map as LeafletMap } from 'leaflet'
import { Circle, CircleMarker, MapContainer, Marker, Polygon, Polyline, Popup, TileLayer, Tooltip, useMapEvents } from 'react-leaflet'
import { Check, Copy, Crosshair, LocateFixed, MapPin, MousePointer2, Plus, Ruler, Share2, Trash2, Undo2 } from 'lucide-react'
import { analyzePolygon, formatAreaShort, formatNumber, MAP_CENTER, pointBearing, pointDistance, toUtm, utmLatitudeBand } from '../geo'
import { LIVE_TRACK_COMMAND_EVENT, sendLiveTrackStatus, type LiveTrackCommand } from '../liveTrackingBridge'
import type { BaseLayerId, DisplaySettings, GeoPoint, PolygonLayer } from '../types'

const tileLayers: Record<BaseLayerId, { url: string; attribution: string }> = {
  street: {
    url: 'https://{s}.basemaps.cartocdn.com/rastertiles/voyager/{z}/{x}/{y}{r}.png',
    attribution: '© OpenStreetMap © CARTO',
  },
  satellite: {
    url: 'https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}',
    attribution: 'Tiles © Esri',
  },
  topographic: {
    url: 'https://{s}.tile.opentopomap.org/{z}/{x}/{y}.png',
    attribution: '© OpenStreetMap · OpenTopoMap',
  },
}

const TRACK_STORAGE_KEY = 'evren-jeofizik-gis-live-track-v1'
const LIVE_META_KEY = 'evren-jeofizik-gis-live-meta-v2'
const MAX_TRACK_POINTS = 5000

type MapPosition = { lat: number; lng: number }
type GpsPosition = MapPosition & {
  accuracy: number
  altitude: number | null
  speed: number | null
  heading: number | null
  timestamp: number
}
type TrackPoint = GpsPosition & { id: string }

function readStoredTrack(): TrackPoint[] {
  if (typeof window === 'undefined') return []
  try {
    const stored = JSON.parse(localStorage.getItem(TRACK_STORAGE_KEY) || '[]') as Partial<TrackPoint>[]
    if (!Array.isArray(stored)) return []
    return stored
      .filter((point) => Number.isFinite(point.lat) && Number.isFinite(point.lng))
      .slice(-MAX_TRACK_POINTS)
      .map((point, index) => ({
        id: typeof point.id === 'string' ? point.id : `track-${Date.now()}-${index}`,
        lat: Number(point.lat),
        lng: Number(point.lng),
        accuracy: Number.isFinite(point.accuracy) ? Math.max(1, Number(point.accuracy)) : 1,
        altitude: typeof point.altitude === 'number' && Number.isFinite(point.altitude) ? point.altitude : null,
        speed: typeof point.speed === 'number' && Number.isFinite(point.speed) ? point.speed : null,
        heading: typeof point.heading === 'number' && Number.isFinite(point.heading) ? point.heading : null,
        timestamp: typeof point.timestamp === 'number' && Number.isFinite(point.timestamp) ? point.timestamp : Date.now(),
      }))
  } catch {
    return []
  }
}

function readStoredSegmentBreaks() {
  try {
    const value = JSON.parse(localStorage.getItem(LIVE_META_KEY) || '{}') as { segmentBreaks?: unknown }
    if (!Array.isArray(value.segmentBreaks)) return [0]
    const starts = value.segmentBreaks.filter((index): index is number => Number.isInteger(index) && Number(index) >= 0)
    return starts.length ? Array.from(new Set([0, ...starts])).sort((a, b) => a - b) : [0]
  } catch {
    return [0]
  }
}

function splitTrack(points: TrackPoint[], segmentBreaks: number[]) {
  const starts = Array.from(new Set([0, ...segmentBreaks]))
    .filter((index) => Number.isInteger(index) && index >= 0 && index < points.length)
    .sort((a, b) => a - b)
  return starts.map((start, index) => points.slice(start, starts[index + 1] ?? points.length)).filter((segment) => segment.length)
}

function isGpsJump(previous: TrackPoint | undefined, point: GpsPosition) {
  if (!previous) return false
  if (point.accuracy > 150 || (point.speed !== null && point.speed > 80)) return true
  const elapsedSeconds = Math.max(0.25, (point.timestamp - previous.timestamp) / 1000)
  const movedM = pointDistance(previous, { ...point, id: 'gps-candidate' }) ?? 0
  const accuracyAllowance = Math.min(120, previous.accuracy + point.accuracy)
  return movedM > Math.max(120, elapsedSeconds * 75 + accuracyAllowance)
}

function gpsFromPosition(position: GeolocationPosition): GpsPosition {
  return {
    lat: position.coords.latitude,
    lng: position.coords.longitude,
    accuracy: Math.max(1, position.coords.accuracy),
    altitude: position.coords.altitude,
    speed: position.coords.speed,
    heading: position.coords.heading,
    timestamp: position.timestamp || Date.now(),
  }
}

function formatTrackDistance(distanceM: number) {
  if (distanceM >= 1000) return `${formatNumber(distanceM / 1000, 2)} km`
  return `${formatNumber(distanceM, 0)} m`
}

function numberIcon(number: number, color: string, active: boolean) {
  return L.divIcon({
    className: 'map-number-marker-wrap',
    html: `<span class="map-pin-marker${active ? ' is-active' : ''}" style="--marker:${color}"><span>${number}</span></span>`,
    iconSize: [34, 40],
    iconAnchor: [17, 38],
    popupAnchor: [0, -34],
    tooltipAnchor: [0, -28],
  })
}

function escapeKml(value: string) {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;')
}

function kmlColor(hex: string, opacity = 1) {
  const normalized = hex.replace('#', '').padEnd(6, '0').slice(0, 6)
  const red = normalized.slice(0, 2)
  const green = normalized.slice(2, 4)
  const blue = normalized.slice(4, 6)
  const alpha = Math.round(Math.max(0, Math.min(1, opacity)) * 255).toString(16).padStart(2, '0')
  return `${alpha}${blue}${green}${red}`
}

function safeKmlName(value: string) {
  return value
    .trim()
    .replace(/[<>:"/\\|?*]/g, '-')
    .replace(/[. ]+$/g, '')
    .slice(0, 120) || 'Evren Jeofizik GIS'
}

function formatHectares(areaM2: number) {
  return `${formatNumber(areaM2 / 10_000, 2)} ha`
}

function polygonPointName(index: number) {
  return `Nokta ${index + 1}`
}

function downloadKml(file: File) {
  const url = URL.createObjectURL(file)
  const anchor = document.createElement('a')
  anchor.href = url
  anchor.download = file.name
  document.body.appendChild(anchor)
  anchor.click()
  anchor.remove()
  window.setTimeout(() => URL.revokeObjectURL(url), 1000)
}

async function shareKmlFile(
  title: string,
  filename: string,
  kml: string,
  onMessage: (message: string, tone?: 'success' | 'error' | 'info') => void,
) {
  const file = new File([kml], `${safeKmlName(filename)}.kml`, { type: 'application/vnd.google-earth.kml+xml' })
  try {
    if (navigator.share && navigator.canShare?.({ files: [file] })) {
      await navigator.share({ title, text: `${title} · Evren Jeofizik GIS`, files: [file] })
      onMessage('KML paylaşımı tamamlandı.', 'success')
      return
    }
    downloadKml(file)
    onMessage('KML dosyası indirildi.', 'success')
  } catch (error) {
    if (error instanceof DOMException && error.name === 'AbortError') return
    try {
      downloadKml(file)
      onMessage('KML dosyası indirildi.', 'success')
    } catch {
      onMessage('KML paylaşımı başlatılamadı.', 'error')
    }
  }
}

function pointPlacemark(name: string, point: GeoPoint) {
  const zone = Math.max(1, Math.min(60, Math.floor((point.lng + 180) / 6) + 1))
  const hemisphere: 'N' | 'S' = point.lat >= 0 ? 'N' : 'S'
  const utm = toUtm(point.lat, point.lng, zone, hemisphere)
  return `<Placemark>
      <name>${escapeKml(name)}</name>
      <description>${escapeKml(`Enlem/Boylam: ${point.lat.toFixed(7)}, ${point.lng.toFixed(7)} | UTM: ${zone}${hemisphere} ${Math.round(utm.easting)} ${Math.round(utm.northing)}`)}</description>
      <styleUrl>#yellow-pin</styleUrl>
      <ExtendedData>
        <Data name="latitude"><value>${point.lat.toFixed(7)}</value></Data>
        <Data name="longitude"><value>${point.lng.toFixed(7)}</value></Data>
        <Data name="utm"><value>${zone}${hemisphere} ${Math.round(utm.easting)} ${Math.round(utm.northing)}</value></Data>
      </ExtendedData>
      <Point><coordinates>${point.lng.toFixed(8)},${point.lat.toFixed(8)},0</coordinates></Point>
    </Placemark>`
}

function pointKml(point: GeoPoint, index: number) {
  const name = polygonPointName(index)
  return namedPointKml(name, point)
}

function namedPointKml(name: string, point: GeoPoint) {
  return `<?xml version="1.0" encoding="UTF-8"?>
<kml xmlns="http://www.opengis.net/kml/2.2">
  <Document>
    <name>${escapeKml(name)}</name>
    <Style id="yellow-pin">
      <IconStyle><scale>1.1</scale><Icon><href>https://maps.google.com/mapfiles/kml/pushpin/ylw-pushpin.png</href></Icon></IconStyle>
      <LabelStyle><scale>0.9</scale></LabelStyle>
    </Style>
    ${pointPlacemark(name, point)}
  </Document>
</kml>`
}

function polygonKml(layer: PolygonLayer) {
  const analysis = analyzePolygon(layer.points)
  const geometry = layer.points.length >= 3
    ? `<Polygon><tessellate>1</tessellate><outerBoundaryIs><LinearRing><coordinates>${[...layer.points, layer.points[0]].map((point) => `${point.lng.toFixed(8)},${point.lat.toFixed(8)},0`).join(' ')}</coordinates></LinearRing></outerBoundaryIs></Polygon>`
    : `<LineString><tessellate>1</tessellate><coordinates>${layer.points.map((point) => `${point.lng.toFixed(8)},${point.lat.toFixed(8)},0`).join(' ')}</coordinates></LineString>`
  return `<?xml version="1.0" encoding="UTF-8"?>
<kml xmlns="http://www.opengis.net/kml/2.2">
  <Document>
    <name>${escapeKml(layer.name)}</name>
    <Style id="polygon-style">
      <LineStyle><color>${kmlColor(layer.color, layer.strokeOpacity ?? 1)}</color><width>${layer.strokeWidth ?? 3}</width></LineStyle>
      <PolyStyle><color>${kmlColor(layer.color, layer.fillOpacity ?? 0.14)}</color><fill>1</fill><outline>1</outline></PolyStyle>
    </Style>
    <Style id="yellow-pin">
      <IconStyle><scale>1.1</scale><Icon><href>https://maps.google.com/mapfiles/kml/pushpin/ylw-pushpin.png</href></Icon></IconStyle>
      <LabelStyle><scale>0.9</scale></LabelStyle>
    </Style>
    <Placemark>
      <name>${escapeKml(layer.name)}</name>
      <description>${escapeKml(`${layer.points.length} nokta${analysis.areaM2 > 0 ? ` | Alan: ${formatHectares(analysis.areaM2)}` : ''} | Evren Jeofizik GIS`)}</description>
      <styleUrl>#polygon-style</styleUrl>
      ${geometry}
    </Placemark>
    <Folder>
      <name>Poligon Noktaları</name>
      ${layer.points.map((point, index) => pointPlacemark(polygonPointName(index), point)).join('\n      ')}
    </Folder>
  </Document>
</kml>`
}

interface KmlShareCardProps {
  kind: string
  title: string
  titleLabel?: string
  detail: string
  buttonLabel: string
  kml: string
  createKml?: (title: string) => string
  onTitleCommit?: (title: string) => void
  onDelete?: () => void
  onMessage: (message: string, tone?: 'success' | 'error' | 'info') => void
}

function KmlShareCard({ kind, title, titleLabel, detail, buttonLabel, kml, createKml, onTitleCommit, onDelete, onMessage }: KmlShareCardProps) {
  const [filename, setFilename] = useState('Evren Jeofizik GIS')
  const [titleDraft, setTitleDraft] = useState(title)
  const normalizedFilename = filename.trim()
  const normalizedTitle = titleDraft.trim() || title.trim()

  const commitTitle = () => {
    if (onTitleCommit && normalizedTitle !== title) onTitleCommit(normalizedTitle)
  }

  const shareFile = () => {
    commitTitle()
    void shareKmlFile(normalizedFilename, normalizedFilename, createKml?.(normalizedTitle) ?? kml, onMessage)
  }

  return (
    <div className="map-share-card">
      <span className="map-share-kind">{kind}</span>
      {onTitleCommit ? (
        <label className="map-share-name">
          <span>{titleLabel || 'Ad'}</span>
          <input
            type="text"
            value={titleDraft}
            onChange={(event) => setTitleDraft(event.target.value)}
            onBlur={commitTitle}
            maxLength={80}
            autoComplete="off"
            aria-label={titleLabel || 'Ad'}
          />
        </label>
      ) : <strong>{title}</strong>}
      <small>{detail}</small>
      <label className="map-share-filename">
        <span>Dosya adı</span>
        <input
          type="text"
          value={filename}
          onChange={(event) => setFilename(event.target.value)}
          onFocus={(event) => event.currentTarget.select()}
          maxLength={80}
          autoComplete="off"
          aria-label="KML dosya adı"
        />
      </label>
      <div className={`map-share-actions${onDelete ? ' has-delete' : ''}`}>
        <button
          type="button"
          disabled={!normalizedFilename}
          onClick={shareFile}
        >
          <Share2 size={16} /> {buttonLabel}
        </button>
        {onDelete ? <button type="button" className="map-share-delete" onClick={onDelete}><Trash2 size={15} /> Noktayı Sil</button> : null}
      </div>
    </div>
  )
}

interface MapDeleteConfirmCardProps {
  kind: 'Nokta' | 'Poligon'
  name: string
  detail: string
  onCancel: () => void
  onConfirm: () => void
}

function MapDeleteConfirmCard({ kind, name, detail, onCancel, onConfirm }: MapDeleteConfirmCardProps) {
  return (
    <div className="map-delete-card" role="alertdialog" aria-label={`${name} silme onayı`}>
      <span className="map-delete-icon"><Trash2 size={19} /></span>
      <strong>{name} silinsin mi?</strong>
      <small>{kind} haritadan kaldırılacak. Silmek için onay verin.</small>
      <em>{detail}</em>
      <div className="map-delete-actions">
        <button type="button" onClick={onCancel}>Vazgeç</button>
        <button type="button" className="confirm-delete" onClick={onConfirm}><Trash2 size={14} /> Sil</button>
      </div>
    </div>
  )
}

function desIcon() {
  return L.divIcon({
    className: 'des-marker-wrap',
    html: '<span class="des-marker"></span>',
    iconSize: [12, 12],
    iconAnchor: [6, 6],
  })
}

function targetPosition(map: LeafletMap, coarsePointer = window.matchMedia('(pointer: coarse)').matches) {
  const size = map.getSize()
  return map.containerPointToLatLng(L.point(size.x / 2, size.y * (coarsePointer ? 0.43 : 0.5)))
}

interface EventBridgeProps {
  addMode: boolean
  standaloneAddMode: boolean
  measureMode: boolean
  onAddPoint: (point: Omit<GeoPoint, 'id'>) => void
  onAddStandalonePoint: (point: Omit<GeoPoint, 'id'>) => void
  onMeasurePoint: (point: GeoPoint) => void
  positionListener: MutableRefObject<(point: MapPosition) => void>
}

function EventBridge({ addMode, standaloneAddMode, measureMode, onAddPoint, onAddStandalonePoint, onMeasurePoint, positionListener }: EventBridgeProps) {
  const pendingPosition = useRef<MapPosition | null>(null)
  const positionFrame = useRef<number | null>(null)
  const coarsePointer = useRef(window.matchMedia('(pointer: coarse)').matches)

  const flushPosition = useCallback(() => {
    if (positionFrame.current !== null) window.cancelAnimationFrame(positionFrame.current)
    positionFrame.current = null
    if (!pendingPosition.current) return
    positionListener.current(pendingPosition.current)
    pendingPosition.current = null
  }, [positionListener])

  const queuePosition = useCallback((point: MapPosition) => {
    pendingPosition.current = point
    if (positionFrame.current === null) positionFrame.current = window.requestAnimationFrame(flushPosition)
  }, [flushPosition])

  const map = useMapEvents({
    click(event: LeafletMouseEvent) {
      if (measureMode) onMeasurePoint({ id: `measure-${Date.now()}`, lat: event.latlng.lat, lng: event.latlng.lng })
      else if (standaloneAddMode) onAddStandalonePoint({ lat: event.latlng.lat, lng: event.latlng.lng })
      else if (addMode) onAddPoint({ lat: event.latlng.lat, lng: event.latlng.lng })
    },
    mousemove(event: LeafletMouseEvent) {
      if (!coarsePointer.current) queuePosition({ lat: event.latlng.lat, lng: event.latlng.lng })
    },
    move(event) {
      if (!coarsePointer.current) return
      const point = targetPosition(event.target, true)
      queuePosition({ lat: point.lat, lng: point.lng })
    },
    moveend(event) {
      if (!coarsePointer.current) return
      const point = targetPosition(event.target, true)
      pendingPosition.current = { lat: point.lat, lng: point.lng }
      flushPosition()
    },
  })

  useEffect(() => {
    if (!coarsePointer.current) return
    const frame = window.requestAnimationFrame(() => {
      const point = targetPosition(map, true)
      positionListener.current({ lat: point.lat, lng: point.lng })
    })
    return () => window.cancelAnimationFrame(frame)
  }, [map, positionListener])

  useEffect(() => () => {
    if (positionFrame.current !== null) window.cancelAnimationFrame(positionFrame.current)
  }, [])

  return null
}

interface CoordinateCardProps {
  positionListener: MutableRefObject<(point: MapPosition) => void>
  areaM2: number
  showCoordinate: boolean
  showArea: boolean
}

function CoordinateCard({ positionListener, areaM2, showCoordinate, showArea }: CoordinateCardProps) {
  const [position, setPosition] = useState<MapPosition>({ lat: MAP_CENTER[0], lng: MAP_CENTER[1] })
  const [copied, setCopied] = useState(false)
  const formatted = useMemo(() => {
    const latitudeHemisphere = position.lat >= 0 ? 'N' : 'S'
    const longitudeHemisphere = position.lng >= 0 ? 'E' : 'W'
    const geographic = `${Math.abs(position.lat).toFixed(6)}° ${latitudeHemisphere} ${Math.abs(position.lng).toFixed(6)}° ${longitudeHemisphere}`
    const utm = toUtm(position.lat, position.lng)
    const utmText = `${utm.zone}${utmLatitudeBand(position.lat)} ${Math.round(utm.easting)} ${Math.round(utm.northing)}`
    return { geographic, utm: utmText, copyValue: `${geographic}\n${utmText}` }
  }, [position])

  useEffect(() => {
    positionListener.current = setPosition
    return () => { positionListener.current = () => undefined }
  }, [positionListener])

  const copyCoordinate = async () => {
    try {
      await navigator.clipboard.writeText(formatted.copyValue)
    } catch {
      const input = document.createElement('textarea')
      input.value = formatted.copyValue
      input.style.position = 'fixed'
      input.style.opacity = '0'
      document.body.appendChild(input)
      input.select()
      document.execCommand('copy')
      input.remove()
    }
    setCopied(true)
    window.setTimeout(() => setCopied(false), 1400)
  }

  return (
    <div className="coordinate-stack">
      {showCoordinate && (
        <button type="button" className="coordinate-card" onClick={copyCoordinate} title="Tüm koordinatları kopyala" aria-label={`${formatted.geographic}, UTM ${formatted.utm}. Tüm koordinatları kopyala`}>
          <span className="coordinate-lines">
            <span className="coordinate-geographic">{formatted.geographic}</span>
            <span className="coordinate-utm">{formatted.utm}</span>
          </span>
          <span className="coordinate-copy-state" aria-hidden="true">{copied ? <Check size={14} /> : <Copy size={14} />}</span>
        </button>
      )}
      {showArea && areaM2 > 0 && <span className="coordinate-area">{formatNumber(areaM2 / 10_000, 3)} ha alan</span>}
    </div>
  )
}

function sampledIndexes(length: number, maximum: number) {
  if (length <= maximum) return Array.from({ length }, (_, index) => index)
  const step = Math.ceil(length / maximum)
  const indexes = Array.from({ length: Math.ceil(length / step) }, (_, index) => index * step)
  if (indexes[indexes.length - 1] !== length - 1) indexes.push(length - 1)
  return indexes
}

const PolygonLayerView = memo(function PolygonLayerView({
  layer,
  isActive,
  performanceMode,
  onUpdatePoint,
  onDeletePoint,
  onDeletePolygon,
  onMessage,
}: {
  layer: PolygonLayer
  isActive: boolean
  performanceMode: boolean
  onUpdatePoint: (pointId: string, point: Omit<GeoPoint, 'id'>) => void
  onDeletePoint: (polygonId: string, pointId: string) => void
  onDeletePolygon: (polygonId: string) => void
  onMessage: (message: string, tone?: 'success' | 'error' | 'info') => void
}) {
  const [shareTarget, setShareTarget] = useState<
    | { kind: 'polygon' | 'line'; position: [number, number] }
    | { kind: 'point'; position: [number, number]; index: number }
    | null
  >(null)
  const [deleteTarget, setDeleteTarget] = useState<
    | { kind: 'polygon'; position: [number, number] }
    | { kind: 'point'; position: [number, number]; pointId: string }
    | null
  >(null)
  const lastShareTap = useRef<{ key: string; timestamp: number } | null>(null)
  const openShareOnSecondTap = useCallback((key: string, target: NonNullable<typeof shareTarget>, event: LeafletMouseEvent) => {
    event.originalEvent.preventDefault()
    event.originalEvent.stopPropagation()
    const timestamp = Date.now()
    const previous = lastShareTap.current
    if (previous?.key === key && timestamp - previous.timestamp <= 450) {
      lastShareTap.current = null
      setDeleteTarget(null)
      setShareTarget(target)
      return
    }
    lastShareTap.current = { key, timestamp }
  }, [])
  const openDeleteOnLongPress = useCallback((target: NonNullable<typeof deleteTarget>, event: LeafletMouseEvent) => {
    event.originalEvent.preventDefault()
    event.originalEvent.stopPropagation()
    lastShareTap.current = null
    setShareTarget(null)
    setDeleteTarget(target)
  }, [])
  const strokeWidth = layer.strokeWidth ?? 3
  const strokeOpacity = layer.strokeOpacity ?? 1
  const fillOpacity = layer.fillOpacity ?? 0.14
  const polygonAreaM2 = useMemo(() => layer.points.length >= 3 ? analyzePolygon(layer.points).areaM2 : 0, [layer.points])
  const markerIndexes = performanceMode ? (isActive ? sampledIndexes(layer.points.length, 180) : []) : sampledIndexes(layer.points.length, layer.points.length)
  const desIndexes = performanceMode ? sampledIndexes(layer.desPoints.length, 1200) : sampledIndexes(layer.desPoints.length, layer.desPoints.length)
  const deletePoint = deleteTarget?.kind === 'point' ? layer.points.find((point) => point.id === deleteTarget.pointId) : undefined
  const deletePointIndex = deletePoint ? layer.points.indexOf(deletePoint) : -1

  return (
    <Fragment>
      {layer.points.length >= 3 ? (
        <Polygon
          positions={layer.points.map((point) => [point.lat, point.lng])}
          bubblingMouseEvents={false}
          pathOptions={{
            color: layer.color,
            fillColor: layer.color,
            fillOpacity: isActive ? fillOpacity : fillOpacity * 0.55,
            weight: isActive ? strokeWidth : Math.max(1, strokeWidth - 1),
            opacity: isActive ? strokeOpacity : strokeOpacity * 0.55,
          }}
          eventHandlers={{
            click(event) {
              openShareOnSecondTap('polygon', { kind: 'polygon', position: [event.latlng.lat, event.latlng.lng] }, event)
            },
            contextmenu(event) {
              openDeleteOnLongPress({ kind: 'polygon', position: [event.latlng.lat, event.latlng.lng] }, event)
            },
          }}
        />
      ) : layer.points.length >= 2 ? (
        <Polyline
          positions={layer.points.map((point) => [point.lat, point.lng])}
          bubblingMouseEvents={false}
          pathOptions={{ color: layer.color, weight: strokeWidth, opacity: strokeOpacity }}
          eventHandlers={{
            click(event) {
              openShareOnSecondTap('line', { kind: 'line', position: [event.latlng.lat, event.latlng.lng] }, event)
            },
            contextmenu(event) {
              openDeleteOnLongPress({ kind: 'polygon', position: [event.latlng.lat, event.latlng.lng] }, event)
            },
          }}
        />
      ) : null}

      {markerIndexes.map((index) => {
        const point = layer.points[index]
        return (
          <Marker
            key={point.id}
            position={[point.lat, point.lng]}
            icon={numberIcon(index + 1, layer.color, isActive)}
            title={polygonPointName(index)}
            draggable={isActive && !performanceMode}
            bubblingMouseEvents={false}
            eventHandlers={{
              dragend(event) {
                const location = event.target.getLatLng()
                onUpdatePoint(point.id, { lat: location.lat, lng: location.lng })
              },
              click(event) {
                openShareOnSecondTap(`point-${point.id}`, { kind: 'point', position: [point.lat, point.lng], index }, event)
              },
              contextmenu(event) {
                openDeleteOnLongPress({ kind: 'point', position: [point.lat, point.lng], pointId: point.id }, event)
              },
            }}
          >
            <Tooltip direction="top">{polygonPointName(index)}<br />{point.lat.toFixed(6)}, {point.lng.toFixed(6)}</Tooltip>
          </Marker>
        )
      })}

      {shareTarget && (
        <Popup
          position={shareTarget.position}
          className="map-share-popup"
          eventHandlers={{ remove: () => setShareTarget(null) }}
        >
          {shareTarget.kind === 'point' ? (
            layer.points[shareTarget.index] ? (
              <KmlShareCard
                kind="Koordinat noktası"
                title={polygonPointName(shareTarget.index)}
                detail={`${layer.points[shareTarget.index].lat.toFixed(7)}, ${layer.points[shareTarget.index].lng.toFixed(7)}`}
                buttonLabel="Noktayı KML Olarak Paylaş"
                kml={pointKml(layer.points[shareTarget.index], shareTarget.index)}
                onMessage={onMessage}
              />
            ) : null
          ) : (
            <KmlShareCard
              kind={shareTarget.kind === 'polygon' ? 'Poligon' : 'Hat'}
              title={layer.name}
              detail={`${layer.points.length} nokta${shareTarget.kind === 'polygon' ? ` · ${formatHectares(polygonAreaM2)}` : ''}`}
              buttonLabel={shareTarget.kind === 'polygon' ? 'Poligonu KML Olarak Paylaş' : 'Hattı KML Olarak Paylaş'}
              kml={polygonKml(layer)}
              onMessage={onMessage}
            />
          )}
        </Popup>
      )}

      {deleteTarget && (
        <Popup
          position={deleteTarget.position}
          className="map-delete-popup"
          closeButton={false}
          eventHandlers={{ remove: () => setDeleteTarget(null) }}
        >
          {deleteTarget.kind === 'point' ? (
            deletePoint && deletePointIndex >= 0 ? (
              <MapDeleteConfirmCard
                kind="Nokta"
                name={polygonPointName(deletePointIndex)}
                detail={`${deletePoint.lat.toFixed(7)}, ${deletePoint.lng.toFixed(7)}`}
                onCancel={() => setDeleteTarget(null)}
                onConfirm={() => {
                  setDeleteTarget(null)
                  onDeletePoint(layer.id, deletePoint.id)
                  onMessage(`${polygonPointName(deletePointIndex)} silindi.`, 'success')
                }}
              />
            ) : null
          ) : (
            <MapDeleteConfirmCard
              kind="Poligon"
              name={layer.name}
              detail={`${layer.points.length} nokta${polygonAreaM2 ? ` · ${formatHectares(polygonAreaM2)}` : ''}`}
              onCancel={() => setDeleteTarget(null)}
              onConfirm={() => {
                setDeleteTarget(null)
                onDeletePolygon(layer.id)
                onMessage(`${layer.name} silindi.`, 'success')
              }}
            />
          )}
        </Popup>
      )}

      {desIndexes.map((index) => {
        const point = layer.desPoints[index]
        return performanceMode ? (
          <CircleMarker key={point.id} center={[point.lat, point.lng]} radius={3} pathOptions={{ color: '#ffffff', weight: 1, fillColor: '#10b981', fillOpacity: 1 }} />
        ) : (
          <Marker key={point.id} position={[point.lat, point.lng]} icon={desIcon()} interactive={false} keyboard={false}>
            <Tooltip direction="top" offset={[0, -8]}>{point.name}</Tooltip>
          </Marker>
        )
      })}
    </Fragment>
  )
})

const StandalonePointLayer = memo(function StandalonePointLayer({
  points,
  onRenamePoint,
  onDeletePoint,
  onMessage,
}: {
  points: GeoPoint[]
  onRenamePoint: (pointId: string, name: string) => void
  onDeletePoint: (pointId: string) => void
  onMessage: (message: string, tone?: 'success' | 'error' | 'info') => void
}) {
  const [sharePointId, setSharePointId] = useState<string | null>(null)
  const [deletePointId, setDeletePointId] = useState<string | null>(null)
  const lastTap = useRef<{ pointId: string; timestamp: number } | null>(null)
  const selectedPoint = points.find((point) => point.id === sharePointId)
  const selectedIndex = selectedPoint ? points.indexOf(selectedPoint) : -1
  const deletePoint = points.find((point) => point.id === deletePointId)
  const deleteIndex = deletePoint ? points.indexOf(deletePoint) : -1

  return (
    <Fragment>
      {points.map((point, index) => {
        const name = point.name?.trim() || `Nokta ${index + 1}`
        return (
          <Marker
            key={point.id}
            position={[point.lat, point.lng]}
            icon={numberIcon(index + 1, '#eab308', false)}
            title={name}
            bubblingMouseEvents={false}
            eventHandlers={{
              click(event) {
                event.originalEvent.preventDefault()
                event.originalEvent.stopPropagation()
                const timestamp = Date.now()
                if (lastTap.current?.pointId === point.id && timestamp - lastTap.current.timestamp <= 450) {
                  lastTap.current = null
                  setDeletePointId(null)
                  setSharePointId(point.id)
                  return
                }
                lastTap.current = { pointId: point.id, timestamp }
              },
              contextmenu(event) {
                event.originalEvent.preventDefault()
                event.originalEvent.stopPropagation()
                lastTap.current = null
                setSharePointId(null)
                setDeletePointId(point.id)
              },
            }}
          >
            <Tooltip direction="top">{name}<br />{point.lat.toFixed(6)}, {point.lng.toFixed(6)}</Tooltip>
          </Marker>
        )
      })}

      {selectedPoint && selectedIndex >= 0 ? (
        <Popup
          position={[selectedPoint.lat, selectedPoint.lng]}
          className="map-share-popup"
          eventHandlers={{ remove: () => setSharePointId(null) }}
        >
          <KmlShareCard
            kind="Nokta"
            title={selectedPoint.name ?? `Nokta ${selectedIndex + 1}`}
            titleLabel="Nokta adı"
            detail={`${selectedPoint.lat.toFixed(7)}, ${selectedPoint.lng.toFixed(7)}`}
            buttonLabel="Noktayı KML Olarak Paylaş"
            kml={namedPointKml(selectedPoint.name?.trim() || `Nokta ${selectedIndex + 1}`, selectedPoint)}
            createKml={(name) => namedPointKml(name, selectedPoint)}
            onTitleCommit={(name) => onRenamePoint(selectedPoint.id, name)}
            onDelete={() => {
              setSharePointId(null)
              setDeletePointId(selectedPoint.id)
            }}
            onMessage={onMessage}
          />
        </Popup>
      ) : null}

      {deletePoint && deleteIndex >= 0 ? (
        <Popup
          position={[deletePoint.lat, deletePoint.lng]}
          className="map-delete-popup"
          closeButton={false}
          eventHandlers={{ remove: () => setDeletePointId(null) }}
        >
          <MapDeleteConfirmCard
            kind="Nokta"
            name={deletePoint.name?.trim() || `Nokta ${deleteIndex + 1}`}
            detail={`${deletePoint.lat.toFixed(7)}, ${deletePoint.lng.toFixed(7)}`}
            onCancel={() => setDeletePointId(null)}
            onConfirm={() => {
              const name = deletePoint.name?.trim() || `Nokta ${deleteIndex + 1}`
              setDeletePointId(null)
              onDeletePoint(deletePoint.id)
              onMessage(`${name} silindi.`, 'success')
            }}
          />
        </Popup>
      ) : null}
    </Fragment>
  )
})

interface MapWorkspaceProps {
  polygons: PolygonLayer[]
  standalonePoints: GeoPoint[]
  activeId: string
  baseLayer: BaseLayerId
  mtaIndex25Visible: boolean
  mtaIndex100Visible: boolean
  addMode: boolean
  standaloneAddMode: boolean
  panelOpen: boolean
  performanceMode: boolean
  displaySettings: DisplaySettings
  clearRequest: number
  fitRequest: number
  flyTarget: { lat: number; lng: number; zoom?: number } | null
  onToggleAddMode: () => void
  onToggleStandaloneAddMode: () => void
  onAddPoint: (point: Omit<GeoPoint, 'id'>) => void
  onAddStandalonePoint: (point: Omit<GeoPoint, 'id'>) => void
  onRenameStandalonePoint: (pointId: string, name: string) => void
  onDeleteStandalonePoint: (pointId: string) => void
  onDeletePolygonPoint: (polygonId: string, pointId: string) => void
  onDeletePolygon: (polygonId: string) => void
  onUpdatePoint: (pointId: string, point: Omit<GeoPoint, 'id'>) => void
  onLocate: (point: Omit<GeoPoint, 'id'>) => void
  onMessage: (message: string, tone?: 'success' | 'error' | 'info') => void
}

export default function MapWorkspace({
  polygons,
  standalonePoints,
  activeId,
  baseLayer,
  mtaIndex25Visible,
  mtaIndex100Visible,
  addMode,
  standaloneAddMode,
  panelOpen,
  performanceMode,
  displaySettings,
  clearRequest,
  fitRequest,
  flyTarget,
  onToggleAddMode,
  onToggleStandaloneAddMode,
  onAddPoint,
  onAddStandalonePoint,
  onRenameStandalonePoint,
  onDeleteStandalonePoint,
  onDeletePolygonPoint,
  onDeletePolygon,
  onUpdatePoint,
  onLocate,
  onMessage,
}: MapWorkspaceProps) {
  const mapRef = useRef<LeafletMap | null>(null)
  const lastFitRequest = useRef(0)
  const positionListener = useRef<(point: MapPosition) => void>(() => undefined)
  const watchIdRef = useRef<number | null>(null)
  const trackingRef = useRef(false)
  const firstTrackingFixRef = useRef(true)
  const [measureMode, setMeasureMode] = useState(false)
  const [measurePoints, setMeasurePoints] = useState<GeoPoint[]>([])
  const [gpsPosition, setGpsPosition] = useState<GpsPosition | null>(null)
  const [tracking, setTracking] = useState(false)
  const [trackPoints, setTrackPoints] = useState<TrackPoint[]>(readStoredTrack)
  const trackPointsRef = useRef(trackPoints)
  const [trackSegmentBreaks, setTrackSegmentBreaks] = useState<number[]>(readStoredSegmentBreaks)
  const [rejectedTrackPoints, setRejectedTrackPoints] = useState(0)
  const active = polygons.find((layer) => layer.id === activeId) ?? polygons[0]
  const analysis = useMemo(() => analyzePolygon(active?.points ?? []), [active])
  const measurement = useMemo(() => {
    const distanceM = measurePoints.slice(1).reduce((sum, point, index) => sum + (pointDistance(measurePoints[index], point) ?? 0), 0)
    const bearing = measurePoints.length >= 2 ? pointBearing(measurePoints[measurePoints.length - 2], measurePoints[measurePoints.length - 1]) : null
    const areaM2 = measurePoints.length >= 3 ? analyzePolygon(measurePoints).areaM2 : 0
    return { distanceM, bearing, areaM2 }
  }, [measurePoints])
  const trackSegments = useMemo(() => splitTrack(trackPoints, trackSegmentBreaks), [trackPoints, trackSegmentBreaks])
  const trackDistanceM = useMemo(() => trackSegments.reduce((total, segment) => (
    total + segment.slice(1).reduce((sum, point, index) => sum + (pointDistance(segment[index], point) ?? 0), 0)
  ), 0), [trackSegments])

  useEffect(() => {
    const timer = window.setTimeout(() => mapRef.current?.invalidateSize(), 240)
    return () => window.clearTimeout(timer)
  }, [panelOpen])

  useEffect(() => {
    if (!flyTarget || !mapRef.current) return
    mapRef.current.flyTo([flyTarget.lat, flyTarget.lng], flyTarget.zoom ?? 16, { duration: 0.8 })
  }, [flyTarget])

  useEffect(() => {
    trackPointsRef.current = trackPoints
    try {
      localStorage.setItem(TRACK_STORAGE_KEY, JSON.stringify(trackPoints.slice(-MAX_TRACK_POINTS)))
    } catch {
      // Depolama dolu veya kapalıysa canlı takip çalışmaya devam eder.
    }
  }, [trackPoints])

  useEffect(() => () => {
    if (watchIdRef.current !== null && navigator.geolocation) navigator.geolocation.clearWatch(watchIdRef.current)
    watchIdRef.current = null
    trackingRef.current = false
  }, [])

  useEffect(() => {
    if (!clearRequest) return
    if (watchIdRef.current !== null && navigator.geolocation) navigator.geolocation.clearWatch(watchIdRef.current)
    watchIdRef.current = null
    trackingRef.current = false
    firstTrackingFixRef.current = true
    setTracking(false)
    setMeasureMode(false)
    setMeasurePoints([])
    setGpsPosition(null)
    setTrackPoints([])
    trackPointsRef.current = []
    setTrackSegmentBreaks([0])
    setRejectedTrackPoints(0)
    localStorage.removeItem(TRACK_STORAGE_KEY)
  }, [clearRequest])

  useEffect(() => {
    if (!fitRequest || fitRequest === lastFitRequest.current || !mapRef.current || !active?.points.length) return
    lastFitRequest.current = fitRequest
    if (active.points.length === 1) {
      mapRef.current.flyTo([active.points[0].lat, active.points[0].lng], 16, { duration: 0.8 })
      return
    }
    mapRef.current.fitBounds(active.points.map((point) => [point.lat, point.lng]), { padding: [70, 70], maxZoom: 17 })
  }, [fitRequest, active])

  const addTargetPoint = () => {
    if (!mapRef.current) return
    const point = targetPosition(mapRef.current)
    if (standaloneAddMode) {
      onAddStandalonePoint({ lat: point.lat, lng: point.lng })
      onMessage('Hedef merkezine nokta eklendi.', 'success')
      return
    }
    onAddPoint({ lat: point.lat, lng: point.lng })
    onMessage('Hedef merkezindeki nokta aktif poligona eklendi.', 'success')
  }

  const toggleMeasurement = () => {
    if (!measureMode && addMode) onToggleAddMode()
    if (!measureMode && standaloneAddMode) onToggleStandaloneAddMode()
    setMeasureMode((value) => !value)
  }

  const recordTrackPoint = (point: GpsPosition) => {
    const previous = trackPointsRef.current.at(-1)
    if (isGpsJump(previous, point)) {
      setRejectedTrackPoints((count) => count + 1)
      return
    }
    const next: TrackPoint = { ...point, id: `track-${point.timestamp}-${Math.random().toString(36).slice(2, 7)}` }
    const current = trackPointsRef.current
    if (previous) {
      const movedM = pointDistance(previous, next) ?? 0
      const elapsedMs = Math.max(0, next.timestamp - previous.timestamp)
      if (movedM < 1 && elapsedMs < 10000) return
    }
    const updated = [...current, next].slice(-MAX_TRACK_POINTS)
    trackPointsRef.current = updated
    setTrackPoints(updated)
  }

  const stopTracking = (announce = true) => {
    const wasTracking = trackingRef.current
    if (watchIdRef.current !== null && navigator.geolocation) navigator.geolocation.clearWatch(watchIdRef.current)
    watchIdRef.current = null
    trackingRef.current = false
    firstTrackingFixRef.current = true
    setTracking(false)
    if (announce && wasTracking) onMessage(`Canlı takip durduruldu · ${trackPoints.length} kayıt · ${formatTrackDistance(trackDistanceM)}`, 'info')
  }

  const startTracking = () => {
    if (!navigator.geolocation) {
      onMessage('Bu cihaz konum hizmetini desteklemiyor.', 'error')
      return
    }
    if (watchIdRef.current !== null) return

    trackingRef.current = true
    firstTrackingFixRef.current = true
    setTracking(true)

    const watchId = navigator.geolocation.watchPosition((position) => {
      const point = gpsFromPosition(position)
      setGpsPosition(point)
      if (trackingRef.current) recordTrackPoint(point)

      if (mapRef.current) {
        if (firstTrackingFixRef.current) {
          firstTrackingFixRef.current = false
          mapRef.current.flyTo([point.lat, point.lng], Math.max(17, mapRef.current.getZoom()), { duration: 0.8 })
        } else {
          mapRef.current.panTo([point.lat, point.lng], { animate: true, duration: 0.35 })
        }
      }
    }, (error) => {
      const permissionDenied = error.code === error.PERMISSION_DENIED
      stopTracking(false)
      onMessage(permissionDenied ? 'Canlı takip için konum izni verilmedi.' : 'Canlı GPS konumu alınamadı. Konum servislerini kontrol edin.', 'error')
    }, {
      enableHighAccuracy: true,
      timeout: 20000,
      maximumAge: 1000,
    })

    watchIdRef.current = watchId
    onMessage('Canlı GPS takibi başlatıldı. Hareket izi kaydediliyor.', 'success')
  }

  const clearTrack = () => {
    setTrackPoints([])
    trackPointsRef.current = []
    setTrackSegmentBreaks([0])
    setRejectedTrackPoints(0)
    localStorage.removeItem(TRACK_STORAGE_KEY)
    onMessage('Kayıtlı canlı konum izi temizlendi.', 'success')
  }

  const liveTrackCommandRef = useRef<(command: LiveTrackCommand) => void>(() => undefined)
  liveTrackCommandRef.current = (command) => {
    if (typeof command === 'object' && command.type === 'segments') {
      setTrackSegmentBreaks(command.segmentBreaks)
    } else if (typeof command === 'object' && command.type === 'load') {
      const points = command.points.map((point, index) => ({
        id: point.id ?? `track-loaded-${index}`,
        lat: point.lat,
        lng: point.lng,
        accuracy: point.accuracy ?? 1,
        altitude: point.altitude ?? null,
        speed: point.speed ?? null,
        heading: point.heading ?? null,
        timestamp: point.timestamp ?? Date.now(),
      }))
      trackPointsRef.current = points
      setTrackPoints(points)
      setTrackSegmentBreaks(command.segmentBreaks)
      setRejectedTrackPoints(command.rejectedCount ?? 0)
    } else if (command === 'start') startTracking()
    else if (command === 'stop') stopTracking()
    else if (command === 'clear') clearTrack()
    else sendLiveTrackStatus({ tracking, points: trackPoints, segmentBreaks: trackSegmentBreaks, rejectedCount: rejectedTrackPoints })
  }

  useEffect(() => {
    const handleCommand = (event: Event) => {
      liveTrackCommandRef.current((event as CustomEvent<LiveTrackCommand>).detail)
    }
    window.addEventListener(LIVE_TRACK_COMMAND_EVENT, handleCommand)
    return () => window.removeEventListener(LIVE_TRACK_COMMAND_EVENT, handleCommand)
  }, [])

  useEffect(() => {
    sendLiveTrackStatus({ tracking, points: trackPoints, segmentBreaks: trackSegmentBreaks, rejectedCount: rejectedTrackPoints })
  }, [tracking, trackPoints, trackSegmentBreaks, rejectedTrackPoints])

  const locate = () => {
    if (gpsPosition && !tracking) {
      setGpsPosition(null)
      onMessage('Konum göstergesi kapatıldı.', 'info')
      return
    }
    if (tracking && gpsPosition) {
      const map = mapRef.current
      if (map) map.flyTo([gpsPosition.lat, gpsPosition.lng], Math.max(17, map.getZoom()), { duration: 0.8 })
      onMessage('Canlı konum takibi açık. Takibi Canlı panelinden durdurabilirsiniz.', 'info')
      return
    }
    if (!navigator.geolocation) {
      onMessage('Bu cihaz konum hizmetini desteklemiyor.', 'error')
      return
    }
    navigator.geolocation.getCurrentPosition((position) => {
      const point = gpsFromPosition(position)
      setGpsPosition(point)
      mapRef.current?.flyTo([point.lat, point.lng], 17, { duration: 0.8 })
      onLocate({ lat: point.lat, lng: point.lng })
      onMessage(`Konum bulundu · yaklaşık ±${formatNumber(point.accuracy, 0)} m hassasiyet`, 'success')
    }, () => onMessage('Konum alınamadı. Cihazın konum iznini kontrol edin.', 'error'), {
      enableHighAccuracy: true,
      timeout: 12000,
      maximumAge: 5000,
    })
  }

  return (
    <main
      className={`map-shell${addMode ? ' add-mode' : ''}${standaloneAddMode ? ' standalone-add-mode' : ''}${measureMode ? ' measure-mode' : ''}${performanceMode ? ' performance-mode' : ''}`}
      style={{ '--card-scale': displaySettings.cardScale / 100 } as CSSProperties}
      data-card-scale={displaySettings.cardScale}
      aria-label="Jeofizik çalışma haritası"
    >
      <MapContainer center={MAP_CENTER} zoom={6} zoomControl={false} doubleClickZoom={false} attributionControl preferCanvas ref={mapRef} className="map-canvas">
        <TileLayer key={baseLayer} url={tileLayers[baseLayer].url} attribution={tileLayers[baseLayer].attribution} />
        {mtaIndex25Visible ? (
          <TileLayer
            key="mta-index-25"
            url="https://mtayenicbs-geoserver.mta.gov.tr/geoserver/gwc/service/tms/1.0.0/mta%3AGRD25@EPSG%3A900913@png/{z}/{x}/{y}.png"
            tms
            opacity={0.9}
            zIndex={320}
            attribution="© MTA Genel Müdürlüğü · İNDEKS 1/25.000"
          />
        ) : null}
        {mtaIndex100Visible ? (
          <TileLayer
            key="mta-index-100"
            url="https://mtayenicbs-geoserver.mta.gov.tr/geoserver/gwc/service/tms/1.0.0/mta%3AGRD1000@EPSG%3A900913@png/{z}/{x}/{y}.png"
            tms
            opacity={0.9}
            zIndex={310}
            attribution="© MTA Genel Müdürlüğü · İNDEKS 1/100.000"
          />
        ) : null}
        <EventBridge
          addMode={addMode}
          standaloneAddMode={standaloneAddMode}
          measureMode={measureMode}
          onAddPoint={onAddPoint}
          onAddStandalonePoint={(point) => {
            onAddStandalonePoint(point)
            onMessage('Nokta eklendi.', 'success')
          }}
          onMeasurePoint={(point) => setMeasurePoints((current) => [...current, point])}
          positionListener={positionListener}
        />
        {polygons.map((layer) => (
          <PolygonLayerView
            key={layer.id}
            layer={layer}
            isActive={layer.id === activeId}
            performanceMode={performanceMode}
            onUpdatePoint={onUpdatePoint}
            onDeletePoint={onDeletePolygonPoint}
            onDeletePolygon={onDeletePolygon}
            onMessage={onMessage}
          />
        ))}
        <StandalonePointLayer points={standalonePoints} onRenamePoint={onRenameStandalonePoint} onDeletePoint={onDeleteStandalonePoint} onMessage={onMessage} />

        {measurePoints.length >= 2 && <Polyline positions={measurePoints.map((point) => [point.lat, point.lng])} pathOptions={{ color: '#ef4444', weight: 3, dashArray: '8 7' }} />}
        {measurePoints.length >= 3 && <Polygon positions={measurePoints.map((point) => [point.lat, point.lng])} pathOptions={{ color: '#ef4444', weight: 2, fillColor: '#ef4444', fillOpacity: 0.08, dashArray: '8 7' }} />}
        {measurePoints.map((point, index) => <CircleMarker key={point.id} center={[point.lat, point.lng]} radius={5} pathOptions={{ color: 'white', weight: 2, fillColor: '#ef4444', fillOpacity: 1 }}><Tooltip direction="top">Ölçüm {index + 1}</Tooltip></CircleMarker>)}

        {trackSegments.map((segment, index) => segment.length >= 2 ? (
          <Polyline
            key={`track-segment-${index}-${segment[0].id}`}
            positions={segment.map((point) => [point.lat, point.lng])}
            pathOptions={{ color: '#f59e0b', weight: 4, opacity: 0.9 }}
          >
            <Tooltip sticky>Rota segmenti {index + 1} · {segment.length} nokta</Tooltip>
          </Polyline>
        ) : null)}
        {trackPoints.length >= 1 && (
          <CircleMarker center={[trackPoints[0].lat, trackPoints[0].lng]} radius={7} pathOptions={{ color: 'white', weight: 3, fillColor: '#22c55e', fillOpacity: 1 }}>
            <Tooltip direction="top">Rota başlangıcı</Tooltip>
          </CircleMarker>
        )}
        {trackPoints.length >= 2 && (
          <CircleMarker center={[trackPoints.at(-1)!.lat, trackPoints.at(-1)!.lng]} radius={7} pathOptions={{ color: 'white', weight: 3, fillColor: tracking ? '#f59e0b' : '#ef4444', fillOpacity: 1 }}>
            <Tooltip direction="top">{tracking ? 'Canlı rota ucu' : 'Rota bitişi'} · {trackPoints.length} nokta · {formatTrackDistance(trackDistanceM)}</Tooltip>
          </CircleMarker>
        )}

        {gpsPosition && (
          <Fragment>
            <Circle center={[gpsPosition.lat, gpsPosition.lng]} radius={gpsPosition.accuracy} pathOptions={{ color: '#2563eb', weight: 1, fillColor: '#3b82f6', fillOpacity: 0.1 }} />
            <CircleMarker center={[gpsPosition.lat, gpsPosition.lng]} radius={7} pathOptions={{ color: 'white', weight: 3, fillColor: tracking ? '#16a34a' : '#2563eb', fillOpacity: 1 }}>
              <Tooltip direction="top">{tracking ? 'CANLI GPS' : 'GPS'} · ±{formatNumber(gpsPosition.accuracy, 0)} m{gpsPosition.speed !== null ? ` · ${formatNumber(gpsPosition.speed * 3.6, 1)} km/sa` : ''}</Tooltip>
            </CircleMarker>
          </Fragment>
        )}
      </MapContainer>

      <CoordinateCard positionListener={positionListener} areaM2={analysis.areaM2} showCoordinate={displaySettings.coordinateCard} showArea={displaySettings.areaCard} />

      {displaySettings.mapActions && (
        <div className="smart-map-tools">
          <button type="button" className={`smart-map-action tone-cyan${addMode ? ' is-active' : ''}`} onClick={() => { if (measureMode) setMeasureMode(false); onToggleAddMode() }} aria-label={addMode ? 'Poligon noktası ekleme açık' : 'Haritaya poligon noktası ekle'} aria-pressed={addMode} title={addMode ? 'Poligon Noktası Açık' : 'Tıkla ve Ekle'}><span className="smart-map-action-icon"><MousePointer2 size={20} /></span><span className="smart-map-action-label">{addMode ? 'Poligon Açık' : 'Tıkla & Ekle'}</span></button>
          <button type="button" className={`smart-map-action tone-amber${standaloneAddMode ? ' is-active' : ''}`} onClick={() => { if (measureMode) setMeasureMode(false); onToggleStandaloneAddMode() }} aria-label={standaloneAddMode ? 'Nokta ekleme açık' : 'Nokta ekle'} aria-pressed={standaloneAddMode} title={standaloneAddMode ? 'Nokta Açık' : 'Nokta'}><span className="smart-map-action-icon"><MapPin size={20} /></span><span className="smart-map-action-label">{standaloneAddMode ? 'Nokta Açık' : 'Nokta'}</span></button>
          <button type="button" className="smart-map-action tone-violet" onClick={addTargetPoint} aria-label={standaloneAddMode ? 'Hedef merkezinden nokta ekle' : 'Hedef merkezinden poligon noktası ekle'} title="Hedeften Ekle"><span className="smart-map-action-icon"><Crosshair size={20} /></span><span className="smart-map-action-label">Hedeften Ekle</span></button>
          <button type="button" className={`smart-map-action tone-rose${measureMode ? ' is-measuring' : ''}`} onClick={toggleMeasurement} aria-label={measureMode ? 'Serbest ölçüm açık' : 'Serbest ölçümü başlat'} aria-pressed={measureMode} title={measureMode ? 'Ölçüm Açık' : 'Serbest Ölç'}><span className="smart-map-action-icon"><Ruler size={20} /></span><span className="smart-map-action-label">{measureMode ? 'Ölçüm Açık' : 'Serbest Ölç'}</span></button>
        </div>
      )}

      {displaySettings.measurementCard && measureMode && (
        <section className="smart-measurement-sheet" aria-live="polite">
          <header><span><Ruler size={16} /> Serbest Ölçüm</span><strong>{measurePoints.length} nokta</strong></header>
          <div><span><small>Mesafe</small><strong>{formatNumber(measurement.distanceM, 2)} m</strong></span><span><small>Son Azimut</small><strong>{measurement.bearing === null ? '—' : `${formatNumber(measurement.bearing, 2)}°`}</strong></span>{measurePoints.length >= 3 && <span><small>Alan</small><strong>{formatAreaShort(measurement.areaM2)}</strong></span>}</div>
          <footer><button type="button" onClick={() => setMeasurePoints((current) => current.slice(0, -1))} disabled={!measurePoints.length}><Undo2 size={14} /> Geri</button><button type="button" onClick={() => setMeasurePoints([])} disabled={!measurePoints.length}><Trash2 size={14} /> Temizle</button><button type="button" onClick={() => setMeasureMode(false)}>Bitir</button></footer>
        </section>
      )}

      {displaySettings.locationCard && (
        <div className="smart-location-controls">
          <button type="button" className={`locate-button tone-cyan${gpsPosition ? ' has-fix' : ''}`} onClick={locate} aria-label={gpsPosition && !tracking ? 'Konum göstergesini kapat' : 'Mevcut konumum'} aria-pressed={Boolean(gpsPosition)} title={gpsPosition && !tracking ? 'Konumu kapat' : tracking ? 'Canlı konuma dön' : 'Mevcut konumu bul'}><LocateFixed size={22} /></button>
          {gpsPosition && <span className="gps-accuracy">±{formatNumber(gpsPosition.accuracy, 0)} m{tracking || trackPoints.length ? ` · ${tracking ? 'CANLI · ' : ''}${trackPoints.length} pkt · ${formatTrackDistance(trackDistanceM)}` : ''}</span>}
        </div>
      )}
      <div className="map-crosshair" aria-hidden="true"><Plus size={28} strokeWidth={1.8} /></div>
    </main>
  )
}
