const VISITOR_KEY = 'evren-jeofizik-anonymous-visitor-v1'
const GEO_CAPTURE_FLAG = '__evrenGrantedLocationCaptureV1'

type VisitSession = {
  visitId: string
  visitorId: string
  editToken: string
  day: string
}

type GrantedLocation = {
  latitude: number
  longitude: number
  accuracy: number
}

let currentSession: VisitSession | null = null
let startPromise: Promise<VisitSession | null> | null = null
let lifecycleInstalled = false
let gpsRecordedVisitId: string | null = null
let gpsRecordingPromise: Promise<void> | null = null

function randomId() {
  if (typeof crypto.randomUUID === 'function') return crypto.randomUUID()
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (character) => {
    const value = Math.floor(Math.random() * 16)
    const digit = character === 'x' ? value : (value & 0x3) | 0x8
    return digit.toString(16)
  })
}

function visitorId() {
  try {
    const existing = localStorage.getItem(VISITOR_KEY)
    if (existing) return existing
    const created = randomId()
    localStorage.setItem(VISITOR_KEY, created)
    return created
  } catch {
    return randomId()
  }
}

function delay(milliseconds: number) {
  return new Promise<void>((resolve) => window.setTimeout(resolve, milliseconds))
}

async function post(path: string, body: object, keepalive = false) {
  const response = await fetch(path, {
    method: 'POST',
    credentials: 'same-origin',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    keepalive,
  })
  if (!response.ok) return null
  return response.json().catch(() => null)
}

async function postWithRetry(path: string, body: object, attempts = 3, keepalive = false) {
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      const payload = await post(path, body, keepalive)
      if (payload) return payload
    } catch {
      // Geçici ağ / fonksiyon hatasında kısa süre sonra yeniden dene.
    }
    if (attempt < attempts - 1) await delay(500 * (attempt + 1))
  }
  return null
}

function sessionPayload(session: VisitSession) {
  return {
    visitId: session.visitId,
    editToken: session.editToken,
    day: session.day,
  }
}

function sendActivity(ended: boolean) {
  if (!currentSession) return
  const body = JSON.stringify({ ...sessionPayload(currentSession), ended })
  if (ended && navigator.sendBeacon) {
    navigator.sendBeacon('/api/visits/activity', new Blob([body], { type: 'application/json' }))
    return
  }
  void post('/api/visits/activity', JSON.parse(body), true).catch(() => undefined)
}

function installLifecycle() {
  if (lifecycleInstalled) return
  lifecycleInstalled = true
  window.addEventListener('pagehide', () => sendActivity(true))
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') sendActivity(false)
  })
  window.setInterval(() => {
    if (document.visibilityState === 'visible') sendActivity(false)
  }, 5 * 60 * 1000)
}

export function startVisitorTracking() {
  if (currentSession) return Promise.resolve(currentSession)
  if (startPromise) return startPromise
  startPromise = postWithRetry('/api/visits/start', {
    visitorId: visitorId(),
    page: window.location.pathname,
    referrer: document.referrer,
    language: navigator.language,
    timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
    screen: {
      width: window.screen.width,
      height: window.screen.height,
      pixelRatio: window.devicePixelRatio,
    },
  }).then((payload) => {
    if (!payload?.ok || !payload.visitId || !payload.editToken || !payload.day) {
      startPromise = null
      return null
    }
    currentSession = {
      visitId: payload.visitId,
      visitorId: payload.visitorId,
      editToken: payload.editToken,
      day: payload.day,
    }
    installLifecycle()
    return currentSession
  }).catch(() => {
    startPromise = null
    return null
  })
  return startPromise
}

export async function recordGrantedLocation(location: GrantedLocation) {
  const session = currentSession || await startVisitorTracking()
  if (!session || gpsRecordedVisitId === session.visitId) return

  if (gpsRecordingPromise) {
    await gpsRecordingPromise
    if (gpsRecordedVisitId === session.visitId) return
  }

  const task = (async () => {
    const payload = await postWithRetry('/api/visits/location', {
      ...sessionPayload(session),
      latitude: location.latitude,
      longitude: location.longitude,
      accuracy: location.accuracy,
    }, 3)
    if (payload?.ok && payload.updated !== false) gpsRecordedVisitId = session.visitId
  })()

  gpsRecordingPromise = task
  try {
    await task
  } finally {
    if (gpsRecordingPromise === task) gpsRecordingPromise = null
  }
}

function installGeolocationCapture() {
  if (typeof navigator === 'undefined' || !navigator.geolocation) return
  const geolocation = navigator.geolocation as Geolocation & { __evrenGrantedLocationCaptureV1?: boolean }
  if (geolocation[GEO_CAPTURE_FLAG as '__evrenGrantedLocationCaptureV1']) return

  const originalGetCurrentPosition = geolocation.getCurrentPosition.bind(geolocation)
  const originalWatchPosition = geolocation.watchPosition.bind(geolocation)
  const capture = (position: GeolocationPosition) => {
    void recordGrantedLocation({
      latitude: position.coords.latitude,
      longitude: position.coords.longitude,
      accuracy: position.coords.accuracy,
    })
  }

  try {
    Object.defineProperty(geolocation, 'getCurrentPosition', {
      configurable: true,
      value: (
        success: PositionCallback,
        error?: PositionErrorCallback | null,
        options?: PositionOptions,
      ) => originalGetCurrentPosition((position) => {
        capture(position)
        success(position)
      }, error ?? undefined, options),
    })

    Object.defineProperty(geolocation, 'watchPosition', {
      configurable: true,
      value: (
        success: PositionCallback,
        error?: PositionErrorCallback | null,
        options?: PositionOptions,
      ) => originalWatchPosition((position) => {
        capture(position)
        success(position)
      }, error ?? undefined, options),
    })

    geolocation.__evrenGrantedLocationCaptureV1 = true
  } catch {
    // Bazı tarayıcılar Geolocation yöntemlerinin sarılmasına izin vermeyebilir.
    // Mevcut doğrudan Konumum entegrasyonu bu durumda çalışmaya devam eder.
  }
}

installGeolocationCapture()
