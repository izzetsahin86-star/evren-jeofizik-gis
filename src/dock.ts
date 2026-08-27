import {
  Ellipsis,
  FileInput,
  FileOutput,
  Layers2,
  MapPinned,
  Radio,
  SlidersHorizontal,
  Waypoints,
  type LucideIcon,
} from 'lucide-react'
import type { PanelId } from './types'

export type DockPanelId = PanelId | 'live'

export interface DockItem {
  id: DockPanelId
  label: string
  icon: LucideIcon
}

export const primaryDockItems: DockItem[] = [
  { id: 'layers', label: 'Katman', icon: Layers2 },
  { id: 'coordinates', label: 'Koordinat', icon: MapPinned },
  { id: 'live', label: 'Canlı', icon: Radio },
  { id: 'tools', label: 'Araçlar', icon: Waypoints },
]

export const secondaryDockItems: DockItem[] = [
  { id: 'import', label: 'İçe Aktar', icon: FileInput },
  { id: 'export', label: 'Dışa Aktar', icon: FileOutput },
  { id: 'settings', label: 'Ayarlar', icon: SlidersHorizontal },
]

export const MoreDockIcon = Ellipsis
