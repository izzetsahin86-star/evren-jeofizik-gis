import { Fragment, memo, useCallback, useEffect, useMemo, useRef, useState, type CSSProperties, type MutableRefObject } from 'react'
import L, { type LeafletMouseEvent, type Map as LeafletMap } from 'leaflet'
import { Circle, CircleMarker, MapContainer, Marker, Polygon, Polyline, TileLayer, Tooltip, useMapEvents } from 'react-leaflet'
import { Check, Copy, Crosshair, LocateFixed, MousePointer2, Navigation, Plus, Ruler, Square, Trash2, Undo2 } from 'lucide-react'
import { analyzePolygon, formatAreaShort, formatNumber, MAP_CENTER, pointBearing, pointDistance, toUtm, utmLatitudeBand } from '../geo'
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
    html: `<span class="map-number-marker${active ? ' is-active' : ''}" style="--marker:${color}">${number}</span>`,
    iconSize: [30, 30],
    iconAnchor: [15, 15],
  })
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
  measureMode: boolean
  onAddPoint: (point: Omit<GeoPoint, 'id'>) => void
  onMeasurePoint: (point: GeoPoint) => void
  positionListener: MutableRefObject<(point: MapPosition) => void>
}

function EventBridge({ addMode, measureMode, onAddPoint, onMeasurePoint, positionListener }: EventBridgeProps) {
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
}: {
  layer: PolygonLayer
  isActive: boolean
  performanceMode: boolean
  onUpdatePoint: (pointId: string, point: Omit<GeoPoint, 'id'>) => void
}) {
  const strokeWidth = layer.strokeWidth ?? 3
  const strokeOpacity = layer.strokeOpacity ?? 1
  const fillOpacity = layer.fillOpacity ?? 0.14
  const markerIndexes = performanceMode ? (isActive ? sampledIndexes(layer.points.length, 180) : []) : sampledIndexes(layer.points.length, layer.points.length)
  const desIndexes = performanceMode ? sampledIndexes(layer.desPoints.length, 1200) : sampledIndexes(layer.desPoints.length, layer.desPoints.length)

  return (
    <Fragment>
      {layer.points.length >= 3 ? (
        <Polygon
          positions={layer.points.map((point) => [point.lat, point.lng])}
          pathOptions={{
            color: layer.color,
            fillColor: layer.color,
            fillOpacity: isActive ? fillOpacity : fillOpacity * 0.55,
            weight: isActive ? strokeWidth : Math.max(1, strokeWidth - 1),
            opacity: isActive ? strokeOpacity : strokeOpacity * 0.55,
          }}
        />
      ) : layer.points.length >= 2 ? (
        <Polyline positions={layer.points.map((point) => [point.lat, point.lng])} pathOptions={{ color: layer.color, weight: strokeWidth, opacity: strokeOpacity }} />
      ) : null}

      {markerIndexes.map((index) => {
        const point = layer.points[index]
        return (
          <Marker
            key={point.id}
            position={[point.lat, point.lng]}
            icon={numberIcon(index + 1, layer.color, isActive)}
            draggable={isActive && !performanceMode}
            eventHandlers={{
              dragend(event) {
                const location = event.target.getLatLng()
                onUpdatePoint(point.id, { lat: location.lat, lng: location.lng })
              },
            }}
          >
            <Tooltip direction="top" offset={[0, -14]}>{layer.name} · Nokta {index + 1}<br />{point.lat.toFixed(6)}, {point.lng.toFixed(6)}</Tooltip>
          </Marker>
        )
      })}

      {desIndexes.map((index) => {
        const point = layer.desPoints[index]
        return performanceMode ? (
          <CircleMarker key={point.id} center={[point.lat, point.lng]} radius={3} pathOptions={{ color: '#ffffff', weight: 1, fillColor: '#10b981', fillOpacity: 1 }} />
        ) : (
          <Marker key={point.id} position={[point.lat, point.lng]} icon={desIcon()}>
            <Tooltip direction="top" offset={[0, -8]}>{point.name}</Tooltip>
          </Marker>
        )
      })}
    </Fragment>
  )
})

interface MapWorkspaceProps {
  polygons: PolygonLayer[]
  activeId: string
  baseLayer: BaseLayerId
  mtaIndex25Visible: boolean
  mtaIndex100Visible: boolean
  addMode: boolean
  panelOpen: boolean
  performanceMode: boolean
  displaySettings: DisplaySettings
  clearRequest: number
  fitRequest: number
  flyTarget: { lat: number; lng: number; zoom?: number } | null
  onToggleAddMode: () => void
  onAddPoint: (point: Omit<GeoPoint, 'id'>) => void
  onUpdatePoint: (pointId: string, point: Omit<GeoPoint, 'id'>) => void
  onLocate: (point: Omit<GeoPoint, 'id'>) => void
  onMessage: (message: string, tone?: 'success' | 'error' | 'info') => void
}

export default function MapWorkspace({
  polygons,
  activeId,
  baseLayer,
  mtaIndex25Visible,
  mtaIndex100Visible,
  addMode,
  panelOpen,
  performanceMode,
  displaySettings,
  clearRequest,
  fitRequest,
  flyTarget,
  onToggleAddMode,
  onAddPoint,
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
  const active = polygons.find((layer) => layer.id === activeId) ?? polygons[0]
  const analysis = useMemo(() => analyzePolygon(active?.points ?? []), [active])
  const measurement = useMemo(() => {
    const distanceM = measurePoints.slice(1).reduce((sum, point, index) => sum + (pointDistance(measurePoints[index], point) ?? 0), 0)
    const bearing = measurePoints.length >= 2 ? pointBearing(measurePoints[measurePoints.length - 2], measurePoints[measurePoints.length - 1]) : null
    const areaM2 = measurePoints.length >= 3 ? analyzePolygon(measurePoints).areaM2 : 0
    return { distanceM, bearing, areaM2 }
  }, [measurePoints])
  const trackDistanceM = useMemo(() => trackPoints.slice(1).reduce((sum, point, index) => sum + (pointDistance(trackPoints[index], point) ?? 0), 0), [trackPoints])

  useEffect(() => {
    const timer = window.setTimeout(() => mapRef.current?.invalidateSize(), 240)
    return () => window.clearTimeout(timer)
  }, [panelOpen])

  useEffect(() => {
    if (!flyTarget || !mapRef.current) return
    mapRef.current.flyTo([flyTarget.lat, flyTarget.lng], flyTarget.zoom ?? 16, { duration: 0.8 })
  }, [flyTarget])

  useEffect(() => {
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
    onAddPoint({ lat: point.lat, lng: point.lng })
    onMessage('Hedef merkezindeki nokta aktif poligona eklendi.', 'success')
  }

  const toggleMeasurement = () => {
    if (!measureMode && addMode) onToggleAddMode()
    setMeasureMode((value) => !value)
  }

  const recordTrackPoint = (point: GpsPosition) => {
    const next: TrackPoint = { ...point, id: `track-${point.timestamp}-${Math.random().toString(36).slice(2, 7)}` }
    setTrackPoints((current) => {
      const previous = current[current.length - 1]
      if (previous) {
        const movedM = pointDistance(previous, next) ?? 0
        const elapsedMs = Math.max(0, next.timestamp - previous.timestamp)
        if (movedM < 1 && elapsedMs < 10000) return current
      }
      return [...current, next].slice(-MAX_TRACK_POINTS)
    })
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
    localStorage.removeItem(TRACK_STORAGE_KEY)
    onMessage('Kayıtlı canlı konum izi temizlendi.', 'success')
  }

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
      className={`map-shell${addMode ? ' add-mode' : ''}${measureMode ? ' measure-mode' : ''}${performanceMode ? ' performance-mode' : ''}`}
      style={{ '--card-scale': displaySettings.cardScale / 100 } as CSSProperties}
      data-card-scale={displaySettings.cardScale}
      aria-label="Jeofizik çalışma haritası"
    >
      <MapContainer center={MAP_CENTER} zoom={6} zoomControl={false} attributionControl preferCanvas ref={mapRef} className="map-canvas">
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
        <EventBridge addMode={addMode} measureMode={measureMode} onAddPoint={onAddPoint} onMeasurePoint={(point) => setMeasurePoints((current) => [...current, point])} positionListener={positionListener} />
        {polygons.map((layer) => <PolygonLayerView key={layer.id} layer={layer} isActive={layer.id === activeId} performanceMode={performanceMode} onUpdatePoint={onUpdatePoint} />)}

        {measurePoints.length >= 2 && <Polyline positions={measurePoints.map((point) => [point.lat, point.lng])} pathOptions={{ color: '#ef4444', weight: 3, dashArray: '8 7' }} />}
        {measurePoints.length >= 3 && <Polygon positions={measurePoints.map((point) => [point.lat, point.lng])} pathOptions={{ color: '#ef4444', weight: 2, fillColor: '#ef4444', fillOpacity: 0.08, dashArray: '8 7' }} />}
        {measurePoints.map((point, index) => <CircleMarker key={point.id} center={[point.lat, point.lng]} radius={5} pathOptions={{ color: 'white', weight: 2, fillColor: '#ef4444', fillOpacity: 1 }}><Tooltip direction="top">Ölçüm {index + 1}</Tooltip></CircleMarker>)}

        {trackPoints.length >= 2 && (
          <Polyline
            positions={trackPoints.map((point) => [point.lat, point.lng])}
            pathOptions={{ color: '#f59e0b', weight: 4, opacity: 0.9 }}
          >
            <Tooltip sticky>Canlı takip izi · {trackPoints.length} kayıt · {formatTrackDistance(trackDistanceM)}</Tooltip>
          </Polyline>
        )}
        {trackPoints.length === 1 && <CircleMarker center={[trackPoints[0].lat, trackPoints[0].lng]} radius={4} pathOptions={{ color: '#f59e0b', weight: 2, fillColor: '#f59e0b', fillOpacity: 1 }} />}

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
          <button type="button" className={`smart-map-action tone-cyan${addMode ? ' is-active' : ''}`} onClick={() => { if (measureMode) setMeasureMode(false); onToggleAddMode() }} aria-label={addMode ? 'Haritaya nokta ekleme açık' : 'Haritaya tıklayarak nokta ekle'} aria-pressed={addMode} title={addMode ? 'Haritaya Tıklayın' : 'Tıkla ve Ekle'}><span className="smart-map-action-icon"><MousePointer2 size={20} /></span><span className="smart-map-action-label">{addMode ? 'Ekleme Açık' : 'Tıkla & Ekle'}</span></button>
          <button type="button" className="smart-map-action tone-violet" onClick={addTargetPoint} aria-label="Hedef merkezinden nokta ekle" title="Hedeften Ekle"><span className="smart-map-action-icon"><Crosshair size={20} /></span><span className="smart-map-action-label">Hedeften Ekle</span></button>
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
          <button type="button" className={`locate-button tone-green${tracking ? ' is-tracking' : ''}`} onClick={() => tracking ? stopTracking() : startTracking()} aria-label={tracking ? 'Canlı konum takibini durdur' : 'Canlı konum takibini başlat'} aria-pressed={tracking} title={tracking ? 'Canlı takibi durdur' : 'Canlı takibi başlat'}>{tracking ? <Square size={18} fill="currentColor" /> : <Navigation size={21} />}</button>
          {gpsPosition && <span className="gps-accuracy">±{formatNumber(gpsPosition.accuracy, 0)} m{tracking || trackPoints.length ? ` · ${tracking ? 'CANLI · ' : ''}${trackPoints.length} pkt · ${formatTrackDistance(trackDistanceM)}` : ''}</span>}
          {trackPoints.length > 0 && !tracking && <button type="button" className="locate-button tone-rose" onClick={clearTrack} aria-label="Canlı takip izini temizle" title="Takip izini temizle"><Trash2 size={18} /></button>}
        </div>
      )}
      <div className="map-crosshair" aria-hidden="true"><Plus size={28} strokeWidth={1.8} /></div>
    </main>
  )
}
