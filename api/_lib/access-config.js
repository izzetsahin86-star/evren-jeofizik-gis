import { readPrivateJson, writePrivateJson } from './storage.js'

const ACCESS_CONFIG_PATH = 'evren-admin/config/access.json'
const TARGET_TOLERANCE_METERS = 18

export const DEFAULT_ADMIN_ACCESS_CONFIG = {
  version: 1,
  zone: 37,
  hemisphere: 'N',
  targets: [
    { id: 1, easting: 371500, northing: 4265500 },
    { id: 2, easting: 371680, northing: 4265630 },
    { id: 3, easting: 371430, northing: 4265790 },
  ],
  sequence: [2, 1, 3],
  toleranceMeters: TARGET_TOLERANCE_METERS,
  updatedAt: null,
}

export class AccessConfigValidationError extends Error {
  constructor(message) {
    super(message)
    this.name = 'AccessConfigValidationError'
  }
}

function finiteCoordinate(value, minimum, maximum) {
  const number = Number(value)
  return Number.isFinite(number) && number >= minimum && number <= maximum ? number : null
}

function normalizeTargets(value) {
  if (!Array.isArray(value) || value.length !== 3) {
    throw new AccessConfigValidationError('Tam olarak üç gizli giriş noktası gerekli.')
  }

  const targets = value.map((target, index) => {
    const id = Number(target?.id)
    const easting = finiteCoordinate(target?.easting, 100000, 900000)
    const northing = finiteCoordinate(target?.northing, 0, 10000000)
    if (id !== index + 1 || easting === null || northing === null) {
      throw new AccessConfigValidationError(`Nokta ${index + 1} koordinatları geçerli değil.`)
    }
    return { id, easting, northing }
  })

  for (let left = 0; left < targets.length; left += 1) {
    for (let right = left + 1; right < targets.length; right += 1) {
      const distance = Math.hypot(
        targets[left].easting - targets[right].easting,
        targets[left].northing - targets[right].northing,
      )
      if (distance <= TARGET_TOLERANCE_METERS * 2) {
        throw new AccessConfigValidationError('Gizli giriş noktaları birbirinden en az 36 metre uzakta olmalı.')
      }
    }
  }

  return targets
}

function normalizeStoredConfig(value) {
  try {
    return {
      ...DEFAULT_ADMIN_ACCESS_CONFIG,
      targets: normalizeTargets(value?.targets),
      updatedAt: typeof value?.updatedAt === 'string' ? value.updatedAt : null,
    }
  } catch {
    return null
  }
}

export async function readAdminAccessConfig() {
  try {
    const stored = await readPrivateJson(ACCESS_CONFIG_PATH)
    return normalizeStoredConfig(stored?.data) || structuredClone(DEFAULT_ADMIN_ACCESS_CONFIG)
  } catch {
    return structuredClone(DEFAULT_ADMIN_ACCESS_CONFIG)
  }
}

export async function saveAdminAccessConfig(targets) {
  const normalizedTargets = normalizeTargets(targets)
  const config = {
    ...DEFAULT_ADMIN_ACCESS_CONFIG,
    targets: normalizedTargets,
    updatedAt: new Date().toISOString(),
  }
  await writePrivateJson(ACCESS_CONFIG_PATH, config)
  return config
}
