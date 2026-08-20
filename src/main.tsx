import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import 'leaflet/dist/leaflet.css'
import './styles.css'
import './field-points-layout.css'
import './field-points-unified.css'
import App from './App'
import FieldPointsFeatureHost from './components/FieldPointsFeatureHost'
import FieldPointsTransferInlineFeature from './components/FieldPointsTransferInlineFeature'
import MapAddressSearchFeature from './components/MapAddressSearchFeature'

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
    <FieldPointsFeatureHost />
    <FieldPointsTransferInlineFeature />
    <MapAddressSearchFeature />
  </StrictMode>,
)

if ('serviceWorker' in navigator && import.meta.env.PROD) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('/sw.js').catch(() => undefined)
  })
}
