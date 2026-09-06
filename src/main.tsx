import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import 'leaflet/dist/leaflet.css'
import './styles.css'
import './field-points-unified.css'
import './document-coordinate-v2.css'
import './document-coordinate-compact.css'
import './ios-mobile-fixes.css'
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
import DESProfessionalFeature from './components/DESProfessionalFeature'
import DESCalibrationFeature from './components/DESCalibrationFeature'
import DESDualInversionFeature from './components/DESDualInversionFeature'
import DESReportMapsFeature from './components/DESReportMapsFeature'
import DESBatchActionsFeature from './components/DESBatchActionsFeature'
import DESAutoDimensionAdvisor from './components/DESAutoDimensionAdvisor'
import WorkCenterFeature from './components/WorkCenterFeature'

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
    <DESProfessionalFeature />
    <DESCalibrationFeature />
    <DESDualInversionFeature />
    <DESReportMapsFeature />
    <DESBatchActionsFeature />
    <DESAutoDimensionAdvisor />
    <WorkCenterFeature />
  </StrictMode>,
)

if ('serviceWorker' in navigator && import.meta.env.PROD) {
  let updateCheckRunning = false

  const getCurrentEntryAsset = () => {
    const scripts = Array.from(document.querySelectorAll<HTMLScriptElement>('script[type="module"][src]'))
    for (const script of scripts) {
      const pathname = new URL(script.src, window.location.href).pathname
      if (pathname.startsWith('/assets/')) return pathname
    }
    return null
  }

  const getEntryAssetFromHtml = (html: string) => {
    const scriptTags = html.match(/<script\b[^>]*>/gi) ?? []
    for (const tag of scriptTags) {
      if (!/\btype=["']module["']/i.test(tag)) continue
      const srcMatch = tag.match(/\bsrc=["']([^"']+)["']/i)
      if (!srcMatch) continue
      const pathname = new URL(srcMatch[1], window.location.href).pathname
      if (pathname.startsWith('/assets/')) return pathname
    }
    return null
  }

  const checkForWebUpdate = async () => {
    if (updateCheckRunning) return
    updateCheckRunning = true
    try {
      const response = await fetch(`/index.html?app-update=${Date.now()}`, { cache: 'no-store' })
      if (!response.ok) return
      const latestEntryAsset = getEntryAssetFromHtml(await response.text())
      const currentEntryAsset = getCurrentEntryAsset()
      if (latestEntryAsset && currentEntryAsset && latestEntryAsset !== currentEntryAsset) {
        window.location.reload()
      }
    } catch {
      // Offline or temporarily unreachable: keep the current installed app running.
    } finally {
      updateCheckRunning = false
    }
  }

  window.addEventListener('load', () => {
    navigator.serviceWorker
      .register('/sw.js', { updateViaCache: 'none' })
      .then((registration) => {
        const refresh = () => {
          registration.update().catch(() => undefined)
          void checkForWebUpdate()
        }

        refresh()
        window.addEventListener('focus', refresh)
        document.addEventListener('visibilitychange', () => {
          if (document.visibilityState === 'visible') refresh()
        })
        window.setInterval(refresh, 15 * 60 * 1000)
      })
      .catch(() => undefined)
  })
}
