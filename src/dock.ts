import { Download, Layers3, MapPin, Navigation, Settings2, Upload, Wrench, type LucideIcon } from 'lucide-react'
import type { PanelId } from './types'

export const dockItems: Array<{ id: PanelId; label: string; icon: LucideIcon }> = [
  { id: 'layers', label: 'Katmanlar', icon: Layers3 },
  { id: 'coordinates', label: 'Koordinat', icon: MapPin },
  { id: 'live', label: 'Canlı', icon: Navigation },
  { id: 'tools', label: 'Araçlar', icon: Wrench },
  { id: 'import', label: 'İçe Aktar', icon: Upload },
  { id: 'export', label: 'Dışa Aktar', icon: Download },
  { id: 'settings', label: 'Ayarla', icon: Settings2 },
]
