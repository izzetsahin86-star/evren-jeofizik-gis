import { useEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { Gauge, MapPin, Navigation, Plus, Square, Timer, Trash2 } from 'lucide-react'

const TRACK_STORAGE_KEY = 'evren-jeofizik-gis-live-track-v1'

type TrackPoint = {
  id?: string
  lat: number
  lng: number
  accuracy?: number
  speed?: number | null
  timestamp?: number
}

interface LiveTrackingCoordinatePanelProps {
  active: boolean
  locationCardEnabled: boolean
  onEnsureLocationCard: () => void
  onConvertTrackToPolygon: (points: Array<{ lat: number; lng: number }>) => void
  onMessage: (message: string, tone?: 'success' | 'error' | 'info') => void
}

function readTrack(): TrackPoint[] {
  try {
    const value = JSON.parse(localStorage.getItem(TRACK_STORAGE_KEY) || '[]') as TrackPoint[]
    if (!Array.isArray(value)) return []
    return value.filter((point) => Number.isFinite(point.lat) && Number.isFinite(point.lng))
  } catch {
    return []
  }
}

function distanceMeters(a: TrackPoint, b: TrackPoint) {
  const radius = 6371008.8
  const rad = Math.PI / 180
  const lat1 = a.lat * rad
  const lat2 = b.lat * rad
  const dLat = (b.lat - a.lat) * rad
  const dLng = (b.lng - a.lng) * rad
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLng / 2) ** 2
  return radius * 2 * Math.atan2(Math.sqrt(h), Math.sqrt(1 - h))
}

function formatDistance(value: number) {
  return value >= 1000 ? `${(value / 1000).toFixed(2)} km` : `${Math.round(value)} m`
}

function formatDuration(milliseconds: number) {
  const totalSeconds = Math.max(0, Math.floor(milliseconds / 1000))
  const hours = Math.floor(totalSeconds / 3600)
  const minutes = Math.floor((totalSeconds % 3600) / 60)
  const seconds = totalSeconds % 60
  return hours > 0
    ? `${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`
    : `${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`
}

function liveButton(kind: 'start' | 'stop' | 'clear') {
  const labels = kind === 'start'
    ? ['Canlı konum takibini başlat', 'Canlı takibi başlat']
    : kind === 'stop'
      ? ['Canlı konum takibini durdur', 'Canlı takibi durdur']
      : ['Canlı takip izini temizle', 'Takip izini temizle']

  const buttons = Array.from(document.querySelectorAll<HTMLButtonElement>('.location-controls button'))
  return buttons.find((button) => labels.includes(button.getAttribute('aria-label') || '') || labels.includes(button.getAttribute('title') || '')) ?? null
}

export default function LiveTrackingCoordinatePanel({
  active,
  locationCardEnabled,
  onEnsureLocationCard,
  onConvertTrackToPolygon,
  onMessage,
}: LiveTrackingCoordinatePanelProps) {
  const [host, setHost] = useState<HTMLElement | null>(null)
  const [trackPoints, setTrackPoints] = useState<TrackPoint[]>(readTrack)
  const [tracking, setTracking] = useState(false)
  const [now, setNow] = useState(Date.now())
  const startingRef = useRef(false)

  useEffect(() => {
    let frame = 0
    let retries = 0

    const mount = () => {
      const stack = document.querySelector<HTMLElement>('.workspace-panel-scroll .panel-stack')
      if (!active || !stack) {
        if (active && retries < 20) {
          retries += 1
          frame = window.requestAnimationFrame(mount)
        }
        return
      }

      const existing = stack.querySelector<HTMLElement>('[data-live-track-panel-host]')
      if (existing) {
        setHost(existing)
        return
      }

      const node = document.createElement('div')
      node.dataset.liveTrackPanelHost = 'true'
      const chip = stack.querySelector('.active-layer-chip')
      if (chip?.nextSibling) stack.insertBefore(node, chip.nextSibling)
      else if (chip) stack.appendChild(node)
      else stack.prepend(node)
      setHost(node)
    }

    if (active) frame = window.requestAnimationFrame(mount)
    else setHost(null)

    return () => {
      window.cancelAnimationFrame(frame)
      const node = document.querySelector<HTMLElement>('[data-live-track-panel-host]')
      if (node) node.remove()
      setHost(null)
    }
  }, [active])

  useEffect(() => {
    const sync = () => {
      const points = readTrack()
      setTrackPoints(points)
      setTracking(Boolean(liveButton('stop')))
      setNow(Date.now())

      const controls = document.querySelector<HTMLElement>('.location-controls')
      if (!controls) return
      for (const button of Array.from(controls.querySelectorAll<HTMLButtonElement>('button'))) {
        const label = `${button.getAttribute('aria-label') || ''} ${button.getAttribute('title') || ''}`
        if (label.includes('Canlı') || label.includes('Takip izini')) button.style.display = 'none'
      }
      const accuracy = controls.querySelector<HTMLElement>('.gps-accuracy')
      if (accuracy) accuracy.style.display = points.length || liveButton('stop') ? 'none' : ''
    }

    sync()
    const timer = window.setInterval(sync, 500)
    const observer = new MutationObserver(sync)
    observer.observe(document.body, { childList: true, subtree: true })
    return () => {
      window.clearInterval(timer)
      observer.disconnect()
      const controls = document.querySelector<HTMLElement>('.location-controls')
      if (!controls) return
      for (const button of Array.from(controls.querySelectorAll<HTMLButtonElement>('button'))) button.style.display = ''
      const accuracy = controls.querySelector<HTMLElement>('.gps-accuracy')
      if (accuracy) accuracy.style.display = ''
    }
  }, [])

  const distanceM = useMemo(() => trackPoints.slice(1).reduce((sum, point, index) => sum + distanceMeters(trackPoints[index], point), 0), [trackPoints])
  const firstTimestamp = trackPoints[0]?.timestamp ?? null
  const lastTimestamp = trackPoints[trackPoints.length - 1]?.timestamp ?? null
  const elapsedMs = firstTimestamp ? Math.max(0, (tracking ? now : (lastTimestamp ?? now)) - firstTimestamp) : 0
  const current = trackPoints[trackPoints.length - 1]
  const speedKmh = current?.speed !== null && current?.speed !== undefined && Number.isFinite(current.speed)
    ? Math.max(0, current.speed * 3.6)
    : trackPoints.length >= 2 && lastTimestamp && trackPoints[trackPoints.length - 2]?.timestamp
      ? Math.max(0, distanceMeters(trackPoints[trackPoints.length - 2], current) / Math.max(0.2, (lastTimestamp - (trackPoints[trackPoints.length - 2].timestamp ?? lastTimestamp)) / 1000) * 3.6)
      : 0
  const accuracy = current?.accuracy && Number.isFinite(current.accuracy) ? Math.max(1, current.accuracy) : null

  const startTracking = () => {
    if (!navigator.geolocation) {
      onMessage('Bu cihaz konum hizmetini desteklemiyor.', 'error')
      return
    }
    if (tracking || startingRef.current) return
    startingRef.current = true

    if (!locationCardEnabled) onEnsureLocationCard()

    const tryStart = (attempt = 0) => {
      const button = liveButton('start')
      if (button) {
        button.click()
        startingRef.current = false
        setTracking(true)
        return
      }
      if (attempt < 12) window.setTimeout(() => tryStart(attempt + 1), 100)
      else {
        startingRef.current = false
        onMessage('Canlı takip başlatılamadı. Konum kartını ve tarayıcı konum iznini kontrol edin.', 'error')
      }
    }

    window.setTimeout(() => tryStart(), locationCardEnabled ? 0 : 80)
  }

  const stopTracking = () => {
    const button = liveButton('stop')
    if (!button) {
      onMessage('Aktif canlı takip bulunamadı.', 'info')
      return
    }
    button.click()
    setTracking(false)
  }

  const clearTrack = () => {
    const button = liveButton('clear')
    if (button) button.click()
    else localStorage.removeItem(TRACK_STORAGE_KEY)
    setTrackPoints([])
    setNow(Date.now())
  }

  const convertTrack = () => {
    if (trackPoints.length < 3) {
      onMessage('Poligona dönüştürmek için en az 3 GPS noktası gerekir.', 'error')
      return
    }
    if (tracking) stopTracking()
    onConvertTrackToPolygon(trackPoints.map(({ lat, lng }) => ({ lat, lng })))
  }

  if (!active || !host) return null

  return createPortal(
    <section className="live-track-panel-card" aria-live="polite">
      <style>{`
        .live-track-panel-card{overflow:hidden;border:1px solid #dbe7f3;border-radius:16px;background:#fff;box-shadow:0 2px 8px rgba(15,23,42,.045)}
        .live-track-panel-head{display:flex;align-items:center;justify-content:space-between;gap:10px;padding:11px 12px;border-bottom:1px solid #e8eef5;background:linear-gradient(135deg,#eef7ff,#f5fbff)}
        .live-track-panel-title{display:flex;align-items:center;gap:9px;min-width:0}.live-track-panel-title>span:first-child{width:32px;height:32px;display:grid;place-items:center;border-radius:10px;color:#1769aa;background:#dff0ff}
        .live-track-panel-title div{display:grid;gap:1px}.live-track-panel-title strong{font-size:12px}.live-track-panel-title small{color:#7b8a9d;font-size:9px}
        .live-track-status{display:flex;align-items:center;gap:5px;padding:5px 8px;border-radius:999px;color:#64748b;background:#eef2f6;font-size:9px;font-weight:800}.live-track-status.is-live{color:#087a50;background:#dcf8eb}.live-track-status i{width:7px;height:7px;border-radius:50%;background:currentColor}.live-track-status.is-live i{box-shadow:0 0 0 4px rgba(16,185,129,.13)}
        .live-track-stats{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:7px;padding:10px 11px}.live-track-stat{min-width:0;padding:8px 8px;border:1px solid #edf1f5;border-radius:11px;background:#fafcfe}.live-track-stat small{display:block;margin-bottom:3px;color:#8a97a8;font-size:8px}.live-track-stat strong{display:block;overflow:hidden;color:#26374d;font-size:11px;white-space:nowrap;text-overflow:ellipsis;font-variant-numeric:tabular-nums}
        .live-track-actions{display:grid;grid-template-columns:1fr 1fr;gap:7px;padding:0 11px 8px}.live-track-actions button{height:34px;display:flex;align-items:center;justify-content:center;gap:6px;border:0;border-radius:10px;font-size:10px;font-weight:750;cursor:pointer}.live-track-start{color:#fff;background:#159465}.live-track-stop{color:#fff;background:#e34c4c}.live-track-convert{color:#fff;background:#2877dc}.live-track-clear{color:#66758a;background:#eef2f6}.live-track-actions button:disabled{opacity:.38;cursor:not-allowed}
        .live-track-foot{display:flex;align-items:center;justify-content:space-between;gap:8px;padding:0 12px 10px;color:#8a97a8;font-size:8px}.live-track-foot span{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.live-track-foot strong{color:#53657c;font-size:8px}
        @media(max-width:520px){.live-track-stats{grid-template-columns:repeat(2,minmax(0,1fr))}}
      `}</style>
      <header className="live-track-panel-head">
        <div className="live-track-panel-title">
          <span><Navigation size={18} /></span>
          <div><strong>Canlı Konum Takibi</strong><small>GPS hareket izi ve saha kaydı</small></div>
        </div>
        <span className={`live-track-status${tracking ? ' is-live' : ''}`}><i />{tracking ? 'CANLI' : trackPoints.length ? 'DURDU' : 'HAZIR'}</span>
      </header>

      <div className="live-track-stats">
        <div className="live-track-stat"><small>Süre</small><strong>{formatDuration(elapsedMs)}</strong></div>
        <div className="live-track-stat"><small>Mesafe</small><strong>{formatDistance(distanceM)}</strong></div>
        <div className="live-track-stat"><small>Hız</small><strong>{speedKmh.toFixed(1)} km/sa</strong></div>
        <div className="live-track-stat"><small>GPS Hassasiyeti</small><strong>{accuracy ? `±${Math.round(accuracy)} m` : '—'}</strong></div>
      </div>

      <div className="live-track-actions">
        {tracking
          ? <button type="button" className="live-track-stop" onClick={stopTracking}><Square size={14} fill="currentColor" /> Durdur</button>
          : <button type="button" className="live-track-start" onClick={startTracking}><Navigation size={15} /> Başlat</button>}
        <button type="button" className="live-track-convert" onClick={convertTrack} disabled={trackPoints.length < 3}><Plus size={15} /> Kaydı Poligona Dönüştür</button>
        <button type="button" className="live-track-clear" onClick={clearTrack} disabled={!trackPoints.length || tracking}><Trash2 size={14} /> Kaydı Temizle</button>
        <button type="button" className="live-track-clear" disabled><Gauge size={14} /> {trackPoints.length} GPS Noktası</button>
      </div>

      <footer className="live-track-foot">
        <span><MapPin size={11} /> {current ? `${current.lat.toFixed(6)}, ${current.lng.toFixed(6)}` : 'GPS konumu bekleniyor'}</span>
        <strong><Timer size={11} /> WGS84</strong>
      </footer>
    </section>,
    host,
  )
}
