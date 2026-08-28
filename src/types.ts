export type CoordinateFormat = 'utm' | 'latlon' | 'dms' | 'ddm'
export type BaseLayerId = 'street' | 'satellite' | 'topographic'
export type PanelId = 'layers' | 'coordinates' | 'tools' | 'import' | 'export' | 'settings'
export type PerformanceMode = 'auto' | 'on' | 'off'

export interface DisplaySettings {
  coordinateCard: boolean
  areaCard: boolean
  mapActions: boolean
  measurementCard: boolean
  locationCard: boolean
  headerStats: boolean
  cardScale: number
}

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
  utmZone?: number
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

export interface ExportPolygonStyle {
  strokeWidth: number
  strokeColor: string
  fillOpacity: number
  fillColor: string
}

export interface AnalysisResult {
  areaM2: number
  perimeterM: number
  centroid: GeoPoint | null
  edgeLengths: number[]
  edgeBearings: number[]
}
