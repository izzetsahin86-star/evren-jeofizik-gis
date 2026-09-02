const VISITOR_KEY = 'evren-jeofizik-anonymous-visitor-v1'

type VisitSession = {
  visitId: string
  visitorId: string
  editToken: string
  day: string
}

let currentSession: VisitSession | null = null
let startPromise: Promise<VisitSession | null> | null = null
let lifecycleInstalled = false

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
  if (startPromise) return startPromise
  startPromise = post('/api/visits/start', {
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

export async function recordGrantedLocation(location: { latitude: number; longitude: number; accuracy: number }) {
  const session = currentSession || await startVisitorTracking()
  if (!session) return
  await post('/api/visits/location', {
    ...sessionPayload(session),
    latitude: location.latitude,
    longitude: location.longitude,
    accuracy: location.accuracy,
  }).catch(() => undefined)
}
