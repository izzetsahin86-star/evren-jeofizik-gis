import { useEffect, useMemo, useRef, useState, type ChangeEvent } from 'react'
import { createPortal } from 'react-dom'
import L, { type Map as LeafletMap, type Marker as LeafletMarker } from 'leaflet'
import {
  Camera,
  Crosshair,
  Edit3,
  LocateFixed,
  MapPinned,
  Navigation,
  Plus,
  Save,
  Trash2,
  X,
} from 'lucide-react'

const FIELD_POINTS_KEY = 'evren-jeofizik-gis-field-points-v1'
const MEDIA_DB_NAME = 'evren-jeofizik-gis-field-media-v1'
const MEDIA_STORE = 'photos'
const MAP_READY_EVENT = 'evren-field-map-ready'
const MAX_PHOTO_INPUT = 12 * 1024 * 1024
const MAX_PHOTO_EDGE = 1280

export type FieldPointSymbol = 'pin' | 'flag' | 'camera' | 'warning' | 'sample' | 'target' | 'note' | 'vehicle'

type FieldPoint = {
  id: string
  name: string
  note: string
  description: string
  lat: number
  lng: number
  symbol: FieldPointSymbol
  photoId?: string
  createdAt: number
  updatedAt: number
}

type FormState = {
  name: string
  note: string
  description: string
  lat: string
  lng: string
  symbol: FieldPointSymbol
}

const SYMBOLS: Array<{ id: FieldPointSymbol; icon: string; label: string; tone: string }> = [
  { id: 'pin', icon: '📍', label: 'Konum', tone: '#2563eb' },
  { id: 'flag', icon: '🚩', label: 'Bayrak', tone: '#dc2626' },
  { id: 'camera', icon: '📷', label: 'Fotoğraf', tone: '#7c3aed' },
  { id: 'warning', icon: '⚠️', label: 'Uyarı', tone: '#d97706' },
  { id: 'sample', icon: '🧪', label: 'Numune', tone: '#059669' },
  { id: 'target', icon: '🎯', label: 'Hedef', tone: '#db2777' },
  { id: 'note', icon: '📝', label: 'Not', tone: '#475569' },
  { id: 'vehicle', icon: '🚙', label: 'Araç', tone: '#0f766e' },
]

const EMPTY_FORM: FormState = {
  name: '',
  note: '',
  description: '',
  lat: '',
  lng: '',
  symbol: 'pin',
}

let capturedMap: LeafletMap | null = null
let mapHookInstalled = false

function installMapCaptureHook() {
  if (mapHookInstalled) return
  mapHookInstalled = true
  L.Map.addInitHook(function captureEvrenMap(this: LeafletMap) {
    capturedMap = this
    window.dispatchEvent(new CustomEvent(MAP_READY_EVENT))
    this.once('unload', () => {
      if (capturedMap === this) capturedMap = null
    })
  })
}

installMapCaptureHook()

function uid(prefix = 'field') {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
}

function symbolInfo(symbol: FieldPointSymbol) {
  return SYMBOLS.find((item) => item.id === symbol) ?? SYMBOLS[0]
}

function normalizePoint(value: Partial<FieldPoint>, index: number): FieldPoint | null {
  const lat = Number(value.lat)
  const lng = Number(value.lng)
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) return null
  const symbol = SYMBOLS.some((item) => item.id === value.symbol) ? value.symbol as FieldPointSymbol : 'pin'
  return {
    id: typeof value.id === 'string' && value.id ? value.id : uid(`field-${index}`),
    name: typeof value.name === 'string' && value.name.trim() ? value.name : `Saha Noktası ${index + 1}`,
    note: typeof value.note === 'string' ? value.note : '',
    description: typeof value.description === 'string' ? value.description : '',
    lat,
    lng,
    symbol,
    photoId: typeof value.photoId === 'string' && value.photoId ? value.photoId : undefined,
    createdAt: typeof value.createdAt === 'number' ? value.createdAt : Date.now(),
    updatedAt: typeof value.updatedAt === 'number' ? value.updatedAt : Date.now(),
  }
}

function readPoints(): FieldPoint[] {
  try {
    const value = JSON.parse(localStorage.getItem(FIELD_POINTS_KEY) || '[]') as Partial<FieldPoint>[]
    if (!Array.isArray(value)) return []
    return value.map(normalizePoint).filter((point): point is FieldPoint => Boolean(point))
  } catch {
    return []
  }
}

function writePoints(points: FieldPoint[]) {
  localStorage.setItem(FIELD_POINTS_KEY, JSON.stringify(points))
}

function openMediaDb() {
  return new Promise<IDBDatabase>((resolve, reject) => {
    if (!('indexedDB' in window)) {
      reject(new Error('Bu tarayıcı fotoğraf depolamayı desteklemiyor.'))
      return
    }
    const request = indexedDB.open(MEDIA_DB_NAME, 1)
    request.onupgradeneeded = () => {
      const db = request.result
      if (!db.objectStoreNames.contains(MEDIA_STORE)) db.createObjectStore(MEDIA_STORE, { keyPath: 'id' })
    }
    request.onsuccess = () => resolve(request.result)
    request.onerror = () => reject(request.error ?? new Error('Fotoğraf deposu açılamadı.'))
  })
}

async function savePhoto(id: string, blob: Blob) {
  const db = await openMediaDb()
  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction(MEDIA_STORE, 'readwrite')
    tx.objectStore(MEDIA_STORE).put({ id, blob, updatedAt: Date.now() })
    tx.oncomplete = () => resolve()
    tx.onerror = () => reject(tx.error ?? new Error('Fotoğraf kaydedilemedi.'))
  })
  db.close()
}

async function getPhoto(id: string) {
  const db = await openMediaDb()
  const result = await new Promise<{ id: string; blob: Blob } | undefined>((resolve, reject) => {
    const tx = db.transaction(MEDIA_STORE, 'readonly')
    const request = tx.objectStore(MEDIA_STORE).get(id)
    request.onsuccess = () => resolve(request.result as { id: string; blob: Blob } | undefined)
    request.onerror = () => reject(request.error ?? new Error('Fotoğraf okunamadı.'))
  })
  db.close()
  return result?.blob ?? null
}

async function deletePhoto(id: string) {
  try {
    const db = await openMediaDb()
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(MEDIA_STORE, 'readwrite')
      tx.objectStore(MEDIA_STORE).delete(id)
      tx.oncomplete = () => resolve()
      tx.onerror = () => reject(tx.error ?? new Error('Fotoğraf silinemedi.'))
    })
    db.close()
  } catch {
    // Fotoğraf deposu kullanılamasa da saha noktası silme işlemi devam eder.
  }
}

async function compressPhoto(file: File) {
  if (!file.type.startsWith('image/')) throw new Error('Lütfen bir fotoğraf dosyası seçin.')
  if (file.size > MAX_PHOTO_INPUT) throw new Error('Fotoğraf 12 MB sınırını aşıyor.')

  const objectUrl = URL.createObjectURL(file)
  try {
    const image = await new Promise<HTMLImageElement>((resolve, reject) => {
      const img = new Image()
      img.onload = () => resolve(img)
      img.onerror = () => reject(new Error('Fotoğraf okunamadı.'))
      img.src = objectUrl
    })
    const scale = Math.min(1, MAX_PHOTO_EDGE / Math.max(image.naturalWidth, image.naturalHeight))
    const width = Math.max(1, Math.round(image.naturalWidth * scale))
    const height = Math.max(1, Math.round(image.naturalHeight * scale))
    const canvas = document.createElement('canvas')
    canvas.width = width
    canvas.height = height
    const context = canvas.getContext('2d')
    if (!context) throw new Error('Fotoğraf işlenemedi.')
    context.drawImage(image, 0, 0, width, height)
    return await new Promise<Blob>((resolve, reject) => {
      canvas.toBlob((blob) => blob ? resolve(blob) : reject(new Error('Fotoğraf sıkıştırılamadı.')), 'image/jpeg', 0.76)
    })
  } finally {
    URL.revokeObjectURL(objectUrl)
  }
}

function escapeHtml(value: string) {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#039;')
}

function popupHtml(point: FieldPoint, photoUrl?: string) {
  const symbol = symbolInfo(point.symbol)
  const note = point.note.trim() ? `<div style="margin-top:6px;font-weight:700;color:#334155">${escapeHtml(point.note)}</div>` : ''
  const description = point.description.trim() ? `<div style="margin-top:6px;color:#64748b;white-space:pre-wrap">${escapeHtml(point.description)}</div>` : ''
  const photo = photoUrl ? `<img src="${photoUrl}" alt="" style="display:block;width:100%;max-width:280px;max-height:190px;object-fit:cover;border-radius:10px;margin-top:9px" />` : ''
  return `<div style="min-width:190px;max-width:290px;font-family:Inter,system-ui,sans-serif"><div style="display:flex;align-items:center;gap:8px"><span style="font-size:22px">${symbol.icon}</span><strong style="font-size:14px;color:#172033">${escapeHtml(point.name)}</strong></div>${note}${description}${photo}<div style="margin-top:8px;color:#94a3b8;font-size:10px">${point.lat.toFixed(6)}, ${point.lng.toFixed(6)}</div></div>`
}

function markerIcon(symbol: FieldPointSymbol) {
  const item = symbolInfo(symbol)
  return L.divIcon({
    className: 'field-point-marker-wrap',
    html: `<span style="width:34px;height:34px;display:grid;place-items:center;border:3px solid white;border-radius:50% 50% 50% 10%;transform:rotate(-45deg);background:${item.tone};box-shadow:0 5px 14px rgba(15,23,42,.3)"><span style="font-size:16px;transform:rotate(45deg);line-height:1">${item.icon}</span></span>`,
    iconSize: [38, 42],
    iconAnchor: [19, 39],
    popupAnchor: [0, -35],
    tooltipAnchor: [0, -30],
  })
}

function formatDate(timestamp: number) {
  try {
    return new Date(timestamp).toLocaleString('tr-TR', { day: '2-digit', month: '2-digit', year: '2-digit', hour: '2-digit', minute: '2-digit' })
  } catch {
    return '—'
  }
}

export default function FieldPointsFeature() {
  const [points, setPoints] = useState<FieldPoint[]>(readPoints)
  const [open, setOpen] = useState(false)
  const [dockHost, setDockHost] = useState<HTMLElement | null>(null)
  const [map, setMap] = useState<LeafletMap | null>(() => capturedMap)
  const [form, setForm] = useState<FormState>(EMPTY_FORM)
  const [editingId, setEditingId] = useState<string | null>(null)
  const [photoBlob, setPhotoBlob] = useState<Blob | null>(null)
  const [previewUrl, setPreviewUrl] = useState<string | null>(null)
  const [removeExistingPhoto, setRemoveExistingPhoto] = useState(false)
  const [busy, setBusy] = useState(false)
  const [status, setStatus] = useState<{ text: string; tone: 'success' | 'error' | 'info' } | null>(null)
  const layerRef = useRef<L.LayerGroup | null>(null)
  const popupUrlsRef = useRef<Map<string, string>>(new Map())
  const currentEditingPoint = useMemo(() => points.find((point) => point.id === editingId) ?? null, [points, editingId])

  useEffect(() => {
    const discover = () => setDockHost(document.querySelector<HTMLElement>('.bottom-dock'))
    discover()
    const observer = new MutationObserver(discover)
    observer.observe(document.body, { childList: true, subtree: true })
    return () => observer.disconnect()
  }, [])

  useEffect(() => {
    const onMapReady = () => setMap(capturedMap)
    window.addEventListener(MAP_READY_EVENT, onMapReady)
    if (capturedMap) setMap(capturedMap)
    return () => window.removeEventListener(MAP_READY_EVENT, onMapReady)
  }, [])

  useEffect(() => {
    const onDocumentClick = (event: MouseEvent) => {
      const target = event.target as Element | null
      const dockButton = target?.closest('.bottom-dock button')
      if (dockButton && !dockButton.hasAttribute('data-field-points-button')) setOpen(false)
    }
    document.addEventListener('click', onDocumentClick, true)
    return () => document.removeEventListener('click', onDocumentClick, true)
  }, [])

  useEffect(() => {
    if (!status) return
    const timer = window.setTimeout(() => setStatus(null), 3200)
    return () => window.clearTimeout(timer)
  }, [status])

  useEffect(() => () => {
    if (previewUrl) URL.revokeObjectURL(previewUrl)
  }, [previewUrl])

  useEffect(() => {
    if (!map) return
    const layer = L.layerGroup().addTo(map)
    layerRef.current = layer
    return () => {
      layer.remove()
      layerRef.current = null
    }
  }, [map])

  useEffect(() => {
    const layer = layerRef.current
    if (!layer) return
    layer.clearLayers()

    points.forEach((point) => {
      const marker: LeafletMarker = L.marker([point.lat, point.lng], {
        icon: markerIcon(point.symbol),
        draggable: true,
        keyboard: true,
        title: point.name,
      })
      marker.bindTooltip(point.name, { direction: 'top', offset: [0, -28] })
      marker.bindPopup(popupHtml(point), { maxWidth: 310 })
      marker.on('click', async () => {
        const oldUrl = popupUrlsRef.current.get(point.id)
        if (oldUrl) {
          URL.revokeObjectURL(oldUrl)
          popupUrlsRef.current.delete(point.id)
        }
        if (!point.photoId) return
        try {
          const blob = await getPhoto(point.photoId)
          if (!blob) return
          const url = URL.createObjectURL(blob)
          popupUrlsRef.current.set(point.id, url)
          marker.setPopupContent(popupHtml(point, url))
        } catch {
          // Fotoğraf okunamazsa metin bilgileri gösterilmeye devam eder.
        }
      })
      marker.on('dragend', () => {
        const location = marker.getLatLng()
        setPoints((current) => {
          const next = current.map((item) => item.id === point.id ? { ...item, lat: location.lat, lng: location.lng, updatedAt: Date.now() } : item)
          writePoints(next)
          return next
        })
        setStatus({ text: `${point.name} yeni konuma taşındı.`, tone: 'success' })
      })
      marker.addTo(layer)
    })

    return () => {
      popupUrlsRef.current.forEach((url) => URL.revokeObjectURL(url))
      popupUrlsRef.current.clear()
    }
  }, [points, map])

  const resetForm = () => {
    setEditingId(null)
    setForm(EMPTY_FORM)
    setPhotoBlob(null)
    setRemoveExistingPhoto(false)
    setPreviewUrl((current) => {
      if (current) URL.revokeObjectURL(current)
      return null
    })
  }

  const useMapCenter = () => {
    if (!map) {
      setStatus({ text: 'Harita henüz hazır değil.', tone: 'error' })
      return
    }
    const center = map.getCenter()
    setForm((current) => ({ ...current, lat: center.lat.toFixed(7), lng: center.lng.toFixed(7) }))
    setStatus({ text: 'Harita merkezindeki koordinat alındı.', tone: 'success' })
  }

  const useCurrentLocation = () => {
    if (!navigator.geolocation) {
      setStatus({ text: 'Bu cihaz konum hizmetini desteklemiyor.', tone: 'error' })
      return
    }
    setBusy(true)
    navigator.geolocation.getCurrentPosition((position) => {
      const lat = position.coords.latitude
      const lng = position.coords.longitude
      setForm((current) => ({ ...current, lat: lat.toFixed(7), lng: lng.toFixed(7) }))
      map?.flyTo([lat, lng], Math.max(17, map.getZoom()), { duration: 0.7 })
      setBusy(false)
      setStatus({ text: `Konum alındı · ±${Math.round(position.coords.accuracy)} m`, tone: 'success' })
    }, () => {
      setBusy(false)
      setStatus({ text: 'Konum alınamadı. Konum iznini kontrol edin.', tone: 'error' })
    }, { enableHighAccuracy: true, timeout: 15000, maximumAge: 3000 })
  }

  const onPhotoSelect = async (event: ChangeEvent<HTMLInputElement>) => {
    const input = event.target
    const file = input.files?.[0]
    if (!file) return
    setBusy(true)
    try {
      const blob = await compressPhoto(file)
      setPhotoBlob(blob)
      setRemoveExistingPhoto(false)
      setPreviewUrl((current) => {
        if (current) URL.revokeObjectURL(current)
        return URL.createObjectURL(blob)
      })
      setStatus({ text: 'Fotoğraf hazırlandı.', tone: 'success' })
    } catch (error) {
      setStatus({ text: error instanceof Error ? error.message : 'Fotoğraf hazırlanamadı.', tone: 'error' })
    } finally {
      setBusy(false)
      input.value = ''
    }
  }

  const editPoint = async (point: FieldPoint) => {
    setEditingId(point.id)
    setForm({
      name: point.name,
      note: point.note,
      description: point.description,
      lat: point.lat.toFixed(7),
      lng: point.lng.toFixed(7),
      symbol: point.symbol,
    })
    setPhotoBlob(null)
    setRemoveExistingPhoto(false)
    setPreviewUrl((current) => {
      if (current) URL.revokeObjectURL(current)
      return null
    })
    if (point.photoId) {
      try {
        const blob = await getPhoto(point.photoId)
        if (blob) setPreviewUrl(URL.createObjectURL(blob))
      } catch {
        // Fotoğraf önizlemesi açılamazsa diğer bilgiler düzenlenebilir.
      }
    }
  }

  const savePoint = async () => {
    const lat = Number(form.lat.replace(',', '.'))
    const lng = Number(form.lng.replace(',', '.'))
    if (!Number.isFinite(lat) || !Number.isFinite(lng) || lat < -90 || lat > 90 || lng < -180 || lng > 180) {
      setStatus({ text: 'Geçerli enlem ve boylam girin.', tone: 'error' })
      return
    }
    const now = Date.now()
    const id = editingId ?? uid('field')
    const existing = points.find((point) => point.id === editingId)
    const name = form.name.trim() || `Saha Noktası ${editingId ? Math.max(1, points.findIndex((point) => point.id === editingId) + 1) : points.length + 1}`
    let photoId = existing?.photoId

    setBusy(true)
    try {
      if (removeExistingPhoto && photoId) {
        await deletePhoto(photoId)
        photoId = undefined
      }
      if (photoBlob) {
        photoId = id
        await savePhoto(photoId, photoBlob)
      }

      const nextPoint: FieldPoint = {
        id,
        name,
        note: form.note.trim(),
        description: form.description.trim(),
        lat,
        lng,
        symbol: form.symbol,
        photoId,
        createdAt: existing?.createdAt ?? now,
        updatedAt: now,
      }
      const next = editingId
        ? points.map((point) => point.id === editingId ? nextPoint : point)
        : [...points, nextPoint]
      writePoints(next)
      setPoints(next)
      map?.flyTo([lat, lng], Math.max(16, map.getZoom()), { duration: 0.7 })
      setStatus({ text: editingId ? 'Saha noktası güncellendi.' : 'Saha noktası kaydedildi.', tone: 'success' })
      resetForm()
    } catch (error) {
      setStatus({ text: error instanceof Error ? error.message : 'Saha noktası kaydedilemedi.', tone: 'error' })
    } finally {
      setBusy(false)
    }
  }

  const removePoint = async (point: FieldPoint) => {
    const next = points.filter((item) => item.id !== point.id)
    writePoints(next)
    setPoints(next)
    if (point.photoId) await deletePhoto(point.photoId)
    if (editingId === point.id) resetForm()
    setStatus({ text: `${point.name} silindi.`, tone: 'success' })
  }

  const clearAllPoints = async () => {
    const current = [...points]
    writePoints([])
    setPoints([])
    resetForm()
    await Promise.all(current.filter((point) => point.photoId).map((point) => deletePhoto(point.photoId!)))
    setStatus({ text: 'Tüm saha noktaları silindi.', tone: 'success' })
  }

  const showPoint = (point: FieldPoint) => {
    map?.flyTo([point.lat, point.lng], Math.max(17, map.getZoom()), { duration: 0.7 })
  }

  const togglePanel = () => {
    if (!open) {
      const active = dockHost?.querySelector<HTMLButtonElement>('button.is-active:not([data-field-points-button])')
      active?.click()
      if (!form.lat && map) {
        const center = map.getCenter()
        setForm((current) => ({ ...current, lat: center.lat.toFixed(7), lng: center.lng.toFixed(7) }))
      }
    }
    setOpen((value) => !value)
  }

  const dockButton = dockHost ? createPortal(
    <button
      type="button"
      data-field-points-button="true"
      className={open ? 'is-active' : ''}
      onClick={togglePanel}
      aria-label="Saha noktaları"
      title="Saha noktaları"
    >
      <MapPinned size={22} />
      <span>Saha</span>
    </button>,
    dockHost,
  ) : null

  const panel = open ? createPortal(
    <>
      <style>{`
        .field-points-panel{position:fixed;z-index:1300;left:50%;bottom:76px;transform:translateX(-50%);width:min(980px,calc(100vw - 24px));max-height:min(72vh,720px);display:flex;flex-direction:column;overflow:hidden;border:1px solid #dbe5ef;border-radius:20px;background:#fff;box-shadow:0 20px 60px rgba(15,23,42,.24);font-family:Inter,system-ui,sans-serif;color:#172033}
        .field-points-head{display:flex;align-items:center;justify-content:space-between;gap:12px;padding:13px 15px;border-bottom:1px solid #e8eef5;background:linear-gradient(135deg,#eef7ff,#f8fbff)}
        .field-points-title{display:flex;align-items:center;gap:10px;min-width:0}.field-points-title>span{width:36px;height:36px;display:grid;place-items:center;border-radius:11px;background:#dbeafe;color:#2563eb}.field-points-title div{display:grid}.field-points-title strong{font-size:13px}.field-points-title small{font-size:9px;color:#7c8ba0}.field-points-head-actions{display:flex;align-items:center;gap:7px}.field-points-count{padding:5px 8px;border-radius:999px;background:#e0f2fe;color:#0369a1;font-size:9px;font-weight:800}.field-points-close{width:32px;height:32px;display:grid;place-items:center;border:0;border-radius:10px;background:#eef2f6;color:#64748b;cursor:pointer}
        .field-points-body{display:grid;grid-template-columns:minmax(310px,.95fr) minmax(360px,1.3fr);gap:12px;overflow:auto;padding:12px;background:#f8fafc}
        .field-card{min-width:0;border:1px solid #e4eaf1;border-radius:15px;background:#fff;box-shadow:0 2px 7px rgba(15,23,42,.035);overflow:hidden}.field-card>header{display:flex;align-items:center;justify-content:space-between;gap:8px;padding:10px 11px;border-bottom:1px solid #edf1f5}.field-card>header strong{font-size:11px}.field-card>header small{font-size:8px;color:#94a3b8}.field-card-body{display:grid;gap:9px;padding:11px}
        .field-grid{display:grid;grid-template-columns:1fr 1fr;gap:8px}.field-input{display:grid;gap:4px}.field-input>span{font-size:8px;font-weight:800;color:#64748b}.field-input input,.field-input textarea{width:100%;box-sizing:border-box;border:1px solid #dce4ed;border-radius:9px;background:#fff;color:#172033;font:inherit;font-size:10px;padding:8px 9px;outline:none}.field-input input:focus,.field-input textarea:focus{border-color:#60a5fa;box-shadow:0 0 0 3px rgba(59,130,246,.1)}.field-input textarea{min-height:64px;resize:vertical}
        .field-location-actions{display:grid;grid-template-columns:1fr 1fr;gap:7px}.field-location-actions button,.field-primary,.field-secondary,.field-danger{height:34px;display:flex;align-items:center;justify-content:center;gap:6px;border:0;border-radius:9px;font-size:9px;font-weight:800;cursor:pointer}.field-location-actions button{background:#eef5ff;color:#2563eb}.field-primary{background:#2563eb;color:#fff}.field-secondary{background:#eef2f6;color:#526174}.field-danger{background:#fff1f2;color:#be123c}.field-primary:disabled,.field-secondary:disabled,.field-danger:disabled,.field-location-actions button:disabled{opacity:.45;cursor:not-allowed}
        .field-symbols{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:6px}.field-symbol{min-width:0;padding:7px 4px;border:1px solid #e2e8f0;border-radius:9px;background:#fff;color:#475569;cursor:pointer;text-align:center}.field-symbol.is-active{border-color:#60a5fa;background:#eff6ff;color:#1d4ed8;box-shadow:0 0 0 2px rgba(59,130,246,.08)}.field-symbol b{display:block;font-size:17px;line-height:1}.field-symbol small{display:block;margin-top:4px;overflow:hidden;font-size:7px;font-weight:800;white-space:nowrap;text-overflow:ellipsis}
        .field-photo{display:grid;grid-template-columns:96px 1fr;gap:9px;align-items:center}.field-photo-preview{height:76px;display:grid;place-items:center;overflow:hidden;border:1px dashed #cbd5e1;border-radius:10px;background:#f8fafc;color:#94a3b8}.field-photo-preview img{width:100%;height:100%;object-fit:cover}.field-photo-actions{display:grid;gap:6px}.field-photo-actions label{height:31px;display:flex;align-items:center;justify-content:center;gap:6px;border-radius:9px;background:#f1f5f9;color:#475569;font-size:8px;font-weight:800;cursor:pointer}.field-photo-actions input{display:none}
        .field-form-actions{display:grid;grid-template-columns:1fr 1fr;gap:7px}.field-status{padding:7px 9px;border-radius:9px;font-size:8px;font-weight:700}.field-status.success{background:#ecfdf5;color:#047857}.field-status.error{background:#fff1f2;color:#be123c}.field-status.info{background:#eff6ff;color:#1d4ed8}
        .field-list{display:grid;gap:7px}.field-empty{padding:26px 12px;text-align:center;color:#94a3b8}.field-empty svg{display:block;margin:0 auto 8px}.field-empty strong{display:block;color:#64748b;font-size:10px}.field-empty small{font-size:8px}.field-row{display:grid;grid-template-columns:auto minmax(0,1fr) auto;align-items:center;gap:9px;padding:8px;border:1px solid #edf1f5;border-radius:11px;background:#fff}.field-row-symbol{width:34px;height:34px;display:grid;place-items:center;border-radius:10px;background:#f8fafc;font-size:18px}.field-row-main{min-width:0;cursor:pointer}.field-row-main strong{display:block;overflow:hidden;font-size:10px;white-space:nowrap;text-overflow:ellipsis}.field-row-main small{display:block;margin-top:2px;overflow:hidden;color:#94a3b8;font-size:7.5px;white-space:nowrap;text-overflow:ellipsis}.field-row-actions{display:flex;gap:4px}.field-row-actions button{width:29px;height:29px;display:grid;place-items:center;border:0;border-radius:8px;background:#f1f5f9;color:#64748b;cursor:pointer}.field-row-actions button:hover{background:#e2e8f0}.field-row-actions button:last-child{background:#fff1f2;color:#be123c}
        .field-list-footer{display:flex;justify-content:flex-end;padding-top:2px}.field-list-footer button{height:30px;padding:0 10px;border:0;border-radius:8px;background:#fff1f2;color:#be123c;font-size:8px;font-weight:800;cursor:pointer}
        @media(max-width:760px){.field-points-panel{bottom:70px;max-height:76vh;width:calc(100vw - 12px);border-radius:16px}.field-points-body{grid-template-columns:1fr;padding:8px}.field-grid{grid-template-columns:1fr}.field-symbols{grid-template-columns:repeat(4,minmax(0,1fr))}.field-photo{grid-template-columns:82px 1fr}}
      `}</style>
      <aside className="field-points-panel" aria-label="Saha noktaları paneli">
        <header className="field-points-head">
          <div className="field-points-title"><span><MapPinned size={20} /></span><div><strong>Saha Noktaları</strong><small>Waypoint · not · açıklama · fotoğraf · sembol</small></div></div>
          <div className="field-points-head-actions"><span className="field-points-count">{points.length} nokta</span><button className="field-points-close" type="button" onClick={() => setOpen(false)} aria-label="Kapat"><X size={17} /></button></div>
        </header>
        <div className="field-points-body">
          <section className="field-card">
            <header><strong>{editingId ? 'Saha Noktasını Düzenle' : 'Yeni Saha Noktası'}</strong><small>{editingId ? 'Mevcut waypoint' : 'Yeni waypoint oluştur'}</small></header>
            <div className="field-card-body">
              <div className="field-input"><span>Nokta Adı</span><input value={form.name} onChange={(event) => setForm((current) => ({ ...current, name: event.target.value }))} placeholder={`Saha Noktası ${points.length + 1}`} /></div>
              <div className="field-input"><span>Kısa Not</span><input value={form.note} onChange={(event) => setForm((current) => ({ ...current, note: event.target.value }))} placeholder="Örn. DES başlangıç noktası" /></div>
              <div className="field-input"><span>Açıklama</span><textarea value={form.description} onChange={(event) => setForm((current) => ({ ...current, description: event.target.value }))} placeholder="Saha gözlemleri, erişim bilgisi, zemin durumu..." /></div>

              <div className="field-grid">
                <div className="field-input"><span>Enlem</span><input inputMode="decimal" value={form.lat} onChange={(event) => setForm((current) => ({ ...current, lat: event.target.value }))} placeholder="39.000000" /></div>
                <div className="field-input"><span>Boylam</span><input inputMode="decimal" value={form.lng} onChange={(event) => setForm((current) => ({ ...current, lng: event.target.value }))} placeholder="35.000000" /></div>
              </div>
              <div className="field-location-actions">
                <button type="button" onClick={useCurrentLocation} disabled={busy}><LocateFixed size={14} /> Konumumu Kullan</button>
                <button type="button" onClick={useMapCenter} disabled={!map}><Crosshair size={14} /> Harita Merkezi</button>
              </div>

              <div className="field-input"><span>Sembol</span>
                <div className="field-symbols">
                  {SYMBOLS.map((symbol) => <button key={symbol.id} type="button" className={`field-symbol${form.symbol === symbol.id ? ' is-active' : ''}`} onClick={() => setForm((current) => ({ ...current, symbol: symbol.id }))}><b>{symbol.icon}</b><small>{symbol.label}</small></button>)}
                </div>
              </div>

              <div className="field-photo">
                <div className="field-photo-preview">{previewUrl && !removeExistingPhoto ? <img src={previewUrl} alt="Saha noktası önizleme" /> : <Camera size={24} />}</div>
                <div className="field-photo-actions">
                  <label><Camera size={13} /> Fotoğraf Seç<input type="file" accept="image/*" capture="environment" onChange={onPhotoSelect} /></label>
                  {(previewUrl || currentEditingPoint?.photoId) && !removeExistingPhoto && <button type="button" className="field-danger" onClick={() => { setPhotoBlob(null); setRemoveExistingPhoto(Boolean(currentEditingPoint?.photoId)); setPreviewUrl((current) => { if (current) URL.revokeObjectURL(current); return null }) }}><Trash2 size={13} /> Fotoğrafı Kaldır</button>}
                </div>
              </div>

              {status && <div className={`field-status ${status.tone}`}>{status.text}</div>}
              <div className="field-form-actions">
                <button type="button" className="field-primary" onClick={savePoint} disabled={busy}><Save size={14} /> {editingId ? 'Güncelle' : 'Kaydet'}</button>
                <button type="button" className="field-secondary" onClick={resetForm} disabled={busy}>{editingId ? <><X size={14} /> Vazgeç</> : <><Plus size={14} /> Formu Temizle</>}</button>
              </div>
            </div>
          </section>

          <section className="field-card">
            <header><strong>Kayıtlı Saha Noktaları</strong><small>Haritada bağımsız waypoint katmanı</small></header>
            <div className="field-card-body">
              {points.length ? <div className="field-list">
                {points.slice().reverse().map((point) => {
                  const symbol = symbolInfo(point.symbol)
                  return <div className="field-row" key={point.id}>
                    <span className="field-row-symbol" title={symbol.label}>{symbol.icon}</span>
                    <div className="field-row-main" onClick={() => showPoint(point)} role="button" tabIndex={0} onKeyDown={(event) => { if (event.key === 'Enter') showPoint(point) }}>
                      <strong>{point.name}</strong>
                      <small>{point.note || `${point.lat.toFixed(6)}, ${point.lng.toFixed(6)}`} · {formatDate(point.updatedAt)}{point.photoId ? ' · 📷' : ''}</small>
                    </div>
                    <div className="field-row-actions">
                      <button type="button" onClick={() => showPoint(point)} title="Haritada göster" aria-label="Haritada göster"><Navigation size={13} /></button>
                      <button type="button" onClick={() => editPoint(point)} title="Düzenle" aria-label="Düzenle"><Edit3 size={13} /></button>
                      <button type="button" onClick={() => removePoint(point)} title="Sil" aria-label="Sil"><Trash2 size={13} /></button>
                    </div>
                  </div>
                })}
              </div> : <div className="field-empty"><MapPinned size={28} /><strong>Henüz saha noktası yok</strong><small>Konum, not, fotoğraf ve sembol ile ilk waypoint'i oluşturun.</small></div>}
              {points.length > 0 && <div className="field-list-footer"><button type="button" onClick={clearAllPoints}><Trash2 size={12} /> Tüm Saha Noktalarını Sil</button></div>}
            </div>
          </section>
        </div>
      </aside>
    </>,
    document.body,
  ) : null

  return <>{dockButton}{panel}</>
}
