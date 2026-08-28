const FIELD_POINTS_KEY = 'evren-jeofizik-gis-field-points-v1'
const MEDIA_DB_NAME = 'evren-jeofizik-gis-field-media-v1'
const MEDIA_STORE = 'photos'

export interface ReportFieldPoint {
  id: string
  name: string
  note: string
  description: string
  lat: number
  lng: number
  symbol: string
  photoId?: string
  createdAt: number
  updatedAt: number
}

export function readReportFieldPoints(): ReportFieldPoint[] {
  if (typeof window === 'undefined') return []
  try {
    const stored = JSON.parse(localStorage.getItem(FIELD_POINTS_KEY) || '[]') as Array<Partial<ReportFieldPoint>>
    if (!Array.isArray(stored)) return []
    return stored.flatMap((point, index) => {
      const lat = Number(point.lat)
      const lng = Number(point.lng)
      if (!Number.isFinite(lat) || !Number.isFinite(lng)) return []
      return [{
        id: typeof point.id === 'string' && point.id ? point.id : `field-${index}`,
        name: typeof point.name === 'string' && point.name.trim() ? point.name.trim() : `Saha Noktası ${index + 1}`,
        note: typeof point.note === 'string' ? point.note : '',
        description: typeof point.description === 'string' ? point.description : '',
        lat,
        lng,
        symbol: typeof point.symbol === 'string' ? point.symbol : 'pin',
        photoId: typeof point.photoId === 'string' && point.photoId ? point.photoId : undefined,
        createdAt: Number.isFinite(point.createdAt) ? Number(point.createdAt) : Date.now(),
        updatedAt: Number.isFinite(point.updatedAt) ? Number(point.updatedAt) : Date.now(),
      }]
    })
  } catch {
    return []
  }
}

function openMediaDb() {
  return new Promise<IDBDatabase>((resolve, reject) => {
    if (typeof window === 'undefined' || !('indexedDB' in window)) {
      reject(new Error('Fotoğraf deposu kullanılamıyor.'))
      return
    }
    const request = indexedDB.open(MEDIA_DB_NAME, 1)
    request.onsuccess = () => resolve(request.result)
    request.onerror = () => reject(request.error ?? new Error('Fotoğraf deposu açılamadı.'))
  })
}

export async function readReportFieldPhoto(photoId: string) {
  try {
    const db = await openMediaDb()
    const result = await new Promise<{ blob?: Blob } | undefined>((resolve, reject) => {
      const transaction = db.transaction(MEDIA_STORE, 'readonly')
      const request = transaction.objectStore(MEDIA_STORE).get(photoId)
      request.onsuccess = () => resolve(request.result as { blob?: Blob } | undefined)
      request.onerror = () => reject(request.error ?? new Error('Fotoğraf okunamadı.'))
    })
    db.close()
    return result?.blob ?? null
  } catch {
    return null
  }
}
