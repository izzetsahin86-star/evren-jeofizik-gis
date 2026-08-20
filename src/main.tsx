import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import 'leaflet/dist/leaflet.css'
import './styles.css'
import './field-points-layout.css'
import './field-points-unified.css'
import './address-search-position.css'
import App from './App'
import FieldPointsFeatureHost from './components/FieldPointsFeatureHost'
import FieldPointsTransferInlineFeature from './components/FieldPointsTransferInlineFeature'
import MapAddressSearchFeatureV2 from './components/MapAddressSearchFeatureV2'

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
    <FieldPointsFeatureHost />
    <FieldPointsTransferInlineFeature />
    <MapAddressSearchFeatureV2 />
  </StrictMode>,
)

if ('serviceWorker' in navigator && import.meta.env.PROD) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('/sw.js').catch(() => undefined)
  })
}
