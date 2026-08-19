import { useEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import {
  AlertTriangle,
  BellRing,
  CircleGauge,
  Compass,
  Crosshair,
  LocateFixed,
  MapPinned,
  Navigation,
  Pause,
  Play,
  Plus,
  RefreshCw,
  RotateCw,
  Route,
  Satellite,
  ShieldCheck,
  Square,
  Target,
  Timer,
  Trash2,
  X,
} from 'lucide-react'
import type { PolygonLayer } from '../types'
import { Card, Field } from './PanelUi'

const TRACK_STORAGE_KEY = 'evren-jeofizik-gis-live-track-v1'
const LIVE_META_KEY = 'evren-jeofizik-gis-live-meta-v2'
const LIVE_SETTINGS_KEY = 'evren-jeofizik-gis-live-settings-v2'

type TrackPoint = {
  id?: string
  lat: number
  lng: number
  accuracy?: number
  altitude?: number | null
  speed?: number | null
  heading?: number | null
  timestamp?: number
}

type LiveSettings = {
  skipStationary: boolean
  signalWarnings: boolean
  signalAccuracyLimit: number
  routeId: string
  routeReverse: boolean
  routeLoop: boolean
  routeWarningDistance: number
  routeAheadDistance: number
  proximityEnabled: boolean
  proximityRadius: number
  proximityRepeat: boolean
  manualTargetId: string
  headingSource: 'auto' | 'gnss' | 'compass'
  rotateMap: boolean
}

type RecorderMeta = {
  startedAt: number | null
  segmentBreaks: number[]
}

interface LiveLocationPanelProps {
  active: boolean
  polygons: PolygonLayer[]
  locationCardEnabled: boolean
  onEnsureLocationCard: () => void
  onClose: () => void
  onFlyTo: (target: { lat: number; lng: number; zoom?: number }) => void
  onConvertTrackToPolygon: (points: Array<{ lat: number; lng: number }>) => void
  onMessage: (message: string, tone?: 'success' | 'error' | 'info') => void
}

const DEFAULT_SETTINGS: LiveSettings = {
  skipStationary: true,
  signalWarnings: true,
  signalAccuracyLimit: 60,
  routeId: '',
  routeReverse: false,
  routeLoop: false,
  routeWarningDistance: 50,
  routeAheadDistance: 50,
  proximityEnabled: false,
  proximityRadius: 50,
  proximityRepeat: false,
  manualTargetId: '',
  headingSource: 'auto',
  rotateMap: false,
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

function readSettings(): LiveSettings {
  try {
    return { ...DEFAULT_SETTINGS, ...(JSON.parse(localStorage.getItem(LIVE_SETTINGS_KEY) || '{}') as Partial<LiveSettings>) }
  } catch {
    return DEFAULT_SETTINGS
  }
}

function readMeta(): RecorderMeta {
  try {
    const value = JSON.parse(localStorage.getItem(LIVE_META_KEY) || '{}') as Partial<RecorderMeta>
    return {
      startedAt: typeof value.startedAt === 'number' ? value.startedAt : null,
      segmentBreaks: Array.isArray(value.segmentBreaks) && value.segmentBreaks.length ? value.segmentBreaks.filter(Number.isFinite) : [0],
    }
  } catch {
    return { startedAt: null, segmentBreaks: [0] }
  }
}

function distanceMeters(a?: { lat: number; lng: number }, b?: { lat: number; lng: number }) {
  if (!a || !b) return 0
  const radius = 6371008.8
  const rad = Math.PI / 180
  const lat1 = a.lat * rad
  const lat2 = b.lat * rad
  const dLat = (b.lat - a.lat) * rad
  const dLng = (b.lng - a.lng) * rad
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLng / 2) ** 2
  return radius * 2 * Math.atan2(Math.sqrt(h), Math.sqrt(Math.max(0, 1 - h)))
}

function bearingDegrees(a?: { lat: number; lng: number }, b?: { lat: number; lng: number }) {
  if (!a || !b) return null
  const rad = Math.PI / 180
  const lat1 = a.lat * rad
  const lat2 = b.lat * rad
  const dLng = (b.lng - a.lng) * rad
  const y = Math.sin(dLng) * Math.cos(lat2)
  const x = Math.cos(lat1) * Math.sin(lat2) - Math.sin(lat1) * Math.cos(lat2) * Math.cos(dLng)
  return (Math.atan2(y, x) / rad + 360) % 360
}

function segmentDistance(point: { lat: number; lng: number }, a: { lat: number; lng: number }, b: { lat: number; lng: number }) {
  const metersPerDegreeLat = 111132
  const metersPerDegreeLng = 111320 * Math.cos(point.lat * Math.PI / 180)
  const ax = (a.lng - point.lng) * metersPerDegreeLng
  const ay = (a.lat - point.lat) * metersPerDegreeLat
  const bx = (b.lng - point.lng) * metersPerDegreeLng
  const by = (b.lat - point.lat) * metersPerDegreeLat
  const dx = bx - ax
  const dy = by - ay
  const denominator = dx * dx + dy * dy
  const t = denominator > 0 ? Math.max(0, Math.min(1, -(ax * dx + ay * dy) / denominator)) : 0
  const x = ax + dx * t
  const y = ay + dy * t
  return { distance: Math.hypot(x, y), t }
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

function formatEte(seconds: number) {
  if (!Number.isFinite(seconds) || seconds < 0) return '—'
  if (seconds < 60) return `${Math.max(1, Math.round(seconds))} sn`
  if (seconds < 3600) return `${Math.round(seconds / 60)} dk`
  const hours = Math.floor(seconds / 3600)
  const minutes = Math.round((seconds % 3600) / 60)
  return `${hours} sa ${minutes} dk`
}

function compassLabel(value: number | null) {
  if (value === null) return '—'
  const labels = ['K', 'KD', 'D', 'GD', 'G', 'GB', 'B', 'KB']
  return labels[Math.round(value / 45) % 8]
}

function filterStationary(points: TrackPoint[], enabled: boolean) {
  if (!enabled || points.length < 2) return points
  const result: TrackPoint[] = [points[0]]
  for (let index = 1; index < points.length; index += 1) {
    const point = points[index]
    const previous = result[result.length - 1]
    const moved = distanceMeters(previous, point)
    const elapsed = Math.max(0, (point.timestamp ?? 0) - (previous.timestamp ?? 0))
    const accuracyGate = Math.min(12, Math.max(3, (point.accuracy ?? 8) * 0.35))
    if (moved >= accuracyGate || elapsed >= 30000 || index === points.length - 1) result.push(point)
  }
  return result
}

function trackDistance(points: TrackPoint[]) {
  return points.slice(1).reduce((sum, point, index) => sum + distanceMeters(points[index], point), 0)
}

function liveButton(kind: 'start' | 'stop' | 'clear') {
  const labels = kind === 'start'
    ? ['Canlı konum takibini başlat', 'Canlı takibi başlat']
    : kind === 'stop'
      ? ['Canlı konum takibini durdur', 'Canlı takibi durdur']
      : ['Canlı takip izini temizle', 'Takip izini temizle']
  return Array.from(document.querySelectorAll<HTMLButtonElement>('.location-controls button'))
    .find((button) => labels.includes(button.getAttribute('aria-label') || '') || labels.includes(button.getAttribute('title') || '')) ?? null
}

function numberBadge(value: number) {
  return <span className="live-feature-number">{value}</span>
}

export default function LiveLocationPanel({
  active,
  polygons,
  locationCardEnabled,
  onEnsureLocationCard,
  onClose,
  onFlyTo,
  onConvertTrackToPolygon,
  onMessage,
}: LiveLocationPanelProps) {
  const [rawTrack, setRawTrack] = useState<TrackPoint[]>(readTrack)
  const [settings, setSettings] = useState<LiveSettings>(readSettings)
  const [meta, setMeta] = useState<RecorderMeta>(readMeta)
  const [tracking, setTracking] = useState(false)
  const [now, setNow] = useState(Date.now())
  const [currentFix, setCurrentFix] = useState<TrackPoint | null>(() => readTrack().at(-1) ?? null)
  const [followRoute, setFollowRoute] = useState(false)
  const [compassActive, setCompassActive] = useState(false)
  const [compassHeading, setCompassHeading] = useState<number | null>(null)
  const [wakeLockActive, setWakeLockActive] = useState(false)
  const [mapHost, setMapHost] = useState<HTMLElement | null>(null)
  const [monitorMessage, setMonitorMessage] = useState('GPS hazır')
  const startingRef = useRef(false)
  const monitorWatchRef = useRef<number | null>(null)
  const wakeLockRef = useRef<any>(null)
  const lastSignalWarningRef = useRef(0)
  const lastRouteWarningRef = useRef(0)
  const lastProximityWarningRef = useRef(0)
  const proximityTargetRef = useRef('')

  const setLiveSettings = (patch: Partial<LiveSettings>) => {
    setSettings((current) => ({ ...current, ...patch }))
  }

  useEffect(() => {
    localStorage.setItem(LIVE_SETTINGS_KEY, JSON.stringify(settings))
  }, [settings])

  useEffect(() => {
    localStorage.setItem(LIVE_META_KEY, JSON.stringify(meta))
  }, [meta])

  useEffect(() => {
    const frame = window.requestAnimationFrame(() => setMapHost(document.querySelector<HTMLElement>('.map-shell')))
    return () => window.cancelAnimationFrame(frame)
  }, [])

  useEffect(() => {
    const sync = () => {
      const points = readTrack()
      setRawTrack(points)
      setTracking(Boolean(liveButton('stop')))
      setNow(Date.now())
      if (!currentFix && points.length) setCurrentFix(points[points.length - 1])
    }
    sync()
    const timer = window.setInterval(sync, 500)
    return () => window.clearInterval(timer)
  }, [currentFix])

  useEffect(() => {
    const shouldMonitor = tracking || followRoute || settings.proximityEnabled || settings.rotateMap
    if (!shouldMonitor || !navigator.geolocation) {
      if (monitorWatchRef.current !== null && navigator.geolocation) navigator.geolocation.clearWatch(monitorWatchRef.current)
      monitorWatchRef.current = null
      return
    }
    if (monitorWatchRef.current !== null) return

    monitorWatchRef.current = navigator.geolocation.watchPosition((position) => {
      setCurrentFix({
        lat: position.coords.latitude,
        lng: position.coords.longitude,
        accuracy: position.coords.accuracy,
        altitude: position.coords.altitude,
        speed: position.coords.speed,
        heading: position.coords.heading,
        timestamp: position.timestamp || Date.now(),
      })
      setMonitorMessage('GNSS bağlantısı aktif')
    }, (error) => {
      setMonitorMessage(error.code === error.PERMISSION_DENIED ? 'Konum izni kapalı' : 'GNSS sinyali alınamıyor')
    }, { enableHighAccuracy: true, timeout: 20000, maximumAge: 1000 })

    return () => {
      if (monitorWatchRef.current !== null && navigator.geolocation) navigator.geolocation.clearWatch(monitorWatchRef.current)
      monitorWatchRef.current = null
    }
  }, [tracking, followRoute, settings.proximityEnabled, settings.rotateMap])

  useEffect(() => {
    const requestWakeLock = async () => {
      if (!tracking || document.visibilityState !== 'visible') return
      try {
        const wakeLock = (navigator as Navigator & { wakeLock?: { request: (type: 'screen') => Promise<any> } }).wakeLock
        if (!wakeLock || wakeLockRef.current) return
        wakeLockRef.current = await wakeLock.request('screen')
        setWakeLockActive(true)
        wakeLockRef.current.addEventListener?.('release', () => {
          wakeLockRef.current = null
          setWakeLockActive(false)
        })
      } catch {
        setWakeLockActive(false)
      }
    }

    const onVisibility = () => {
      if (tracking && document.visibilityState === 'visible') void requestWakeLock()
    }

    if (tracking) void requestWakeLock()
    else if (wakeLockRef.current) {
      void wakeLockRef.current.release?.()
      wakeLockRef.current = null
      setWakeLockActive(false)
    }

    document.addEventListener('visibilitychange', onVisibility)
    return () => document.removeEventListener('visibilitychange', onVisibility)
  }, [tracking])

  useEffect(() => {
    if (!compassActive) return
    const handler = (event: DeviceOrientationEvent) => {
      const iosHeading = (event as DeviceOrientationEvent & { webkitCompassHeading?: number }).webkitCompassHeading
      const value = typeof iosHeading === 'number'
        ? iosHeading
        : typeof event.alpha === 'number'
          ? (360 - event.alpha + 360) % 360
          : null
      if (value !== null && Number.isFinite(value)) setCompassHeading(value)
    }
    window.addEventListener('deviceorientation', handler, true)
    return () => window.removeEventListener('deviceorientation', handler, true)
  }, [compassActive])

  const trackPoints = useMemo(() => filterStationary(rawTrack, settings.skipStationary), [rawTrack, settings.skipStationary])
  const totalDistanceM = useMemo(() => trackDistance(trackPoints), [trackPoints])
  const segmentStart = meta.segmentBreaks.at(-1) ?? 0
  const segmentPoints = useMemo(() => trackPoints.slice(Math.min(segmentStart, trackPoints.length)), [trackPoints, segmentStart])
  const segmentDistanceM = useMemo(() => trackDistance(segmentPoints), [segmentPoints])
  const firstTimestamp = meta.startedAt ?? trackPoints[0]?.timestamp ?? null
  const lastTimestamp = trackPoints.at(-1)?.timestamp ?? null
  const elapsedMs = firstTimestamp ? Math.max(0, (tracking ? now : (lastTimestamp ?? now)) - firstTimestamp) : 0
  const currentSpeedKmh = currentFix?.speed !== null && currentFix?.speed !== undefined && Number.isFinite(currentFix.speed)
    ? Math.max(0, currentFix.speed * 3.6)
    : 0
  const maxSpeedKmh = trackPoints.reduce((max, point) => typeof point.speed === 'number' && Number.isFinite(point.speed) ? Math.max(max, point.speed * 3.6) : max, 0)
  const averageSpeedKmh = elapsedMs > 0 ? totalDistanceM / (elapsedMs / 1000) * 3.6 : 0

  const pointOptions = useMemo(() => polygons.flatMap((layer) => layer.points.map((point, index) => ({
    id: `${layer.id}|${point.id}`,
    label: `${layer.name} · Nokta ${index + 1}`,
    point,
  }))), [polygons])

  const selectedManualTarget = pointOptions.find((option) => option.id === settings.manualTargetId)?.point ?? null
  const selectedRoute = polygons.find((layer) => layer.id === settings.routeId) ?? null

  const routeState = useMemo(() => {
    if (!followRoute || !currentFix || !selectedRoute || selectedRoute.points.length < 2) return null
    const points = settings.routeReverse ? [...selectedRoute.points].reverse() : selectedRoute.points
    let nearestIndex = 0
    let nearestT = 0
    let nearestDistance = Number.POSITIVE_INFINITY
    let total = 0
    const lengths = points.slice(1).map((point, index) => {
      const value = distanceMeters(points[index], point)
      total += value
      return value
    })

    for (let index = 0; index < points.length - 1; index += 1) {
      const result = segmentDistance(currentFix, points[index], points[index + 1])
      if (result.distance < nearestDistance) {
        nearestDistance = result.distance
        nearestIndex = index
        nearestT = result.t
      }
    }

    let done = lengths.slice(0, nearestIndex).reduce((sum, value) => sum + value, 0) + (lengths[nearestIndex] ?? 0) * nearestT
    let remainingAhead = settings.routeAheadDistance
    let target = points[Math.min(nearestIndex + 1, points.length - 1)]
    let cursorIndex = nearestIndex
    let cursorFraction = nearestT

    while (cursorIndex < points.length - 1 && remainingAhead > 0) {
      const segmentLength = lengths[cursorIndex] ?? 0
      const available = segmentLength * (1 - cursorFraction)
      if (available >= remainingAhead && segmentLength > 0) {
        const ratio = cursorFraction + remainingAhead / segmentLength
        target = {
          id: 'route-target',
          lat: points[cursorIndex].lat + (points[cursorIndex + 1].lat - points[cursorIndex].lat) * ratio,
          lng: points[cursorIndex].lng + (points[cursorIndex + 1].lng - points[cursorIndex].lng) * ratio,
        }
        remainingAhead = 0
      } else {
        remainingAhead -= available
        cursorIndex += 1
        cursorFraction = 0
        target = points[Math.min(cursorIndex, points.length - 1)]
      }
    }

    if (settings.routeLoop && cursorIndex >= points.length - 1 && remainingAhead > 0 && points.length > 2) target = points[0]
    done = Math.min(total, Math.max(0, done))
    return {
      target,
      offRouteM: nearestDistance,
      progress: total > 0 ? done / total * 100 : 0,
      remainingM: Math.max(0, total - done),
    }
  }, [followRoute, currentFix, selectedRoute, settings.routeReverse, settings.routeAheadDistance, settings.routeLoop])

  const activeTarget = routeState?.target ?? selectedManualTarget
  const targetDistanceM = activeTarget && currentFix ? distanceMeters(currentFix, activeTarget) : null
  const targetBearing = activeTarget && currentFix ? bearingDegrees(currentFix, activeTarget) : null
  const eteSpeedMps = currentFix?.speed && currentFix.speed > 0.5 ? currentFix.speed : 1.4
  const targetEte = targetDistanceM !== null ? targetDistanceM / eteSpeedMps : null

  const effectiveHeading = useMemo(() => {
    const gnssHeading = typeof currentFix?.heading === 'number' && Number.isFinite(currentFix.heading) ? currentFix.heading : null
    if (settings.headingSource === 'gnss') return gnssHeading
    if (settings.headingSource === 'compass') return compassHeading
    if (gnssHeading !== null && (currentFix?.speed ?? 0) >= 0.8) return gnssHeading
    return compassHeading ?? gnssHeading
  }, [settings.headingSource, currentFix, compassHeading])

  const relativeTargetBearing = targetBearing !== null && effectiveHeading !== null ? (targetBearing - effectiveHeading + 360) % 360 : targetBearing
  const fixAgeMs = currentFix?.timestamp ? Math.max(0, now - currentFix.timestamp) : Number.POSITIVE_INFINITY
  const signalLost = fixAgeMs > 15000
  const signalWeak = !signalLost && (currentFix?.accuracy ?? Number.POSITIVE_INFINITY) > settings.signalAccuracyLimit
  const signalText = signalLost ? 'SİNYAL YOK' : signalWeak ? 'ZAYIF' : currentFix ? 'İYİ' : 'BEKLİYOR'

  const alertUser = (message: string, tone: 'error' | 'info' = 'error') => {
    onMessage(message, tone)
    try { navigator.vibrate?.([180, 100, 180]) } catch { /* vibration unavailable */ }
  }

  useEffect(() => {
    if (!tracking || !settings.signalWarnings || (!signalLost && !signalWeak)) return
    if (now - lastSignalWarningRef.current < 30000) return
    lastSignalWarningRef.current = now
    alertUser(signalLost ? 'GNSS sinyali kayboldu.' : `GNSS hassasiyeti zayıf: ±${Math.round(currentFix?.accuracy ?? 0)} m.`)
  }, [tracking, settings.signalWarnings, signalLost, signalWeak, now, currentFix])

  useEffect(() => {
    if (!followRoute || !routeState || routeState.offRouteM <= settings.routeWarningDistance) return
    if (now - lastRouteWarningRef.current < 20000) return
    lastRouteWarningRef.current = now
    alertUser(`Rotadan ${Math.round(routeState.offRouteM)} m uzaklaştınız.`)
  }, [followRoute, routeState, settings.routeWarningDistance, now])

  useEffect(() => {
    if (!settings.proximityEnabled || !activeTarget || targetDistanceM === null) return
    const targetKey = routeState ? `route:${settings.routeId}` : settings.manualTargetId
    if (proximityTargetRef.current !== targetKey) {
      proximityTargetRef.current = targetKey
      lastProximityWarningRef.current = 0
    }
    if (targetDistanceM > settings.proximityRadius) return
    if (!settings.proximityRepeat && lastProximityWarningRef.current > 0) return
    if (now - lastProximityWarningRef.current < 20000) return
    lastProximityWarningRef.current = now
    alertUser(`Hedefe yaklaştınız: ${formatDistance(targetDistanceM)} kaldı.`, 'info')
  }, [settings.proximityEnabled, settings.proximityRadius, settings.proximityRepeat, settings.manualTargetId, settings.routeId, activeTarget, targetDistanceM, routeState, now])

  useEffect(() => {
    const canvas = document.querySelector<HTMLElement>('.map-canvas')
    if (!canvas) return
    if (settings.rotateMap && effectiveHeading !== null) {
      canvas.style.transformOrigin = '50% 50%'
      canvas.style.transition = 'transform 240ms linear'
      canvas.style.transform = `rotate(${-effectiveHeading}deg) scale(1.42)`
    } else {
      canvas.style.transform = ''
      canvas.style.transformOrigin = ''
      canvas.style.transition = ''
    }
    return () => {
      if (!settings.rotateMap) return
      canvas.style.transform = ''
      canvas.style.transformOrigin = ''
      canvas.style.transition = ''
    }
  }, [settings.rotateMap, effectiveHeading])

  const ensureFix = () => {
    if (!navigator.geolocation) {
      onMessage('Bu cihaz konum hizmetini desteklemiyor.', 'error')
      return
    }
    navigator.geolocation.getCurrentPosition((position) => {
      const point: TrackPoint = {
        lat: position.coords.latitude,
        lng: position.coords.longitude,
        accuracy: position.coords.accuracy,
        altitude: position.coords.altitude,
        speed: position.coords.speed,
        heading: position.coords.heading,
        timestamp: position.timestamp || Date.now(),
      }
      setCurrentFix(point)
      onFlyTo({ lat: point.lat, lng: point.lng, zoom: 17 })
      onMessage(`GPS konumu güncellendi · ±${Math.round(position.coords.accuracy)} m`, 'success')
    }, () => onMessage('Konum alınamadı. Konum iznini kontrol edin.', 'error'), { enableHighAccuracy: true, timeout: 15000, maximumAge: 1000 })
  }

  const startRecorder = (mode: 'new' | 'resume') => {
    if (!navigator.geolocation) {
      onMessage('Bu cihaz konum hizmetini desteklemiyor.', 'error')
      return
    }
    if (tracking || startingRef.current) return
    startingRef.current = true

    if (mode === 'new') {
      liveButton('clear')?.click()
      localStorage.removeItem(TRACK_STORAGE_KEY)
      setRawTrack([])
      setMeta({ startedAt: Date.now(), segmentBreaks: [0] })
    } else if (!meta.startedAt) {
      setMeta({ startedAt: rawTrack[0]?.timestamp ?? Date.now(), segmentBreaks: meta.segmentBreaks.length ? meta.segmentBreaks : [0] })
    }

    if (!locationCardEnabled) onEnsureLocationCard()

    const tryStart = (attempt = 0) => {
      const button = liveButton('start')
      if (button) {
        button.click()
        startingRef.current = false
        setTracking(true)
        onMessage(mode === 'new' ? 'Yeni GPS kaydı başlatıldı.' : 'Son GPS kaydına devam ediliyor.', 'success')
        return
      }
      if (attempt < 15) window.setTimeout(() => tryStart(attempt + 1), 100)
      else {
        startingRef.current = false
        onMessage('Canlı takip başlatılamadı. Konum kartını ve konum iznini kontrol edin.', 'error')
      }
    }
    window.setTimeout(() => tryStart(), locationCardEnabled ? 0 : 100)
  }

  const stopRecorder = () => {
    const button = liveButton('stop')
    if (!button) {
      onMessage('Aktif canlı takip bulunamadı.', 'info')
      return
    }
    button.click()
    setTracking(false)
  }

  const newSegment = () => {
    if (!tracking) return
    const index = trackPoints.length
    setMeta((current) => ({ ...current, segmentBreaks: [...current.segmentBreaks.filter((value) => value < index), index] }))
    onMessage(`Yeni segment / tur başlatıldı · ${meta.segmentBreaks.length + 1}. segment`, 'success')
  }

  const clearTrack = () => {
    if (tracking) return
    const button = liveButton('clear')
    if (button) button.click()
    else localStorage.removeItem(TRACK_STORAGE_KEY)
    setRawTrack([])
    setMeta({ startedAt: null, segmentBreaks: [0] })
  }

  const convertTrack = () => {
    if (trackPoints.length < 3) {
      onMessage('Poligona dönüştürmek için en az 3 GPS noktası gerekir.', 'error')
      return
    }
    if (tracking) stopRecorder()
    onConvertTrackToPolygon(trackPoints.map(({ lat, lng }) => ({ lat, lng })))
  }

  const requestCompass = async () => {
    const OrientationCtor = window.DeviceOrientationEvent as typeof DeviceOrientationEvent & { requestPermission?: () => Promise<'granted' | 'denied'> }
    try {
      if (typeof OrientationCtor?.requestPermission === 'function') {
        const permission = await OrientationCtor.requestPermission()
        if (permission !== 'granted') {
          onMessage('Pusula / hareket sensörü izni verilmedi.', 'error')
          return
        }
      }
      setCompassActive(true)
      onMessage('Pusula etkinleştirildi. Gerekirse telefonu 8 çizerek kalibre edin.', 'success')
    } catch {
      onMessage('Bu cihazda pusula sensörüne erişilemiyor.', 'error')
    }
  }

  const startFollowing = () => {
    if (!selectedRoute || selectedRoute.points.length < 2) {
      onMessage('Takip edilecek en az 2 noktalı bir poligon/rota seçin.', 'error')
      return
    }
    if (!currentFix) ensureFix()
    setFollowRoute(true)
    onMessage(`${selectedRoute.name} rotası takip ediliyor.`, 'success')
  }

  return (
    <>
      <style>{`
        .bottom-dock{width:min(590px,calc(100vw - 18px));grid-template-columns:repeat(7,minmax(0,1fr));padding-left:6px;padding-right:6px}
        .bottom-dock button{min-width:0;padding-left:2px;padding-right:2px}
        .bottom-dock button span{max-width:100%;overflow:hidden;text-overflow:ellipsis}
        .bottom-dock button[data-panel-id="live"].is-active{color:#07855b;background:linear-gradient(180deg,#dcf8ea,#effcf6)}
        .bottom-dock button[data-panel-id="tools"].is-active{color:#de8f05;background:linear-gradient(180deg,#fff4ce,#fff9e8)}
        .location-controls button[aria-label="Canlı konum takibini başlat"],
        .location-controls button[aria-label="Canlı konum takibini durdur"],
        .location-controls button[aria-label="Canlı takip izini temizle"]{display:none!important}
        .live-location-panel .workspace-panel-scroll{padding-bottom:112px}
        .live-feature-number{width:22px;height:22px;display:inline-grid;place-items:center;border-radius:7px;background:#e7f6ef;color:#087a50;font-size:10px;font-weight:900}
        .live-status-row{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:7px}
        .live-status-cell{min-width:0;padding:8px;border:1px solid #edf1f5;border-radius:11px;background:#fafcfe}
        .live-status-cell small{display:block;color:#8a97a8;font-size:8px;margin-bottom:3px}
        .live-status-cell strong{display:block;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:10px;font-variant-numeric:tabular-nums}
        .live-action-grid{display:grid;grid-template-columns:1fr 1fr;gap:7px;margin-top:9px}
        .live-action-grid button,.live-wide-button{min-height:34px;display:flex;align-items:center;justify-content:center;gap:6px;border:0;border-radius:10px;background:#eef3f7;color:#4f6075;font-size:10px;font-weight:750;cursor:pointer}
        .live-action-grid button.primary,.live-wide-button.primary{color:#fff;background:#159465}
        .live-action-grid button.stop{color:#fff;background:#e05252}
        .live-action-grid button.blue,.live-wide-button.blue{color:#fff;background:#2877dc}
        .live-action-grid button:disabled,.live-wide-button:disabled{opacity:.4;cursor:not-allowed}
        .live-inline-note{display:flex;align-items:flex-start;gap:6px;margin:8px 0 0;color:#7b899b;font-size:9px;line-height:1.4}
        .live-inline-note.warning{color:#a76216}
        .live-toggle-row{display:flex;align-items:center;justify-content:space-between;gap:9px;padding:8px 0;border-top:1px solid #edf1f5}
        .live-toggle-row:first-of-type{border-top:0}
        .live-toggle-row span{display:grid;gap:2px}
        .live-toggle-row strong{font-size:10px}.live-toggle-row small{color:#8795a7;font-size:8px}
        .live-toggle-row input[type="checkbox"]{width:17px;height:17px;accent-color:#159465}
        .live-signal{display:flex;align-items:center;justify-content:space-between;gap:8px;padding:9px 10px;border-radius:11px;background:#eef9f4;color:#087a50}
        .live-signal.weak{background:#fff6df;color:#a76500}.live-signal.lost{background:#fff0f0;color:#b83b3b}
        .live-signal span{display:flex;align-items:center;gap:7px;font-size:10px;font-weight:800}.live-signal small{font-size:8px;color:inherit;opacity:.8}
        .live-progress{height:7px;overflow:hidden;border-radius:999px;background:#edf1f5;margin-top:8px}.live-progress span{display:block;height:100%;background:#2877dc}
        .live-route-status{display:grid;grid-template-columns:repeat(3,1fr);gap:6px;margin-top:8px}.live-route-status span{padding:7px;border-radius:9px;background:#f7f9fb}.live-route-status small{display:block;color:#8b97a7;font-size:8px}.live-route-status strong{font-size:10px}
        .live-target-card{display:grid;grid-template-columns:76px 1fr;gap:10px;align-items:center;margin-top:9px;padding:9px;border-radius:12px;background:#f7fbff;border:1px solid #e3edf7}
        .live-target-arrow{width:72px;height:72px;display:grid;place-items:center;border-radius:50%;border:1px solid #d8e5f1;background:#fff;position:relative}
        .live-target-arrow svg{color:#2877dc;transform:rotate(var(--target-bearing,0deg));transition:transform .2s linear}
        .live-target-details{display:grid;grid-template-columns:1fr 1fr;gap:6px}.live-target-details span{min-width:0}.live-target-details small{display:block;color:#8b97a7;font-size:8px}.live-target-details strong{font-size:10px}
        .live-compass{display:grid;grid-template-columns:96px 1fr;gap:12px;align-items:center}.live-compass-dial{width:92px;height:92px;position:relative;border:1px solid #dce5ee;border-radius:50%;background:radial-gradient(circle,#fff 0 53%,#f2f6f9 54%)}
        .live-compass-dial:before{content:'K';position:absolute;top:5px;left:50%;transform:translateX(-50%);font-size:9px;font-weight:900;color:#c74d4d}.live-compass-dial:after{content:'G';position:absolute;bottom:5px;left:50%;transform:translateX(-50%);font-size:8px;font-weight:800;color:#718096}
        .live-compass-needle{position:absolute;left:50%;top:50%;width:3px;height:36px;margin:-31px 0 0 -1.5px;border-radius:3px;background:#d94a4a;transform-origin:50% 31px;transition:transform .18s linear}.live-compass-needle:after{content:'';position:absolute;bottom:-26px;left:0;width:3px;height:26px;border-radius:3px;background:#75859a}
        .live-compass-copy{display:grid;gap:7px}.live-compass-copy strong{font-size:18px}.live-compass-copy small{color:#8492a4;font-size:9px;line-height:1.4}
        .live-nav-overlay{pointer-events:none;position:absolute;z-index:530;left:50%;top:92px;transform:translateX(-50%);display:flex;align-items:center;gap:8px;padding:7px 10px;border:1px solid rgba(219,231,243,.95);border-radius:999px;background:rgba(255,255,255,.94);box-shadow:0 6px 18px rgba(15,23,42,.13);font-size:10px;font-weight:800;backdrop-filter:blur(10px)}
        .live-nav-overlay svg{color:#2877dc;transform:rotate(var(--nav-bearing,0deg));transition:transform .2s linear}.live-nav-overlay small{font-size:8px;color:#7c899b;font-weight:700}
        @media(max-width:620px){.bottom-dock button{font-size:9px}.bottom-dock button svg{width:19px;height:19px}.live-status-row{grid-template-columns:repeat(2,minmax(0,1fr))}.live-route-status{grid-template-columns:1fr 1fr}.live-compass{grid-template-columns:82px 1fr}.live-compass-dial{width:78px;height:78px}.live-compass-needle{height:30px;margin-top:-27px;transform-origin:50% 27px}}
      `}</style>

      {active && (
        <aside className="workspace-panel live-location-panel" aria-label="Canlı Konum">
          <div className="workspace-panel-title"><span>Canlı Konum</span><button type="button" onClick={onClose} aria-label="Paneli kapat"><X size={19} /></button></div>
          <div className="workspace-panel-scroll">
            <div className="panel-stack">
              <Card title="Arka Plan GPS" subtitle="Saha takibini mümkün olduğunca kesintisiz tutar" icon={numberBadge(1)} tone="green">
                <div className={`live-signal${signalLost ? ' lost' : signalWeak ? ' weak' : ''}`}>
                  <span><Satellite size={16} /> {signalText}</span>
                  <small>{currentFix ? `±${Math.round(currentFix.accuracy ?? 0)} m · ${monitorMessage}` : monitorMessage}</small>
                </div>
                <div className="live-status-row" style={{ marginTop: 8 }}>
                  <div className="live-status-cell"><small>Takip</small><strong>{tracking ? 'CANLI' : 'Kapalı'}</strong></div>
                  <div className="live-status-cell"><small>Ekran Kilidi</small><strong>{wakeLockActive ? 'Korunuyor' : tracking ? 'Tarayıcıya bağlı' : '—'}</strong></div>
                  <div className="live-status-cell"><small>Son Fix</small><strong>{Number.isFinite(fixAgeMs) ? `${Math.round(fixAgeMs / 1000)} sn` : '—'}</strong></div>
                  <div className="live-status-cell"><small>Kaynak</small><strong>GNSS</strong></div>
                </div>
                <p className="live-inline-note warning"><AlertTriangle size={13} /> APK’deki Android foreground service mantığı kaynak alındı. Web sürümü sekme/PWA açıkken takibi sürdürür; tarayıcı tamamen kapatıldığında Android servis gibi konum alamaz.</p>
              </Card>

              <Card title="Gelişmiş Rota Kaydedici" subtitle="Devam et, yeni kayıt, segment ve akıllı nokta filtresi" icon={numberBadge(2)} tone="green">
                <div className="live-status-row">
                  <div className="live-status-cell"><small>Süre</small><strong>{formatDuration(elapsedMs)}</strong></div>
                  <div className="live-status-cell"><small>Mesafe</small><strong>{formatDistance(totalDistanceM)}</strong></div>
                  <div className="live-status-cell"><small>Anlık Hız</small><strong>{currentSpeedKmh.toFixed(1)} km/sa</strong></div>
                  <div className="live-status-cell"><small>GPS</small><strong>{currentFix ? `±${Math.round(currentFix.accuracy ?? 0)} m` : '—'}</strong></div>
                  <div className="live-status-cell"><small>Ort. Hız</small><strong>{averageSpeedKmh.toFixed(1)} km/sa</strong></div>
                  <div className="live-status-cell"><small>Maks. Hız</small><strong>{maxSpeedKmh.toFixed(1)} km/sa</strong></div>
                  <div className="live-status-cell"><small>Segment</small><strong>{meta.segmentBreaks.length}</strong></div>
                  <div className="live-status-cell"><small>Bu Segment</small><strong>{formatDistance(segmentDistanceM)}</strong></div>
                </div>
                <div className="live-action-grid">
                  {tracking ? (
                    <>
                      <button type="button" className="stop" onClick={stopRecorder}><Square size={14} fill="currentColor" /> Durdur</button>
                      <button type="button" className="blue" onClick={newSegment}><Plus size={14} /> Yeni Segment / Tur</button>
                    </>
                  ) : rawTrack.length ? (
                    <>
                      <button type="button" className="primary" onClick={() => startRecorder('resume')}><Play size={14} /> Son Kayda Devam</button>
                      <button type="button" className="blue" onClick={() => startRecorder('new')}><RefreshCw size={14} /> Yeni Kayıt</button>
                    </>
                  ) : (
                    <button type="button" className="primary" style={{ gridColumn: '1 / -1' }} onClick={() => startRecorder('new')}><Play size={14} /> Canlı Kaydı Başlat</button>
                  )}
                  <button type="button" onClick={convertTrack} disabled={trackPoints.length < 3}><MapPinned size={14} /> Kaydı Poligona Dönüştür</button>
                  <button type="button" onClick={clearTrack} disabled={!rawTrack.length || tracking}><Trash2 size={14} /> Kaydı Temizle</button>
                </div>
                <label className="live-toggle-row"><span><strong>Hareketsizken konumları atla</strong><small>GPS salınımını ve gereksiz noktaları azaltır</small></span><input type="checkbox" checked={settings.skipStationary} onChange={(event) => setLiveSettings({ skipStationary: event.target.checked })} /></label>
                <p className="live-inline-note"><Pause size={12} /> Kaydedilen {rawTrack.length} ham GPS noktasından {trackPoints.length} saha noktası kullanılıyor.</p>
              </Card>

              <Card title="GNSS Sinyal Uyarısı" subtitle="Sinyal kaybolduğunda veya hassasiyet düştüğünde uyarır" icon={numberBadge(3)} tone="amber">
                <label className="live-toggle-row"><span><strong>Kayıp / zayıf sinyal uyarısı</strong><small>APK’deki “Lost signal warning” davranışı</small></span><input type="checkbox" checked={settings.signalWarnings} onChange={(event) => setLiveSettings({ signalWarnings: event.target.checked })} /></label>
                <Field label="Zayıf sinyal sınırı"><select value={settings.signalAccuracyLimit} onChange={(event) => setLiveSettings({ signalAccuracyLimit: Number(event.target.value) })}><option value="30">±30 m</option><option value="50">±50 m</option><option value="60">±60 m</option><option value="100">±100 m</option></select></Field>
                <p className="live-inline-note"><BellRing size={12} /> Kayıp sinyal 15 saniye fix alınamadığında; zayıf sinyal seçilen hassasiyet sınırı aşıldığında değerlendirilir.</p>
              </Card>

              <Card title="Rota Takibi" subtitle="Canlı ilerleme, ters sıra, döngü ve rotadan sapma uyarısı" icon={numberBadge(4)} tone="purple">
                <Field label="Takip edilecek poligon / rota"><select value={settings.routeId} onChange={(event) => { setLiveSettings({ routeId: event.target.value }); setFollowRoute(false) }}><option value="">Rota seçin</option>{polygons.filter((layer) => layer.points.length >= 2).map((layer) => <option key={layer.id} value={layer.id}>{layer.name} · {layer.points.length} nokta</option>)}</select></Field>
                <div className="form-grid two">
                  <Field label="Rotadan sapma"><select value={settings.routeWarningDistance} onChange={(event) => setLiveSettings({ routeWarningDistance: Number(event.target.value) })}><option value="20">20 m</option><option value="50">50 m</option><option value="100">100 m</option><option value="200">200 m</option></select></Field>
                  <Field label="İleri hedef"><select value={settings.routeAheadDistance} onChange={(event) => setLiveSettings({ routeAheadDistance: Number(event.target.value) })}><option value="20">20 m</option><option value="50">50 m</option><option value="100">100 m</option><option value="200">200 m</option></select></Field>
                </div>
                <label className="live-toggle-row"><span><strong>Ters sırada takip et</strong><small>Rotayı sondan başa takip eder</small></span><input type="checkbox" checked={settings.routeReverse} onChange={(event) => setLiveSettings({ routeReverse: event.target.checked })} /></label>
                <label className="live-toggle-row"><span><strong>Döngü</strong><small>Rota sonunda yeniden başlangıca yönelir</small></span><input type="checkbox" checked={settings.routeLoop} onChange={(event) => setLiveSettings({ routeLoop: event.target.checked })} /></label>
                <button type="button" className={`live-wide-button${followRoute ? '' : ' primary'}`} onClick={() => followRoute ? setFollowRoute(false) : startFollowing()}>{followRoute ? <><Square size={14} /> Rota Takibini Bitir</> : <><Route size={14} /> Rotayı Takip Et</>}</button>
                {routeState && (
                  <>
                    <div className="live-progress"><span style={{ width: `${Math.min(100, Math.max(0, routeState.progress))}%` }} /></div>
                    <div className="live-route-status"><span><small>İlerleme</small><strong>%{Math.round(routeState.progress)}</strong></span><span><small>Kalan</small><strong>{formatDistance(routeState.remainingM)}</strong></span><span><small>Rotadan Uzaklık</small><strong>{formatDistance(routeState.offRouteM)}</strong></span></div>
                  </>
                )}
              </Card>

              <Card title="Yakınlık Alarmı" subtitle="Hedefe yaklaşınca saha uyarısı verir" icon={numberBadge(5)} tone="amber">
                <label className="live-toggle-row"><span><strong>Yakınlık alarmı</strong><small>Seçili hedef / rota hedefi için</small></span><input type="checkbox" checked={settings.proximityEnabled} onChange={(event) => setLiveSettings({ proximityEnabled: event.target.checked })} /></label>
                <div className="form-grid two">
                  <Field label="Alarm mesafesi"><select value={settings.proximityRadius} onChange={(event) => setLiveSettings({ proximityRadius: Number(event.target.value) })}><option value="20">20 m</option><option value="50">50 m</option><option value="100">100 m</option><option value="200">200 m</option><option value="500">500 m</option></select></Field>
                  <label className="live-toggle-row" style={{ padding: '0 0 2px' }}><span><strong>Tekrarla</strong><small>Yakında kaldıkça yine uyar</small></span><input type="checkbox" checked={settings.proximityRepeat} onChange={(event) => setLiveSettings({ proximityRepeat: event.target.checked })} /></label>
                </div>
              </Card>

              <Card title="Hedefe Navigasyon" subtitle="Mesafe, yön ve tahmini varış süresi" icon={numberBadge(6)} tone="green">
                <Field label="Hedef nokta"><select value={settings.manualTargetId} onChange={(event) => setLiveSettings({ manualTargetId: event.target.value })}><option value="">Hedef seçin</option>{pointOptions.map((option) => <option key={option.id} value={option.id}>{option.label}</option>)}</select></Field>
                <div className="live-action-grid">
                  <button type="button" onClick={ensureFix}><LocateFixed size={14} /> Konumumu Güncelle</button>
                  <button type="button" onClick={() => activeTarget && onFlyTo({ lat: activeTarget.lat, lng: activeTarget.lng, zoom: 17 })} disabled={!activeTarget}><Target size={14} /> Hedefi Haritada Göster</button>
                </div>
                {activeTarget && (
                  <div className="live-target-card">
                    <div className="live-target-arrow" style={{ '--target-bearing': `${relativeTargetBearing ?? 0}deg` } as React.CSSProperties}><Navigation size={34} fill="currentColor" /></div>
                    <div className="live-target-details">
                      <span><small>Mesafe</small><strong>{targetDistanceM === null ? '—' : formatDistance(targetDistanceM)}</strong></span>
                      <span><small>Yön</small><strong>{targetBearing === null ? '—' : `${Math.round(targetBearing)}° ${compassLabel(targetBearing)}`}</strong></span>
                      <span><small>ETE</small><strong>{targetEte === null ? '—' : formatEte(targetEte)}</strong></span>
                      <span><small>Hedef</small><strong>{routeState ? 'Rota ilerisi' : 'Nokta'}</strong></span>
                    </div>
                  </div>
                )}
              </Card>

              <Card title="Pusula" subtitle="Manyetik sensör veya GNSS yönü" icon={numberBadge(7)} tone="purple">
                <div className="live-compass">
                  <div className="live-compass-dial"><span className="live-compass-needle" style={{ transform: `rotate(${effectiveHeading ?? 0}deg)` }} /></div>
                  <div className="live-compass-copy"><strong>{effectiveHeading === null ? '—' : `${Math.round(effectiveHeading)}° ${compassLabel(effectiveHeading)}`}</strong><small>APK kaynağındaki pusula kalibrasyon mantığına uygun olarak sensör saparsa telefonu tüm yönlerde / 8 şekli çizerek hareket ettirin.</small><button type="button" className="live-wide-button" onClick={requestCompass}><Compass size={14} /> {compassActive ? 'Pusula Aktif' : 'Pusulayı Etkinleştir'}</button></div>
                </div>
                <Field label="Yön kaynağı"><select value={settings.headingSource} onChange={(event) => setLiveSettings({ headingSource: event.target.value as LiveSettings['headingSource'] })}><option value="auto">Otomatik · hareket varsa GNSS</option><option value="gnss">GNSS rota yönü</option><option value="compass">Manyetik pusula</option></select></Field>
              </Card>

              <Card title="Haritayı Yöne Döndür" subtitle="GNSS / pusula yönüne göre saha görünümünü hizalar" icon={numberBadge(8)} tone="green">
                <label className="live-toggle-row"><span><strong>Yön kilidi</strong><small>Haritayı mevcut yön yukarı gelecek şekilde döndürür</small></span><input type="checkbox" checked={settings.rotateMap} onChange={(event) => setLiveSettings({ rotateMap: event.target.checked })} /></label>
                <div className="live-status-row">
                  <div className="live-status-cell"><small>Yön</small><strong>{effectiveHeading === null ? '—' : `${Math.round(effectiveHeading)}°`}</strong></div>
                  <div className="live-status-cell"><small>Kaynak</small><strong>{settings.headingSource === 'auto' ? 'Otomatik' : settings.headingSource === 'gnss' ? 'GNSS' : 'Pusula'}</strong></div>
                  <div className="live-status-cell"><small>Harita</small><strong>{settings.rotateMap ? 'Yönlü' : 'Kuzey yukarı'}</strong></div>
                  <div className="live-status-cell"><small>Hedef yönü</small><strong>{relativeTargetBearing === null ? '—' : `${Math.round(relativeTargetBearing)}°`}</strong></div>
                </div>
                <p className="live-inline-note"><RotateCw size={12} /> Yön kilidini kapattığınızda harita anında standart kuzey-yukarı görünümüne döner.</p>
              </Card>
            </div>
          </div>
          <div className="panel-resize-cue"><CircleGauge size={15} /></div>
        </aside>
      )}

      {mapHost && activeTarget && createPortal(
        <div className="live-nav-overlay" style={{ '--nav-bearing': `${relativeTargetBearing ?? 0}deg` } as React.CSSProperties}>
          <Navigation size={15} fill="currentColor" />
          <span>{targetDistanceM === null ? 'Hedef' : formatDistance(targetDistanceM)}</span>
          <small>{targetBearing === null ? '' : `${Math.round(targetBearing)}° ${compassLabel(targetBearing)}`}</small>
        </div>,
        mapHost,
      )}
    </>
  )
}
