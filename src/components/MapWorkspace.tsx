import { Fragment, memo, useCallback, useEffect, useMemo, useRef, useState, type MutableRefObject } from 'react'
import L, { type LeafletMouseEvent, type Map as LeafletMap } from 'leaflet'
import { Circle, CircleMarker, MapContainer, Marker, Polygon, Polyline, TileLayer, Tooltip, useMapEvents } from 'react-leaflet'
import { Check, Copy, Crosshair, LocateFixed, MousePointer2, Ruler, Trash2, Undo2 } from 'lucide-react'
import { analyzePolygon, formatAreaShort, formatNumber, formatPoint, MAP_CENTER, pointBearing, pointDistance } from '../geo'
import type { BaseLayerId, GeoPoint, PolygonLayer } from '../types'

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

type MapPosition = { lat: number; lng: number }

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
  const timer = useRef<number | null>(null)
  const coarsePointer = useRef(window.matchMedia('(pointer: coarse)').matches)

  const flushPosition = useCallback(() => {
    if (timer.current !== null) window.clearTimeout(timer.current)
    timer.current = null
    if (!pendingPosition.current) return
    positionListener.current(pendingPosition.current)
    pendingPosition.current = null
  }, [positionListener])

  const queuePosition = useCallback((point: MapPosition) => {
    pendingPosition.current = point
    if (timer.current === null) timer.current = window.setTimeout(flushPosition, 80)
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
    if (timer.current !== null) window.clearTimeout(timer.current)
  }, [])

  return null
}

interface CoordinateCardProps {
  positionListener: MutableRefObject<(point: MapPosition) => void>
  areaM2: number
}

function CoordinateCard({ positionListener, areaM2 }: CoordinateCardProps) {
  const [position, setPosition] = useState<MapPosition>({ lat: MAP_CENTER[0], lng: MAP_CENTER[1] })
  const [copied, setCopied] = useState(false)
  const point = useMemo<GeoPoint>(() => ({ id: 'map-position', ...position }), [position])
  const formatted = useMemo(() => formatPoint(point, 'utm'), [point])

  useEffect(() => {
    positionListener.current = setPosition
    return () => { positionListener.current = () => undefined }
  }, [positionListener])

  const copyCoordinate = async () => {
    try {
      await navigator.clipboard.writeText(formatted)
    } catch {
      const input = document.createElement('textarea')
      input.value = formatted
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
    <section className="coordinate-card" aria-label="UTM harita koordinatı">
      <button type="button" className="coordinate-copy" onClick={copyCoordinate} title="UTM koordinatını kopyala">
        <span>{formatted}</span>{copied ? <Check size={14} /> : <Copy size={14} />}
      </button>
      {areaM2 > 0 && <em>{formatAreaShort(areaM2)} alan</em>}
    </section>
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
  addMode: boolean
  panelOpen: boolean
  performanceMode: boolean
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
  addMode,
  panelOpen,
  performanceMode,
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
  const [measureMode, setMeasureMode] = useState(false)
  const [measurePoints, setMeasurePoints] = useState<GeoPoint[]>([])
  const [gpsPosition, setGpsPosition] = useState<(MapPosition & { accuracy: number }) | null>(null)
  const active = polygons.find((layer) => layer.id === activeId) ?? polygons[0]
  const analysis = useMemo(() => analyzePolygon(active?.points ?? []), [active])
  const measurement = useMemo(() => {
    const distanceM = measurePoints.slice(1).reduce((sum, point, index) => sum + (pointDistance(measurePoints[index], point) ?? 0), 0)
    const bearing = measurePoints.length >= 2 ? pointBearing(measurePoints[measurePoints.length - 2], measurePoints[measurePoints.length - 1]) : null
    const areaM2 = measurePoints.length >= 3 ? analyzePolygon(measurePoints).areaM2 : 0
    return { distanceM, bearing, areaM2 }
  }, [measurePoints])

  useEffect(() => {
    const timer = window.setTimeout(() => mapRef.current?.invalidateSize(), 240)
    return () => window.clearTimeout(timer)
  }, [panelOpen])

  useEffect(() => {
    if (!flyTarget || !mapRef.current) return
    mapRef.current.flyTo([flyTarget.lat, flyTarget.lng], flyTarget.zoom ?? 16, { duration: 0.8 })
  }, [flyTarget])

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

  const locate = () => {
    if (!navigator.geolocation) {
      onMessage('Bu cihaz konum hizmetini desteklemiyor.', 'error')
      return
    }
    navigator.geolocation.getCurrentPosition((position) => {
      const point = { lat: position.coords.latitude, lng: position.coords.longitude }
      const accuracy = Math.max(1, position.coords.accuracy)
      setGpsPosition({ ...point, accuracy })
      mapRef.current?.flyTo([point.lat, point.lng], 17, { duration: 0.8 })
      onLocate(point)
      onMessage(`Konum bulundu · yaklaşık ±${formatNumber(accuracy, 0)} m hassasiyet`, 'success')
    }, () => onMessage('Konum alınamadı. Cihazın konum iznini kontrol edin.', 'error'), {
      enableHighAccuracy: true,
      timeout: 12000,
      maximumAge: 5000,
    })
  }

  return (
    <main className={`map-shell${addMode ? ' add-mode' : ''}${measureMode ? ' measure-mode' : ''}${performanceMode ? ' performance-mode' : ''}`} aria-label="Jeofizik çalışma haritası">
      <MapContainer center={MAP_CENTER} zoom={6} zoomControl={false} attributionControl preferCanvas ref={mapRef} className="map-canvas">
        <TileLayer key={baseLayer} url={tileLayers[baseLayer].url} attribution={tileLayers[baseLayer].attribution} />
        <EventBridge addMode={addMode} measureMode={measureMode} onAddPoint={onAddPoint} onMeasurePoint={(point) => setMeasurePoints((current) => [...current, point])} positionListener={positionListener} />
        {polygons.map((layer) => <PolygonLayerView key={layer.id} layer={layer} isActive={layer.id === activeId} performanceMode={performanceMode} onUpdatePoint={onUpdatePoint} />)}

        {measurePoints.length >= 2 && <Polyline positions={measurePoints.map((point) => [point.lat, point.lng])} pathOptions={{ color: '#ef4444', weight: 3, dashArray: '8 7' }} />}
        {measurePoints.length >= 3 && <Polygon positions={measurePoints.map((point) => [point.lat, point.lng])} pathOptions={{ color: '#ef4444', weight: 2, fillColor: '#ef4444', fillOpacity: 0.08, dashArray: '8 7' }} />}
        {measurePoints.map((point, index) => <CircleMarker key={point.id} center={[point.lat, point.lng]} radius={5} pathOptions={{ color: 'white', weight: 2, fillColor: '#ef4444', fillOpacity: 1 }}><Tooltip direction="top">Ölçüm {index + 1}</Tooltip></CircleMarker>)}

        {gpsPosition && (
          <Fragment>
            <Circle center={[gpsPosition.lat, gpsPosition.lng]} radius={gpsPosition.accuracy} pathOptions={{ color: '#2563eb', weight: 1, fillColor: '#3b82f6', fillOpacity: 0.1 }} />
            <CircleMarker center={[gpsPosition.lat, gpsPosition.lng]} radius={7} pathOptions={{ color: 'white', weight: 3, fillColor: '#2563eb', fillOpacity: 1 }}><Tooltip direction="top">GPS · ±{formatNumber(gpsPosition.accuracy, 0)} m</Tooltip></CircleMarker>
          </Fragment>
        )}
      </MapContainer>

      <CoordinateCard positionListener={positionListener} areaM2={analysis.areaM2} />

      <div className="map-mode-actions">
        <button type="button" className={addMode ? 'is-active' : ''} onClick={() => { if (measureMode) setMeasureMode(false); onToggleAddMode() }}><MousePointer2 size={17} /> {addMode ? 'Haritaya Tıklayın' : 'Tıkla & Ekle'}</button>
        <button type="button" onClick={addTargetPoint}><Crosshair size={17} /> Hedeften Ekle</button>
        <button type="button" className={measureMode ? 'is-measuring' : ''} onClick={toggleMeasurement}><Ruler size={17} /> {measureMode ? 'Ölçüm Açık' : 'Serbest Ölç'}</button>
      </div>

      {measureMode && (
        <section className="measurement-card" aria-live="polite">
          <header><span><Ruler size={16} /> Serbest Ölçüm</span><strong>{measurePoints.length} nokta</strong></header>
          <div><span><small>Mesafe</small><strong>{formatNumber(measurement.distanceM, 2)} m</strong></span><span><small>Son Azimut</small><strong>{measurement.bearing === null ? '—' : `${formatNumber(measurement.bearing, 2)}°`}</strong></span>{measurePoints.length >= 3 && <span><small>Alan</small><strong>{formatAreaShort(measurement.areaM2)}</strong></span>}</div>
          <footer><button type="button" onClick={() => setMeasurePoints((current) => current.slice(0, -1))} disabled={!measurePoints.length}><Undo2 size={14} /> Geri</button><button type="button" onClick={() => setMeasurePoints([])} disabled={!measurePoints.length}><Trash2 size={14} /> Temizle</button><button type="button" onClick={() => setMeasureMode(false)}>Bitir</button></footer>
        </section>
      )}

      <button type="button" className={`locate-button${gpsPosition ? ' has-fix' : ''}`} onClick={locate} aria-label="Mevcut konumum"><LocateFixed size={22} /></button>
      {gpsPosition && <span className="gps-accuracy">±{formatNumber(gpsPosition.accuracy, 0)} m</span>}
      <div className="map-crosshair" aria-hidden="true"><Crosshair size={24} strokeWidth={1.4} /></div>
    </main>
  )
}
