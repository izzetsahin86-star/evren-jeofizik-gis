import { useEffect, useMemo, useRef, useState } from 'react'
import {
  Expand,
  Hexagon,
  Move,
  Redo2,
  Trash2,
  Undo2,
  X,
} from 'lucide-react'
import BottomPanel from './components/BottomPanel'
import MapWorkspace from './components/MapWorkspace'
import { dockItems } from './dock'
import { POLYGON_COLORS, analyzePolygon, formatAreaShort, uid } from './geo'
import type { BaseLayerId, GeoPoint, PanelId, PolygonLayer, SavedProject } from './types'

const WORKSPACE_KEY = 'evren-jeofizik-gis-workspace-v1'
const PROJECTS_KEY = 'evren-jeofizik-gis-projects-v1'

function createPolygon(index = 0): PolygonLayer {
  return {
    id: uid('polygon'),
    name: `Poligon ${index + 1}`,
    color: POLYGON_COLORS[index % POLYGON_COLORS.length],
    points: [],
    desPoints: [],
  }
}

function readWorkspace() {
  try {
    const value = JSON.parse(localStorage.getItem(WORKSPACE_KEY) || 'null')
    if (Array.isArray(value) && value.length) return value as PolygonLayer[]
  } catch { /* Empty storage uses a fresh workspace. */ }
  return [createPolygon()]
}

function readProjects() {
  try {
    const value = JSON.parse(localStorage.getItem(PROJECTS_KEY) || '[]')
    return Array.isArray(value) ? value as SavedProject[] : []
  } catch { return [] }
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
  const [savedProjects, setSavedProjects] = useState<SavedProject[]>(readProjects)
  const [fitRequest, setFitRequest] = useState(0)
  const [flyTarget, setFlyTarget] = useState<{ lat: number; lng: number; zoom?: number } | null>(null)
  const [toast, setToast] = useState<{ id: string; message: string; tone: 'success' | 'error' | 'info' } | null>(null)
  const undoStack = useRef<PolygonLayer[][]>([])
  const redoStack = useRef<PolygonLayer[][]>([])

  const active = polygons.find((layer) => layer.id === activeId) ?? polygons[0]
  const totalPoints = polygons.reduce((sum, layer) => sum + layer.points.length, 0)
  const activeAnalysis = useMemo(() => analyzePolygon(active?.points ?? []), [active])

  useEffect(() => {
    localStorage.setItem(WORKSPACE_KEY, JSON.stringify(polygons))
  }, [polygons])

  useEffect(() => {
    localStorage.setItem(PROJECTS_KEY, JSON.stringify(savedProjects))
  }, [savedProjects])

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

  const addPoints = (points: Array<Omit<GeoPoint, 'id'>>) => {
    mutateActive((layer) => ({ ...layer, points: [...layer.points, ...points.map((point) => ({ ...point, id: uid('pt') }))] }))
    window.setTimeout(() => setFitRequest((value) => value + 1), 80)
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

  const saveProject = (name: string) => {
    setSavedProjects((current) => [{ id: uid('project'), name, savedAt: new Date().toISOString(), polygons: clonePolygons(polygons) }, ...current].slice(0, 20))
  }

  const loadProject = (project: SavedProject) => {
    updatePolygons(() => clonePolygons(project.polygons))
    setActiveId(project.polygons[0]?.id ?? '')
    window.setTimeout(() => setFitRequest((value) => value + 1), 80)
    message(`${project.name} yüklendi.`, 'success')
  }

  const resetWorkspace = () => {
    setActivePanel(null)
    setAddMode(false)
    setBaseLayer('street')
    setFitRequest((value) => value + 1)
    message('Çalışma düzeni sıfırlandı.', 'success')
  }

  return (
    <div className="app-shell">
      <header className="app-header">
        <div className="brand"><span><Hexagon size={19} /></span><strong>Evren Jeofizik</strong></div>
        <div className="header-actions">
          <span className="stat-pill violet">{polygons.length} pol</span>
          <span className="stat-pill blue">{totalPoints} pkt</span>
          {activeAnalysis.areaM2 > 0 && <span className="stat-pill green">{formatAreaShort(activeAnalysis.areaM2)}</span>}
          <i className="header-divider" />
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
      </div>

      <MapWorkspace
        polygons={polygons}
        activeId={activeId}
        baseLayer={baseLayer}
        addMode={addMode}
        panelOpen={Boolean(activePanel)}
        fitRequest={fitRequest}
        flyTarget={flyTarget}
        onToggleAddMode={() => setAddMode((value) => !value)}
        onAddPoint={(point) => addPoints([point])}
        onUpdatePoint={updatePoint}
        onLocate={(point) => setFlyTarget({ ...point, zoom: 17 })}
      />

      {activePanel && (
        <BottomPanel
          panel={activePanel}
          polygons={polygons}
          activeId={activeId}
          baseLayer={baseLayer}
          savedProjects={savedProjects}
          onClose={() => setActivePanel(null)}
          onSetBaseLayer={setBaseLayer}
          onSetActive={setActiveId}
          onNewPolygon={newPolygon}
          onRenamePolygon={(id, name) => updatePolygons((current) => current.map((layer) => layer.id === id ? { ...layer, name } : layer))}
          onCycleColor={(id) => updatePolygons((current) => current.map((layer) => layer.id === id ? { ...layer, color: POLYGON_COLORS[(POLYGON_COLORS.indexOf(layer.color) + 1) % POLYGON_COLORS.length] } : layer))}
          onDeletePolygon={deletePolygon}
          onDuplicatePolygon={duplicatePolygon}
          onAddPoints={addPoints}
          onDeletePoint={(pointId) => mutateActive((layer) => ({ ...layer, points: layer.points.filter((point) => point.id !== pointId) }))}
          onClearPoints={() => mutateActive((layer) => ({ ...layer, points: [], desPoints: [] }))}
          onSetDesPoints={(polygonId, points) => updatePolygons((current) => current.map((layer) => layer.id === polygonId ? { ...layer, desPoints: points } : layer))}
          onImportLayers={importLayers}
          onLoadProject={loadProject}
          onSaveProject={saveProject}
          onDeleteProject={(id) => setSavedProjects((current) => current.filter((project) => project.id !== id))}
          onFitActive={() => setFitRequest((value) => value + 1)}
          onFlyTo={(target) => setFlyTarget({ ...target })}
          onMessage={message}
        />
      )}

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
