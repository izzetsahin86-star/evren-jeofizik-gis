import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import 'leaflet/dist/leaflet.css'
import './styles.css'
import './field-points-unified.css'
import './document-coordinate-v2.css'
import './document-coordinate-compact.css'
import App from './App'
import AdminSearchAccessFeature from './components/AdminSearchAccessFeature'
import AdminDeviceHistoryFeature from './components/AdminDeviceHistoryFeature'
import CompleteDataCleanupFeature from './components/CompleteDataCleanupFeature'
import FieldPointsFeatureHost from './components/FieldPointsFeatureHost'
import FieldPointsTransferInlineFeature from './components/FieldPointsTransferInlineFeature'
import MapAddressSearchFeatureV2 from './components/MapAddressSearchFeatureV2'
import DocumentCoordinateFeatureV3 from './components/DocumentCoordinateFeatureV3'
import UndergroundModelFeature from './components/UndergroundModelFeature'
import UndergroundModelV2Feature from './components/UndergroundModelV2Feature'
import DESAnalysisFeature from './components/DESAnalysisFeature'

// Feature modules are mounted independently so existing GIS flows stay isolated.
createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
    <AdminSearchAccessFeature />
    <AdminDeviceHistoryFeature />
    <CompleteDataCleanupFeature />
    <FieldPointsFeatureHost />
    <FieldPointsTransferInlineFeature />
    <MapAddressSearchFeatureV2 />
    <DocumentCoordinateFeatureV3 />
    <UndergroundModelFeature />
    <UndergroundModelV2Feature />
    <DESAnalysisFeature />
  </StrictMode>,
)

if ('serviceWorker' in navigator && import.meta.env.PROD) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('/sw.js').catch(() => undefined)
  })
}
