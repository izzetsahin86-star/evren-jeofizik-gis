import { Fragment, useCallback, useEffect, useMemo, useRef, useState, type MutableRefObject } from 'react'
import L, { type LeafletMouseEvent, type Map as LeafletMap } from 'leaflet'
import { MapContainer, Marker, Polygon, Polyline, TileLayer, Tooltip, useMapEvents } from 'react-leaflet'
import { Crosshair, LocateFixed, MousePointer2, Plus } from 'lucide-react'
import { analyzePolygon, formatAreaShort, MAP_CENTER, toUtm } from '../geo'
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

interface EventBridgeProps {
  addMode: boolean
  onAddPoint: (point: Omit<GeoPoint, 'id'>) => void
  positionListener: MutableRefObject<(point: MapPosition) => void>
}

type MapPosition = { lat: number; lng: number }

function EventBridge({ addMode, onAddPoint, positionListener }: EventBridgeProps) {
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

  useEffect(() => () => {
    if (timer.current !== null) window.clearTimeout(timer.current)
  }, [])

  useMapEvents({
    click(event: LeafletMouseEvent) {
      if (addMode) onAddPoint({ lat: event.latlng.lat, lng: event.latlng.lng })
    },
    mousemove(event: LeafletMouseEvent) {
      if (!coarsePointer.current) queuePosition({ lat: event.latlng.lat, lng: event.latlng.lng })
    },
    move(event) {
      if (!coarsePointer.current) return
      const center = event.target.getCenter()
      queuePosition({ lat: center.lat, lng: center.lng })
    },
    moveend(event) {
      if (!coarsePointer.current) return
      const center = event.target.getCenter()
      pendingPosition.current = { lat: center.lat, lng: center.lng }
      flushPosition()
    },
  })
  return null
}

interface CoordinateCardProps {
  mapRef: MutableRefObject<LeafletMap | null>
  positionListener: MutableRefObject<(point: MapPosition) => void>
  areaM2: number
}

function CoordinateCard({ mapRef, positionListener, areaM2 }: CoordinateCardProps) {
  const [position, setPosition] = useState<MapPosition>({ lat: MAP_CENTER[0], lng: MAP_CENTER[1] })
  const utm = useMemo(() => toUtm(position.lat, position.lng), [position])

  useEffect(() => {
    positionListener.current = setPosition
    return () => { positionListener.current = () => undefined }
  }, [positionListener])

  return (
    <button type="button" className="coordinate-card" onClick={() => mapRef.current?.flyTo([position.lat, position.lng], Math.max(mapRef.current.getZoom(), 15))}>
      <strong>{position.lat.toFixed(5)}°N&nbsp; {position.lng.toFixed(5)}°E</strong>
      <span>{utm.zone}{utm.hemisphere}&nbsp; {utm.easting.toFixed(0)}&nbsp; {utm.northing.toFixed(0)}</span>
      {areaM2 > 0 && <em>{formatAreaShort(areaM2)} alan</em>}
    </button>
  )
}

interface MapWorkspaceProps {
  polygons: PolygonLayer[]
  activeId: string
  baseLayer: BaseLayerId
  addMode: boolean
  panelOpen: boolean
  fitRequest: number
  flyTarget: { lat: number; lng: number; zoom?: number } | null
  onToggleAddMode: () => void
  onAddPoint: (point: Omit<GeoPoint, 'id'>) => void
  onUpdatePoint: (pointId: string, point: Omit<GeoPoint, 'id'>) => void
  onLocate: (point: Omit<GeoPoint, 'id'>) => void
}

export default function MapWorkspace({
  polygons,
  activeId,
  baseLayer,
  addMode,
  panelOpen,
  fitRequest,
  flyTarget,
  onToggleAddMode,
  onAddPoint,
  onUpdatePoint,
  onLocate,
}: MapWorkspaceProps) {
  const mapRef = useRef<LeafletMap | null>(null)
  const positionListener = useRef<(point: MapPosition) => void>(() => undefined)
  const active = polygons.find((layer) => layer.id === activeId) ?? polygons[0]
  const analysis = useMemo(() => analyzePolygon(active?.points ?? []), [active])

  useEffect(() => {
    const timer = window.setTimeout(() => mapRef.current?.invalidateSize(), 240)
    return () => window.clearTimeout(timer)
  }, [panelOpen])

  useEffect(() => {
    if (!flyTarget || !mapRef.current) return
    mapRef.current.flyTo([flyTarget.lat, flyTarget.lng], flyTarget.zoom ?? 16, { duration: 0.8 })
  }, [flyTarget])

  useEffect(() => {
    if (!fitRequest || !mapRef.current || !active?.points.length) return
    if (active.points.length === 1) {
      mapRef.current.flyTo([active.points[0].lat, active.points[0].lng], 16, { duration: 0.8 })
      return
    }
    mapRef.current.fitBounds(active.points.map((point) => [point.lat, point.lng]), { padding: [70, 70], maxZoom: 17 })
  }, [fitRequest, active])

  const locate = () => {
    if (!navigator.geolocation) return
    navigator.geolocation.getCurrentPosition((position) => {
      const point = { lat: position.coords.latitude, lng: position.coords.longitude }
      mapRef.current?.flyTo([point.lat, point.lng], 17, { duration: 0.8 })
      onLocate(point)
    })
  }

  return (
    <main className={`map-shell${addMode ? ' add-mode' : ''}`} aria-label="Jeofizik çalışma haritası">
      <MapContainer
        center={MAP_CENTER}
        zoom={6}
        zoomControl={false}
        attributionControl
        ref={mapRef}
        className="map-canvas"
      >
        <TileLayer key={baseLayer} url={tileLayers[baseLayer].url} attribution={tileLayers[baseLayer].attribution} />
        <EventBridge addMode={addMode} onAddPoint={onAddPoint} positionListener={positionListener} />
        {polygons.map((layer) => {
          const isActive = layer.id === activeId
          return (
            <Fragment key={layer.id}>
              {layer.points.length >= 3 ? (
                <Polygon
                  positions={layer.points.map((point) => [point.lat, point.lng])}
                  pathOptions={{ color: layer.color, fillColor: layer.color, fillOpacity: isActive ? 0.14 : 0.06, weight: isActive ? 3 : 2, opacity: isActive ? 1 : 0.48 }}
                />
              ) : layer.points.length >= 2 ? (
                <Polyline positions={layer.points.map((point) => [point.lat, point.lng])} pathOptions={{ color: layer.color, weight: 3 }} />
              ) : null}
              {layer.points.map((point, index) => (
                <Marker
                  key={point.id}
                  position={[point.lat, point.lng]}
                  icon={numberIcon(index + 1, layer.color, isActive)}
                  draggable={isActive}
                  eventHandlers={{
                    dragend(event) {
                      const location = event.target.getLatLng()
                      onUpdatePoint(point.id, { lat: location.lat, lng: location.lng })
                    },
                  }}
                >
                  <Tooltip direction="top" offset={[0, -14]}>
                    {layer.name} · Nokta {index + 1}<br />{point.lat.toFixed(6)}, {point.lng.toFixed(6)}
                  </Tooltip>
                </Marker>
              ))}
              {layer.desPoints.map((point) => (
                <Marker key={point.id} position={[point.lat, point.lng]} icon={desIcon()}>
                  <Tooltip direction="top" offset={[0, -8]}>{point.name}</Tooltip>
                </Marker>
              ))}
            </Fragment>
          )
        })}
      </MapContainer>

      <CoordinateCard mapRef={mapRef} positionListener={positionListener} areaM2={analysis.areaM2} />

      <div className="map-mode-actions">
        <button type="button" className={addMode ? 'is-active' : ''} onClick={onToggleAddMode}>
          <MousePointer2 size={17} /> {addMode ? 'Haritaya Tıklayın' : 'Tıkla & Ekle'}
        </button>
        <button type="button" onClick={onToggleAddMode}>
          <Plus size={18} /> Nokta
        </button>
      </div>

      <button type="button" className="locate-button" onClick={locate} aria-label="Mevcut konumum">
        <LocateFixed size={22} />
      </button>

      <div className="map-crosshair" aria-hidden="true"><Crosshair size={24} strokeWidth={1.4} /></div>
    </main>
  )
}
