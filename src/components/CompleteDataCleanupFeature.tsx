import { useEffect } from 'react'
import { sendLiveTrackCommand } from '../liveTrackingBridge'

const FIELD_POINTS_KEY = 'evren-jeofizik-gis-field-points-v1'
const TRACK_STORAGE_KEY = 'evren-jeofizik-gis-live-track-v1'
const LIVE_META_KEY = 'evren-jeofizik-gis-live-meta-v2'
const ROUTE_ARCHIVE_KEY = 'evren-jeofizik-gis-route-archive-v1'
const FIELD_MEDIA_DB = 'evren-jeofizik-gis-field-media-v1'
const FIELD_POINTS_CHANGED_EVENT = 'evren-field-points-changed'

function clearFieldMediaDatabase() {
  if (!('indexedDB' in window)) return
  try {
    const request = indexedDB.deleteDatabase(FIELD_MEDIA_DB)
    request.onerror = () => undefined
    request.onblocked = () => {
      window.setTimeout(() => {
        try {
          indexedDB.deleteDatabase(FIELD_MEDIA_DB)
        } catch {
          // Yerel fotoğraf deposu kilitliyse ana çalışma verileri yine temizlenir.
        }
      }, 250)
    }
  } catch {
    // IndexedDB kullanılamasa da diğer çalışma verilerinin temizlenmesi devam eder.
  }
}

function clearExtendedWorkData() {
  localStorage.removeItem(FIELD_POINTS_KEY)
  localStorage.removeItem(TRACK_STORAGE_KEY)
  localStorage.removeItem(LIVE_META_KEY)
  localStorage.removeItem(ROUTE_ARCHIVE_KEY)

  sendLiveTrackCommand('clear')
  window.dispatchEvent(new CustomEvent(FIELD_POINTS_CHANGED_EVENT))
  clearFieldMediaDatabase()
}

export default function CompleteDataCleanupFeature() {
  useEffect(() => {
    const onClick = (event: MouseEvent) => {
      const target = event.target
      if (!(target instanceof Element)) return
      const button = target.closest<HTMLButtonElement>('button.confirm-delete')
      if (!button || !button.closest('.danger-confirm')) return
      if (button.textContent?.trim() !== 'Evet, Kalıcı Sil') return
      clearExtendedWorkData()
    }

    document.addEventListener('click', onClick, true)
    return () => document.removeEventListener('click', onClick, true)
  }, [])

  return null
}
