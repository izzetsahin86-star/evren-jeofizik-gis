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

// Legacy coordinate-based admin access has been retired.
// The exported shape remains temporarily for compatibility with older,
// unmounted settings code, but it can no longer open the admin portal.
export const DEFAULT_ADMIN_ACCESS_CONFIG: AdminAccessConfig = {
  version: 2,
  zone: 37,
  hemisphere: 'N',
  targets: [],
  sequence: [],
  toleranceMeters: 0,
  updatedAt: null,
}

export type AdminAccessSequence = {
  step: number
  startedAt: number
}

export const EMPTY_ADMIN_SEQUENCE: AdminAccessSequence = { step: 0, startedAt: 0 }

export function applyAdminAccessConfig(_value: unknown) {
  return false
}

export function getAdminAccessConfig() {
  return structuredClone(DEFAULT_ADMIN_ACCESS_CONFIG)
}

export async function refreshAdminAccessConfig() {
  return getAdminAccessConfig()
}

export function advanceAdminAccess(
  _current: AdminAccessSequence,
  _point: { lat: number; lng: number },
  _now = Date.now(),
) {
  return { state: EMPTY_ADMIN_SEQUENCE, complete: false }
}
