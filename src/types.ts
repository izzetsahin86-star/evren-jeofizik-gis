export type CoordinateFormat = 'utm' | 'latlon' | 'dms' | 'ddm'
export type BaseLayerId = 'street' | 'satellite' | 'topographic'
export type PanelId = 'layers' | 'coordinates' | 'tools' | 'import' | 'export'
export type PerformanceMode = 'auto' | 'on' | 'off'

export interface GeoPoint {
  id: string
  lat: number
  lng: number
  name?: string
}

export interface PolygonLayer {
  id: string
  name: string
  color: string
  strokeWidth?: number
  strokeOpacity?: number
  fillOpacity?: number
  points: GeoPoint[]
  desPoints: GeoPoint[]
}

export interface PolygonAppearance {
  color: string
  strokeWidth: number
  strokeOpacity: number
  fillOpacity: number
}

export interface SavedProject {
  id: string
  name: string
  savedAt: string
  polygons: PolygonLayer[]
}

export interface AnalysisResult {
  areaM2: number
  perimeterM: number
  centroid: GeoPoint | null
  edgeLengths: number[]
  edgeBearings: number[]
}
