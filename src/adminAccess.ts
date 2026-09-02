import { toUtm } from './geo'
import type { GeoPoint } from './types'

const ADMIN_TARGETS = [
  { id: 1, easting: 371500, northing: 4265500 },
  { id: 2, easting: 371680, northing: 4265630 },
  { id: 3, easting: 371430, northing: 4265790 },
] as const

const ADMIN_SEQUENCE = [2, 1, 3] as const
const TARGET_TOLERANCE_METERS = 18
const SEQUENCE_TIMEOUT_MS = 8_000

export type AdminAccessSequence = {
  step: number
  startedAt: number
}

export const EMPTY_ADMIN_SEQUENCE: AdminAccessSequence = { step: 0, startedAt: 0 }

function adminTargetId(point: Pick<GeoPoint, 'lat' | 'lng'>) {
  // UTM'deki “37S”, Türkiye için 37. zon + S enlem bandıdır; yarımküre kuzeydir.
  const utm = toUtm(point.lat, point.lng, 37, 'N')
  const target = ADMIN_TARGETS.find((candidate) => (
    Math.hypot(utm.easting - candidate.easting, utm.northing - candidate.northing) <= TARGET_TOLERANCE_METERS
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

  if (targetId === null) return { state: EMPTY_ADMIN_SEQUENCE, complete: false }
  if (targetId === ADMIN_SEQUENCE[state.step]) {
    const nextStep = state.step + 1
    if (nextStep === ADMIN_SEQUENCE.length) return { state: EMPTY_ADMIN_SEQUENCE, complete: true }
    return {
      state: { step: nextStep, startedAt: state.step === 0 ? now : state.startedAt },
      complete: false,
    }
  }

  if (targetId === ADMIN_SEQUENCE[0]) {
    return { state: { step: 1, startedAt: now }, complete: false }
  }
  return { state: EMPTY_ADMIN_SEQUENCE, complete: false }
}
