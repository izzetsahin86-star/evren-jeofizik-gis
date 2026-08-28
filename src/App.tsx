import { useEffect, useMemo, useRef, useState } from 'react'
import { X } from 'lucide-react'
import BottomPanel from './components/BottomPanel'
import LiveLocationPanel from './components/LiveLocationPanel'
import MapWorkspace from './components/MapWorkspace'
import SmartDock from './components/SmartDock'
import SmartHeader from './components/SmartHeader'
import type { DockPanelId } from './dock'
import { DEFAULT_POLYGON_APPEARANCE, POLYGON_COLORS, analyzePolygon, formatAreaShort, uid } from './geo'
import type { BaseLayerId, DisplaySettings, GeoPoint, PerformanceMode, PolygonAppearance, PolygonLayer } from './types'

const WORKSPACE_KEY = 'evren-jeofizik-gis-workspace-v1'
const STANDALONE_POINTS_KEY = 'evren-jeofizik-gis-standalone-points-v1'
const LEGACY_PROJECTS_KEY = 'evren-jeofizik-gis-projects-v1'
const PERFORMANCE_KEY = 'evren-jeofizik-gis-performance-v1'
const DISPLAY_KEY = 'evren-jeofizik-gis-display-v2'
const LEGACY_DISPLAY_KEY = 'evren-jeofizik-gis-display-v1'
const MTA_INDEX_25_KEY = 'evren-jeofizik-gis-mta-index-25-v1'
const MTA_INDEX_100_KEY = 'evren-jeofizik-gis-mta-index-100-v1'
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

function readStandalonePoints(): GeoPoint[] {
  try {
    const value = JSON.parse(localStorage.getItem(STANDALONE_POINTS_KEY) || '[]') as Partial<GeoPoint>[]
    if (!Array.isArray(value)) return []
    return value
      .filter((point) => Number.isFinite(point.lat) && Number.isFinite(point.lng))
      .map((point, index) => ({
        id: typeof point.id === 'string' ? point.id : `standalone-${index}`,
        lat: Number(point.lat),
        lng: Number(point.lng),
        name: typeof point.name === 'string' ? point.name : undefined,
      }))
  } catch {
    return []
  }
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
  const [standalonePoints, setStandalonePoints] = useState<GeoPoint[]>(readStandalonePoints)
  const [activeId, setActiveId] = useState(() => polygons[0].id)
  const [baseLayer, setBaseLayer] = useState<BaseLayerId>('street')
  const [mtaIndex25Visible, setMtaIndex25Visible] = useState(() => localStorage.getItem(MTA_INDEX_25_KEY) === '1')
  const [mtaIndex100Visible, setMtaIndex100Visible] = useState(() => localStorage.getItem(MTA_INDEX_100_KEY) === '1')
  const [activePanel, setActivePanel] = useState<DockPanelId | null>(null)
  const [addMode, setAddMode] = useState(false)
  const [standaloneAddMode, setStandaloneAddMode] = useState(false)
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
  const polygonPointCount = polygons.reduce((sum, layer) => sum + layer.points.length, 0)
  const totalPoints = polygonPointCount + standalonePoints.length
  const totalDesPoints = polygons.reduce((sum, layer) => sum + layer.desPoints.length, 0)
  const performanceActive = performanceMode === 'on' || (performanceMode === 'auto' && (totalPoints > 350 || totalDesPoints > 1200))
  const activeAnalysis = useMemo(() => analyzePolygon(active?.points ?? []), [active])

  useEffect(() => {
    localStorage.setItem(WORKSPACE_KEY, JSON.stringify(polygons))
  }, [polygons])

  useEffect(() => {
    localStorage.setItem(STANDALONE_POINTS_KEY, JSON.stringify(standalonePoints))
  }, [standalonePoints])

  useEffect(() => {
    localStorage.setItem(PERFORMANCE_KEY, performanceMode)
  }, [performanceMode])

  useEffect(() => {
    localStorage.setItem(DISPLAY_KEY, JSON.stringify(displaySettings))
  }, [displaySettings])

  useEffect(() => {
    localStorage.setItem(MTA_INDEX_25_KEY, mtaIndex25Visible ? '1' : '0')
  }, [mtaIndex25Visible])

  useEffect(() => {
    localStorage.setItem(MTA_INDEX_100_KEY, mtaIndex100Visible ? '1' : '0')
  }, [mtaIndex100Visible])

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
    setStandaloneAddMode(false)
    setBaseLayer('street')
    setMtaIndex25Visible(false)
    setMtaIndex100Visible(false)
    setFitRequest((value) => value + 1)
    message('Çalışma düzeni sıfırlandı.', 'success')
  }

  const clearAllData = () => {
    const blank = createPolygon()
    localStorage.removeItem(WORKSPACE_KEY)
    localStorage.removeItem(STANDALONE_POINTS_KEY)
    localStorage.removeItem(LEGACY_PROJECTS_KEY)
    setPolygonsState([blank])
    setStandalonePoints([])
    setActiveId(blank.id)
    setAddMode(false)
    setStandaloneAddMode(false)
    setFlyTarget(null)
    undoStack.current = []
    redoStack.current = []
    setClearRequest((value) => value + 1)
    message('Tüm harita verileri silindi.', 'success')
  }

  return (
    <div className="app-shell">
      <SmartHeader
        showStats={displaySettings.headerStats}
        polygonCount={polygons.length}
        pointCount={totalPoints}
        areaLabel={activeAnalysis.areaM2 > 0 ? formatAreaShort(activeAnalysis.areaM2) : null}
        activeName={active?.name ?? 'Poligon'}
        activeColor={active?.color ?? '#1597e5'}
        activePointCount={active?.points.length ?? 0}
        isOnline={isOnline}
        performanceActive={performanceActive}
        canUndo={Boolean(undoStack.current.length)}
        canRedo={Boolean(redoStack.current.length)}
        onUndo={undo}
        onRedo={redo}
        onReset={resetWorkspace}
        onFit={() => setFitRequest((value) => value + 1)}
        onClearActive={() => mutateActive((layer) => ({ ...layer, points: [], desPoints: [] }))}
      />

      <MapWorkspace
        polygons={polygons}
        standalonePoints={standalonePoints}
        activeId={activeId}
        baseLayer={baseLayer}
        mtaIndex25Visible={mtaIndex25Visible}
        mtaIndex100Visible={mtaIndex100Visible}
        addMode={addMode}
        standaloneAddMode={standaloneAddMode}
        panelOpen={Boolean(activePanel)}
        performanceMode={performanceActive}
        displaySettings={displaySettings}
        clearRequest={clearRequest}
        fitRequest={fitRequest}
        flyTarget={flyTarget}
        onToggleAddMode={() => {
          setStandaloneAddMode(false)
          setAddMode((value) => !value)
        }}
        onToggleStandaloneAddMode={() => {
          setAddMode(false)
          setStandaloneAddMode((value) => !value)
        }}
        onAddPoint={(point) => addPoints([point], false)}
        onAddStandalonePoint={(point) => setStandalonePoints((current) => [...current, { ...point, id: uid('standalone') }])}
        onDeleteStandalonePoint={(pointId) => setStandalonePoints((current) => current.filter((point) => point.id !== pointId))}
        onUpdatePoint={updatePoint}
        onLocate={(point) => setFlyTarget({ ...point, zoom: 17 })}
        onMessage={message}
      />

      {activePanel && activePanel !== 'live' && (
        <BottomPanel
          panel={activePanel}
          polygons={polygons}
          activeId={activeId}
          baseLayer={baseLayer}
          mtaIndex25Visible={mtaIndex25Visible}
          mtaIndex100Visible={mtaIndex100Visible}
          performanceMode={performanceMode}
          performanceActive={performanceActive}
          displaySettings={displaySettings}
          isOnline={isOnline}
          onClose={() => setActivePanel(null)}
          onSetBaseLayer={setBaseLayer}
          onSetMtaIndex25Visible={setMtaIndex25Visible}
          onSetMtaIndex100Visible={setMtaIndex100Visible}
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
          onUpdatePoint={updatePoint}
          onDeletePoint={(pointId) => mutateActive((layer) => ({ ...layer, points: layer.points.filter((point) => point.id !== pointId) }))}
          onClearPoints={() => mutateActive((layer) => ({ ...layer, points: [], desPoints: [] }))}
          onSetDesPoints={(polygonId, points) => updatePolygons((current) => current.map((layer) => layer.id === polygonId ? { ...layer, desPoints: points } : layer))}
          onImportLayers={importLayers}
          onFitActive={() => setFitRequest((value) => value + 1)}
          onFlyTo={(target) => setFlyTarget({ ...target })}
          onMessage={message}
        />
      )}

      <LiveLocationPanel
        active={activePanel === 'live'}
        polygons={polygons}
        locationCardEnabled={displaySettings.locationCard}
        onEnsureLocationCard={() => setDisplaySettings((current) => current.locationCard ? current : { ...current, locationCard: true })}
        onClose={() => setActivePanel(null)}
        onFlyTo={(target) => setFlyTarget({ ...target })}
        onConvertTrackToPolygon={convertTrackToPolygon}
        onMessage={message}
      />

      <SmartDock activePanel={activePanel} onSelect={(panel) => setActivePanel((current) => current === panel ? null : panel)} />

      {toast && <div key={toast.id} className={`smart-toast ${toast.tone}`}><span>{toast.message}</span><button type="button" onClick={() => setToast(null)} aria-label="Bildirimi kapat"><X size={14} /></button></div>}
    </div>
  )
}
