import { useEffect, useMemo, useRef, useState } from 'react'
import {
  Expand,
  Move,
  Redo2,
  Trash2,
  Undo2,
  X,
} from 'lucide-react'
import BottomPanel from './components/BottomPanel'
import LiveTrackingCoordinatePanel from './components/LiveTrackingCoordinatePanel'
import MapWorkspace from './components/MapWorkspace'
import { dockItems } from './dock'
import { DEFAULT_POLYGON_APPEARANCE, POLYGON_COLORS, analyzePolygon, formatAreaShort, uid } from './geo'
import type { BaseLayerId, DisplaySettings, GeoPoint, PanelId, PerformanceMode, PolygonAppearance, PolygonLayer } from './types'

const WORKSPACE_KEY = 'evren-jeofizik-gis-workspace-v1'
const LEGACY_PROJECTS_KEY = 'evren-jeofizik-gis-projects-v1'
const PERFORMANCE_KEY = 'evren-jeofizik-gis-performance-v1'
const DISPLAY_KEY = 'evren-jeofizik-gis-display-v2'
const LEGACY_DISPLAY_KEY = 'evren-jeofizik-gis-display-v1'
const MIN_CARD_SCALE = 70
const MAX_CARD_SCALE = 160

const DEFAULT_DISPLAY_SETTINGS: DisplaySettings = {
  coordinateCard: true,
  areaCard: true,
  mapActions: true,
  measurementCard: true,
  locationCard: true,
  headerStats: true,
  cardScale: 100,
}

function createPolygon(index = 0): PolygonLayer {
  return {
    id: uid('polygon'),
    name: `Poligon ${index + 1}`,
    color: POLYGON_COLORS[index % POLYGON_COLORS.length],
    ...DEFAULT_POLYGON_APPEARANCE,
    points: [],
    desPoints: [],
  }
}

function normalizePolygon(layer: Partial<PolygonLayer>, index: number): PolygonLayer {
  return {
    id: layer.id || uid('polygon'),
    name: layer.name || `Poligon ${index + 1}`,
    color: layer.color || POLYGON_COLORS[index % POLYGON_COLORS.length],
    strokeWidth: layer.strokeWidth ?? DEFAULT_POLYGON_APPEARANCE.strokeWidth,
    strokeOpacity: layer.strokeOpacity ?? DEFAULT_POLYGON_APPEARANCE.strokeOpacity,
    fillOpacity: layer.fillOpacity ?? DEFAULT_POLYGON_APPEARANCE.fillOpacity,
    points: Array.isArray(layer.points) ? layer.points : [],
    desPoints: Array.isArray(layer.desPoints) ? layer.desPoints : [],
  }
}

function readWorkspace() {
  try {
    const value = JSON.parse(localStorage.getItem(WORKSPACE_KEY) || 'null')
    if (Array.isArray(value) && value.length) return value.map(normalizePolygon)
  } catch { /* Empty storage uses a fresh workspace. */ }
  return [createPolygon()]
}

function readDisplaySettings(): DisplaySettings {
  try {
    const stored = localStorage.getItem(DISPLAY_KEY) || localStorage.getItem(LEGACY_DISPLAY_KEY) || '{}'
    const value = JSON.parse(stored) as Partial<DisplaySettings> & { cardSize?: string }
    const legacyScale = value.cardSize === 'large' ? 145 : value.cardSize === 'medium' ? 120 : DEFAULT_DISPLAY_SETTINGS.cardScale
    const cardScale = typeof value.cardScale === 'number' && Number.isFinite(value.cardScale)
      ? Math.min(MAX_CARD_SCALE, Math.max(MIN_CARD_SCALE, Math.round(value.cardScale / 5) * 5))
      : legacyScale
    return {
      coordinateCard: typeof value.coordinateCard === 'boolean' ? value.coordinateCard : DEFAULT_DISPLAY_SETTINGS.coordinateCard,
      areaCard: typeof value.areaCard === 'boolean' ? value.areaCard : DEFAULT_DISPLAY_SETTINGS.areaCard,
      mapActions: typeof value.mapActions === 'boolean' ? value.mapActions : DEFAULT_DISPLAY_SETTINGS.mapActions,
      measurementCard: typeof value.measurementCard === 'boolean' ? value.measurementCard : DEFAULT_DISPLAY_SETTINGS.measurementCard,
      locationCard: typeof value.locationCard === 'boolean' ? value.locationCard : DEFAULT_DISPLAY_SETTINGS.locationCard,
      headerStats: typeof value.headerStats === 'boolean' ? value.headerStats : DEFAULT_DISPLAY_SETTINGS.headerStats,
      cardScale,
    }
  } catch {
    return DEFAULT_DISPLAY_SETTINGS
  }
}

function clonePolygons(polygons: PolygonLayer[]) {
  return structuredClone(polygons)
}

export default function App() {
  const [polygons, setPolygonsState] = useState<PolygonLayer[]>(readWorkspace)
  const [activeId, setActiveId] = useState(() => polygons[0].id)
  const [baseLayer, setBaseLayer] = useState<BaseLayerId>('street')
  const [activePanel, setActivePanel] = useState<PanelId | null>(null)
  const [addMode, setAddMode] = useState(false)
  const [fitRequest, setFitRequest] = useState(0)
  const [flyTarget, setFlyTarget] = useState<{ lat: number; lng: number; zoom?: number } | null>(null)
  const [performanceMode, setPerformanceMode] = useState<PerformanceMode>(() => {
    const saved = localStorage.getItem(PERFORMANCE_KEY)
    return saved === 'on' || saved === 'off' ? saved : 'auto'
  })
  const [displaySettings, setDisplaySettings] = useState<DisplaySettings>(readDisplaySettings)
  const [clearRequest, setClearRequest] = useState(0)
  const [isOnline, setIsOnline] = useState(navigator.onLine)
  const [toast, setToast] = useState<{ id: string; message: string; tone: 'success' | 'error' | 'info' } | null>(null)
  const undoStack = useRef<PolygonLayer[][]>([])
  const redoStack = useRef<PolygonLayer[][]>([])

  const active = polygons.find((layer) => layer.id === activeId) ?? polygons[0]
  const totalPoints = polygons.reduce((sum, layer) => sum + layer.points.length, 0)
  const totalDesPoints = polygons.reduce((sum, layer) => sum + layer.desPoints.length, 0)
  const performanceActive = performanceMode === 'on' || (performanceMode === 'auto' && (totalPoints > 350 || totalDesPoints > 1200))
  const activeAnalysis = useMemo(() => analyzePolygon(active?.points ?? []), [active])

  useEffect(() => {
    localStorage.setItem(WORKSPACE_KEY, JSON.stringify(polygons))
  }, [polygons])

  useEffect(() => {
    localStorage.setItem(PERFORMANCE_KEY, performanceMode)
  }, [performanceMode])

  useEffect(() => {
    localStorage.setItem(DISPLAY_KEY, JSON.stringify(displaySettings))
  }, [displaySettings])

  useEffect(() => {
    const updateConnection = () => setIsOnline(navigator.onLine)
    window.addEventListener('online', updateConnection)
    window.addEventListener('offline', updateConnection)
    return () => {
      window.removeEventListener('online', updateConnection)
      window.removeEventListener('offline', updateConnection)
    }
  }, [])

  useEffect(() => {
    if (!toast) return
    const timer = window.setTimeout(() => setToast(null), 3400)
    return () => window.clearTimeout(timer)
  }, [toast])

  useEffect(() => {
    if (!polygons.some((layer) => layer.id === activeId)) setActiveId(polygons[0]?.id ?? '')
  }, [polygons, activeId])

  const message = (text: string, tone: 'success' | 'error' | 'info' = 'info') => setToast({ id: uid('toast'), message: text, tone })

  const updatePolygons = (updater: (current: PolygonLayer[]) => PolygonLayer[]) => {
    setPolygonsState((current) => {
      const next = updater(current)
      if (next === current) return current
      undoStack.current.push(clonePolygons(current))
      if (undoStack.current.length > 40) undoStack.current.shift()
      redoStack.current = []
      return next
    })
  }

  const undo = () => {
    const previous = undoStack.current.pop()
    if (!previous) return
    redoStack.current.push(clonePolygons(polygons))
    setPolygonsState(previous)
  }

  const redo = () => {
    const next = redoStack.current.pop()
    if (!next) return
    undoStack.current.push(clonePolygons(polygons))
    setPolygonsState(next)
  }

  const mutateActive = (fn: (layer: PolygonLayer) => PolygonLayer) => {
    updatePolygons((current) => current.map((layer) => layer.id === activeId ? fn(layer) : layer))
  }

  const addPoints = (points: Array<Omit<GeoPoint, 'id'>>, fit = true) => {
    mutateActive((layer) => ({ ...layer, points: [...layer.points, ...points.map((point) => ({ ...point, id: uid('pt') }))] }))
    if (fit) window.setTimeout(() => setFitRequest((value) => value + 1), 80)
  }

  const updatePoint = (pointId: string, point: Omit<GeoPoint, 'id'>) => {
    mutateActive((layer) => ({ ...layer, points: layer.points.map((item) => item.id === pointId ? { ...item, ...point } : item) }))
  }

  const newPolygon = () => {
    const layer = createPolygon(polygons.length)
    updatePolygons((current) => [...current, layer])
    setActiveId(layer.id)
    setActivePanel('coordinates')
  }

  const deletePolygon = (id: string) => {
    if (polygons.length === 1) return
    updatePolygons((current) => current.filter((layer) => layer.id !== id))
    if (activeId === id) setActiveId(polygons.find((layer) => layer.id !== id)?.id ?? '')
  }

  const duplicatePolygon = (id: string) => {
    const source = polygons.find((layer) => layer.id === id)
    if (!source) return
    const copy: PolygonLayer = { ...clonePolygons([source])[0], id: uid('polygon'), name: `${source.name} Kopya`, color: POLYGON_COLORS[polygons.length % POLYGON_COLORS.length], points: source.points.map((point) => ({ ...point, id: uid('pt') })), desPoints: source.desPoints.map((point) => ({ ...point, id: uid('des') })) }
    updatePolygons((current) => [...current, copy])
    setActiveId(copy.id)
  }

  const importLayers = (layers: PolygonLayer[]) => {
    updatePolygons((current) => {
      const shouldReplaceBlank = current.length === 1 && current[0].points.length === 0
      return shouldReplaceBlank ? layers : [...current, ...layers]
    })
    setActiveId(layers[0].id)
    window.setTimeout(() => setFitRequest((value) => value + 1), 80)
  }

  const convertTrackToPolygon = (points: Array<{ lat: number; lng: number }>) => {
    if (points.length < 3) {
      message('Poligona dönüştürmek için en az 3 GPS noktası gerekir.', 'error')
      return
    }

    const layer = createPolygon(polygons.length)
    const now = new Date()
    layer.name = `GPS Takip ${now.toLocaleDateString('tr-TR', { day: '2-digit', month: '2-digit' })} ${now.toLocaleTimeString('tr-TR', { hour: '2-digit', minute: '2-digit' })}`
    layer.points = points.map((point) => ({ ...point, id: uid('pt') }))

    updatePolygons((current) => {
      const shouldReplaceBlank = current.length === 1 && current[0].points.length === 0
      return shouldReplaceBlank ? [layer] : [...current, layer]
    })
    setActiveId(layer.id)
    setActivePanel('coordinates')
    window.setTimeout(() => setFitRequest((value) => value + 1), 100)
    message(`${points.length} GPS noktası yeni poligona dönüştürüldü.`, 'success')
  }

  const resetWorkspace = () => {
    setActivePanel(null)
    setAddMode(false)
    setBaseLayer('street')
    setFitRequest((value) => value + 1)
    message('Çalışma düzeni sıfırlandı.', 'success')
  }

  const clearAllData = () => {
    const blank = createPolygon()
    localStorage.removeItem(WORKSPACE_KEY)
    localStorage.removeItem(LEGACY_PROJECTS_KEY)
    setPolygonsState([blank])
    setActiveId(blank.id)
    setAddMode(false)
    setFlyTarget(null)
    undoStack.current = []
    redoStack.current = []
    setClearRequest((value) => value + 1)
    message('Tüm harita verileri silindi.', 'success')
  }

  return (
    <div className="app-shell">
      <header className="app-header">
        <div className="brand">
          <img className="brand-logo" src="/icons/evren-jeofizik-logo.svg" alt="Evren Jeofizik logosu" />
          <strong>Evren Jeofizik <span>GIS</span></strong>
        </div>
        <div className="header-actions">
          {displaySettings.headerStats && (
            <>
              <span className="stat-pill violet">{polygons.length} pol</span>
              <span className="stat-pill blue">{totalPoints} pkt</span>
              {activeAnalysis.areaM2 > 0 && <span className="stat-pill green">{formatAreaShort(activeAnalysis.areaM2)}</span>}
              <i className="header-divider" />
            </>
          )}
          <button type="button" onClick={undo} disabled={!undoStack.current.length} aria-label="Geri al"><Undo2 size={17} /></button>
          <button type="button" onClick={redo} disabled={!redoStack.current.length} aria-label="Yinele"><Redo2 size={17} /></button>
          <button type="button" onClick={resetWorkspace} aria-label="Düzeni sıfırla" title="Düzeni sıfırla"><Move size={17} /></button>
          <button type="button" onClick={() => setFitRequest((value) => value + 1)} aria-label="Poligona yakınlaş"><Expand size={17} /></button>
          <button type="button" className="danger" onClick={() => mutateActive((layer) => ({ ...layer, points: [], desPoints: [] }))} aria-label="Aktif poligonu temizle"><Trash2 size={17} /></button>
        </div>
      </header>

      <div className="active-strip">
        <span className="strip-color" style={{ background: active?.color }} />
        <strong>{active?.name ?? 'Poligon'}</strong>
        <span>{active?.points.length ?? 0} nokta</span>
        {performanceActive && <span className="strip-status performance">Hızlı mod</span>}
        <span className={`strip-status ${isOnline ? 'online' : 'offline'}`}>{isOnline ? 'Çevrimiçi' : 'Çevrimdışı'}</span>
      </div>

      <MapWorkspace
        polygons={polygons}
        activeId={activeId}
        baseLayer={baseLayer}
        addMode={addMode}
        panelOpen={Boolean(activePanel)}
        performanceMode={performanceActive}
        displaySettings={displaySettings}
        clearRequest={clearRequest}
        fitRequest={fitRequest}
        flyTarget={flyTarget}
        onToggleAddMode={() => setAddMode((value) => !value)}
        onAddPoint={(point) => addPoints([point], false)}
        onUpdatePoint={updatePoint}
        onLocate={(point) => setFlyTarget({ ...point, zoom: 17 })}
        onMessage={message}
      />

      {activePanel && (
        <BottomPanel
          panel={activePanel}
          polygons={polygons}
          activeId={activeId}
          baseLayer={baseLayer}
          performanceMode={performanceMode}
          performanceActive={performanceActive}
          displaySettings={displaySettings}
          isOnline={isOnline}
          onClose={() => setActivePanel(null)}
          onSetBaseLayer={setBaseLayer}
          onSetActive={setActiveId}
          onNewPolygon={newPolygon}
          onRenamePolygon={(id, name) => updatePolygons((current) => current.map((layer) => layer.id === id ? { ...layer, name } : layer))}
          onCycleColor={(id) => updatePolygons((current) => current.map((layer) => layer.id === id ? { ...layer, color: POLYGON_COLORS[(POLYGON_COLORS.indexOf(layer.color) + 1) % POLYGON_COLORS.length] } : layer))}
          onSetPolygonStyle={(id, appearance: Partial<PolygonAppearance>) => setPolygonsState((current) => current.map((layer) => layer.id === id ? { ...layer, ...appearance } : layer))}
          onSetPerformanceMode={setPerformanceMode}
          onSetDisplaySettings={setDisplaySettings}
          onClearAllData={clearAllData}
          onDeletePolygon={deletePolygon}
          onDuplicatePolygon={duplicatePolygon}
          onAddPoints={addPoints}
          onDeletePoint={(pointId) => mutateActive((layer) => ({ ...layer, points: layer.points.filter((point) => point.id !== pointId) }))}
          onClearPoints={() => mutateActive((layer) => ({ ...layer, points: [], desPoints: [] }))}
          onSetDesPoints={(polygonId, points) => updatePolygons((current) => current.map((layer) => layer.id === polygonId ? { ...layer, desPoints: points } : layer))}
          onImportLayers={importLayers}
          onFitActive={() => setFitRequest((value) => value + 1)}
          onFlyTo={(target) => setFlyTarget({ ...target })}
          onMessage={message}
        />
      )}

      <LiveTrackingCoordinatePanel
        active={activePanel === 'coordinates'}
        locationCardEnabled={displaySettings.locationCard}
        onEnsureLocationCard={() => setDisplaySettings((current) => current.locationCard ? current : { ...current, locationCard: true })}
        onConvertTrackToPolygon={convertTrackToPolygon}
        onMessage={message}
      />

      <nav className="bottom-dock" aria-label="Çalışma araçları">
        {dockItems.map((item) => {
          const Icon = item.icon
          return <button key={item.id} type="button" className={activePanel === item.id ? 'is-active' : ''} onClick={() => setActivePanel((current) => current === item.id ? null : item.id)}><Icon size={22} /><span>{item.label}</span></button>
        })}
      </nav>

      {toast && <div key={toast.id} className={`toast ${toast.tone}`}><span>{toast.message}</span><button type="button" onClick={() => setToast(null)} aria-label="Bildirimi kapat"><X size={14} /></button></div>}
    </div>
  )
}
