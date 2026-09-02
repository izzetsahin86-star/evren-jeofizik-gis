import { toUtm } from './geo'
import type { GeoPoint } from './types'

export type AdminAccessTarget = {
  id: number
  easting: number
  northing: number
}

export type AdminAccessConfig = {
  version: number
  zone: number
  hemisphere: 'N' | 'S'
  targets: AdminAccessTarget[]
  sequence: number[]
  toleranceMeters: number
  updatedAt: string | null
}

export const DEFAULT_ADMIN_ACCESS_CONFIG: AdminAccessConfig = {
  version: 1,
  zone: 37,
  hemisphere: 'N',
  targets: [
    { id: 1, easting: 371500, northing: 4265500 },
    { id: 2, easting: 371680, northing: 4265630 },
    { id: 3, easting: 371430, northing: 4265790 },
  ],
  sequence: [2, 1, 3],
  toleranceMeters: 18,
  updatedAt: null,
}

const CONFIG_CACHE_KEY = 'evren-jeofizik-admin-access-config-v1'
const SEQUENCE_TIMEOUT_MS = 8_000
let activeConfig: AdminAccessConfig = structuredClone(DEFAULT_ADMIN_ACCESS_CONFIG)

export type AdminAccessSequence = {
  step: number
  startedAt: number
}

export const EMPTY_ADMIN_SEQUENCE: AdminAccessSequence = { step: 0, startedAt: 0 }

function normalizeConfig(value: unknown): AdminAccessConfig | null {
  if (!value || typeof value !== 'object') return null
  const source = value as Partial<AdminAccessConfig>
  if (!Array.isArray(source.targets) || source.targets.length !== 3) return null

  const targets = source.targets.map((target, index) => {
    const id = Number(target?.id)
    const easting = Number(target?.easting)
    const northing = Number(target?.northing)
    if (id !== index + 1 || !Number.isFinite(easting) || !Number.isFinite(northing)) return null
    if (easting < 100000 || easting > 900000 || northing < 0 || northing > 10000000) return null
    return { id, easting, northing }
  })
  if (targets.some((target) => target === null)) return null

  const zone = Number(source.zone)
  const toleranceMeters = Number(source.toleranceMeters)
  const sequence = Array.isArray(source.sequence) ? source.sequence.map(Number) : []
  if (!Number.isInteger(zone) || zone < 1 || zone > 60) return null
  if (source.hemisphere !== 'N' && source.hemisphere !== 'S') return null
  if (!Number.isFinite(toleranceMeters) || toleranceMeters < 1 || toleranceMeters > 100) return null
  if (sequence.length !== 3 || new Set(sequence).size !== 3 || sequence.some((id) => ![1, 2, 3].includes(id))) return null

  return {
    version: Number(source.version) || 1,
    zone,
    hemisphere: source.hemisphere,
    targets: targets as AdminAccessTarget[],
    sequence,
    toleranceMeters,
    updatedAt: typeof source.updatedAt === 'string' ? source.updatedAt : null,
  }
}

export function applyAdminAccessConfig(value: unknown) {
  const normalized = normalizeConfig(value)
  if (!normalized) return false
  activeConfig = normalized
  if (typeof window !== 'undefined') {
    try {
      localStorage.setItem(CONFIG_CACHE_KEY, JSON.stringify(normalized))
    } catch {
      // Gizli giriş her durumda varsayılan ayarlarla çalışmayı sürdürebilir.
    }
  }
  return true
}

export function getAdminAccessConfig() {
  return structuredClone(activeConfig)
}

export async function refreshAdminAccessConfig() {
  if (typeof window === 'undefined') return activeConfig
  try {
    const response = await fetch('/api/access-config', { cache: 'no-store', credentials: 'same-origin' })
    if (!response.ok) return activeConfig
    const payload = await response.json() as { config?: unknown }
    applyAdminAccessConfig(payload.config)
  } catch {
    // Ağ veya kayıt alanı kullanılamazsa son bilinen ayar kullanılmaya devam eder.
  }
  return activeConfig
}

if (typeof window !== 'undefined') {
  try {
    const cached = JSON.parse(localStorage.getItem(CONFIG_CACHE_KEY) || 'null')
    applyAdminAccessConfig(cached)
  } catch {
    // Geçersiz yerel kayıt varsayılan ayarları etkilemez.
  }
  void refreshAdminAccessConfig()
}

function adminTargetId(point: Pick<GeoPoint, 'lat' | 'lng'>) {
  // UTM'deki “37S”, Türkiye için 37. zon + S enlem bandıdır; yarımküre kuzeydir.
  const utm = toUtm(point.lat, point.lng, activeConfig.zone, activeConfig.hemisphere)
  const target = activeConfig.targets.find((candidate) => (
    Math.hypot(utm.easting - candidate.easting, utm.northing - candidate.northing) <= activeConfig.toleranceMeters
  ))
  return target?.id ?? null
}

export function advanceAdminAccess(
  current: AdminAccessSequence,
  point: Pick<GeoPoint, 'lat' | 'lng'>,
  now = Date.now(),
) {
  const targetId = adminTargetId(point)
  const expired = current.step > 0 && now - current.startedAt > SEQUENCE_TIMEOUT_MS
  const state = expired ? EMPTY_ADMIN_SEQUENCE : current
  const sequence = activeConfig.sequence

  if (targetId === null) return { state: EMPTY_ADMIN_SEQUENCE, complete: false }
  if (targetId === sequence[state.step]) {
    const nextStep = state.step + 1
    if (nextStep === sequence.length) return { state: EMPTY_ADMIN_SEQUENCE, complete: true }
    return {
      state: { step: nextStep, startedAt: state.step === 0 ? now : state.startedAt },
      complete: false,
    }
  }

  if (targetId === sequence[0]) {
    return { state: { step: 1, startedAt: now }, complete: false }
  }
  return { state: EMPTY_ADMIN_SEQUENCE, complete: false }
}
