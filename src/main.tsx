import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import 'leaflet/dist/leaflet.css'
import './styles.css'
import './field-points-layout.css'
import './field-points-unified.css'
import './address-search-position.css'
import './document-coordinate-v2.css'
import './document-coordinate-compact.css'
import App from './App'
import FieldPointsFeatureHost from './components/FieldPointsFeatureHost'
import FieldPointsTransferInlineFeature from './components/FieldPointsTransferInlineFeature'
import MapAddressSearchFeatureV2 from './components/MapAddressSearchFeatureV2'
import DocumentCoordinateFeatureV3 from './components/DocumentCoordinateFeatureV3'

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
    <FieldPointsFeatureHost />
    <FieldPointsTransferInlineFeature />
    <MapAddressSearchFeatureV2 />
    <DocumentCoordinateFeatureV3 />
  </StrictMode>,
)

if ('serviceWorker' in navigator && import.meta.env.PROD) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('/sw.js').catch(() => undefined)
  })
}
