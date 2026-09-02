import crypto from 'node:crypto'
import { clientIp, decodeHeader, finiteNumber, limitedText } from './http.js'
import { deletePrivate, listPrivate, mutatePrivateJson, readPrivateJson, writePrivateJson } from './storage.js'

const LEGACY_VISIT_PREFIX = 'evren-admin/visits/'
const VISIT_PREFIX = 'evren-admin/visits-v2/'
const RATE_PREFIX = 'evren-admin/visit-rate/'
const DAY_PATTERN = /^\d{4}-\d{2}-\d{2}$/
const ID_PATTERN = /^[0-9a-f-]{36}$/i
const LEGACY_PATH_PATTERN = /^evren-admin\/visits\/(\d{4}-\d{2}-\d{2})\.json$/
const VISIT_PATH_PATTERN = /^evren-admin\/visits-v2\/(\d{4}-\d{2}-\d{2})\/([0-9a-f-]{36})\.json$/i

export class VisitRateLimitError extends Error {
  constructor() {
    super('Bu bağlantıdan kısa sürede çok fazla ziyaret kaydı geldi.')
    this.name = 'VisitRateLimitError'
  }
}

function legacyDayPath(day) {
  if (!DAY_PATTERN.test(day)) throw new Error('Geçersiz ziyaret günü.')
  return `${LEGACY_VISIT_PREFIX}${day}.json`
}

function visitPath(day, visitId) {
  if (!DAY_PATTERN.test(day) || !ID_PATTERN.test(visitId)) throw new Error('Geçersiz ziyaret kimliği.')
  return `${VISIT_PREFIX}${day}/${visitId}.json`
}

function ratePath(ip) {
  return `${RATE_PREFIX}${crypto.createHash('sha256').update(ip || 'unknown').digest('hex')}.json`
}

function todayUtc() {
  return new Date().toISOString().slice(0, 10)
}

function hashToken(token) {
  return crypto.createHash('sha256').update(token).digest('hex')
}

function secureTokenMatches(token, expectedHash) {
  if (!token || !expectedHash) return false
  const actual = Buffer.from(hashToken(token), 'hex')
  const expected = Buffer.from(expectedHash, 'hex')
  return actual.length === expected.length && crypto.timingSafeEqual(actual, expected)
}

function approximateLocation(req) {
  return {
    country: limitedText(req.headers['x-vercel-ip-country'], 8),
    region: decodeHeader(req.headers['x-vercel-ip-country-region']),
    city: decodeHeader(req.headers['x-vercel-ip-city']),
    latitude: finiteNumber(req.headers['x-vercel-ip-latitude'], -90, 90),
    longitude: finiteNumber(req.headers['x-vercel-ip-longitude'], -180, 180),
  }
}

function clientDetails(body, req) {
  const screen = body?.screen && typeof body.screen === 'object' ? body.screen : {}
  return {
    page: limitedText(body?.page, 200) || '/',
    referrer: limitedText(body?.referrer, 300),
    language: limitedText(body?.language, 24),
    timezone: limitedText(body?.timezone, 80),
    screen: {
      width: Math.round(finiteNumber(screen.width, 0, 20000) ?? 0),
      height: Math.round(finiteNumber(screen.height, 0, 20000) ?? 0),
      pixelRatio: finiteNumber(screen.pixelRatio, 0.25, 10) ?? 1,
    },
    userAgent: limitedText(req.headers['user-agent'], 500),
  }
}

async function enforceVisitRateLimit(ip) {
  const now = Date.now()
  const oneHour = 60 * 60 * 1000
  try {
    await mutatePrivateJson(ratePath(ip), {
      windowStartedAt: now,
      attempts: 0,
      lastAttemptAt: now,
    }, (document) => {
      const windowStartedAt = Number(document?.windowStartedAt || 0)
      const withinWindow = windowStartedAt > 0 && now - windowStartedAt < oneHour
      const attempts = withinWindow ? Number(document?.attempts || 0) : 0
      if (attempts >= 80) throw new VisitRateLimitError()
      return {
        windowStartedAt: withinWindow ? windowStartedAt : now,
        attempts: attempts + 1,
        lastAttemptAt: now,
      }
    })
  } catch (error) {
    if (error instanceof VisitRateLimitError) throw error
    console.warn('Visitor rate-limit storage unavailable; continuing with visit write.', error)
  }
}

export async function createVisit(req, body) {
  const visitId = crypto.randomUUID()
  const editToken = crypto.randomBytes(24).toString('base64url')
  const visitorId = ID_PATTERN.test(String(body?.visitorId || '')) ? String(body.visitorId) : crypto.randomUUID()
  const startedAt = new Date().toISOString()
  const day = startedAt.slice(0, 10)
  const ip = limitedText(clientIp(req), 80)
  const visit = {
    id: visitId,
    visitorId,
    editTokenHash: hashToken(editToken),
    startedAt,
    lastSeenAt: startedAt,
    endedAt: null,
    durationSeconds: 0,
    ip,
    approximateLocation: approximateLocation(req),
    gps: null,
    ...clientDetails(body, req),
  }

  await enforceVisitRateLimit(ip)
  await writePrivateJson(visitPath(day, visitId), visit, { allowOverwrite: false })

  return { visitId, visitorId, editToken, day }
}

async function updateStandaloneVisit(day, visitId, editToken, updater) {
  let updated = false
  await mutatePrivateJson(visitPath(day, visitId), null, (visit) => {
    if (!visit || typeof visit !== 'object') return visit
    if (visit.id !== visitId || !secureTokenMatches(editToken, visit.editTokenHash)) return visit
    updated = true
    return updater(visit)
  })
  return updated
}

async function updateLegacyVisit(day, visitId, editToken, updater) {
  let updated = false
  await mutatePrivateJson(legacyDayPath(day), { version: 1, day, visits: [] }, (document) => {
    const visits = Array.isArray(document?.visits) ? document.visits : []
    let matched = false
    const nextVisits = visits.map((visit) => {
      if (visit.id !== visitId || !secureTokenMatches(editToken, visit.editTokenHash)) return visit
      matched = true
      updated = true
      return updater(visit)
    })
    return matched ? { ...document, visits: nextVisits } : document
  })
  return updated
}

export async function updateVisit(body, updater) {
  const day = limitedText(body?.day, 10)
  const visitId = limitedText(body?.visitId, 40)
  const editToken = limitedText(body?.editToken, 100)
  if (!DAY_PATTERN.test(day) || !ID_PATTERN.test(visitId) || !editToken) return false

  if (await updateStandaloneVisit(day, visitId, editToken, updater)) return true
  return updateLegacyVisit(day, visitId, editToken, updater)
}

export function gpsUpdate(body) {
  const latitude = finiteNumber(body?.latitude, -90, 90)
  const longitude = finiteNumber(body?.longitude, -180, 180)
  const accuracy = finiteNumber(body?.accuracy, 0, 100000)
  if (latitude === null || longitude === null || accuracy === null) return null
  const now = new Date().toISOString()
  return {
    latitude,
    longitude,
    accuracy,
    grantedAt: now,
  }
}

export function activityUpdate(visit, ended) {
  const now = new Date()
  const started = new Date(visit.startedAt)
  const durationSeconds = Number.isFinite(started.getTime())
    ? Math.max(0, Math.min(86_400, Math.round((now.getTime() - started.getTime()) / 1000)))
    : 0
  return {
    ...visit,
    lastSeenAt: now.toISOString(),
    durationSeconds,
    endedAt: ended ? now.toISOString() : null,
  }
}

async function readDocuments(blobs) {
  const documents = []
  for (let index = 0; index < blobs.length; index += 12) {
    const batch = blobs.slice(index, index + 12)
    const results = await Promise.allSettled(batch.map((blob) => readPrivateJson(blob.pathname)))
    results.forEach((result) => {
      if (result.status === 'fulfilled' && result.value?.data) documents.push(result.value.data)
    })
  }
  return documents
}

function inSelectedPeriod(day, cutoffDay) {
  return DAY_PATTERN.test(day) && day >= cutoffDay && day <= todayUtc()
}

export async function listVisits(days = 90) {
  const safeDays = Math.max(1, Math.min(180, Math.round(Number(days) || 90)))
  const cutoff = new Date()
  cutoff.setUTCDate(cutoff.getUTCDate() - safeDays + 1)
  const cutoffDay = cutoff.toISOString().slice(0, 10)

  const [standaloneBlobs, legacyBlobs] = await Promise.all([
    listPrivate(VISIT_PREFIX),
    listPrivate(LEGACY_VISIT_PREFIX),
  ])

  const selectedStandalone = standaloneBlobs
    .filter((blob) => {
      const match = VISIT_PATH_PATTERN.exec(blob.pathname)
      return Boolean(match && inSelectedPeriod(match[1], cutoffDay))
    })
    .sort((a, b) => b.pathname.localeCompare(a.pathname))

  const selectedLegacy = legacyBlobs
    .filter((blob) => {
      const match = LEGACY_PATH_PATTERN.exec(blob.pathname)
      return Boolean(match && inSelectedPeriod(match[1], cutoffDay))
    })
    .sort((a, b) => b.pathname.localeCompare(a.pathname))

  const [standaloneDocuments, legacyDocuments] = await Promise.all([
    readDocuments(selectedStandalone),
    readDocuments(selectedLegacy),
  ])

  const combined = [
    ...standaloneDocuments.filter((visit) => visit && typeof visit === 'object' && ID_PATTERN.test(String(visit.id || ''))),
    ...legacyDocuments.flatMap((document) => Array.isArray(document?.visits) ? document.visits : []),
  ]

  const unique = new Map()
  combined.forEach((visit) => {
    if (!visit || typeof visit !== 'object') return
    const id = String(visit.id || '')
    if (!ID_PATTERN.test(id)) return
    if (!unique.has(id)) unique.set(id, visit)
  })

  const visits = Array.from(unique.values())
    .sort((a, b) => String(b.startedAt).localeCompare(String(a.startedAt)))
    .slice(0, 1500)

  const counts = new Map()
  visits.forEach((visit) => counts.set(visit.visitorId, (counts.get(visit.visitorId) || 0) + 1))
  return visits.map(({ editTokenHash: _privateToken, ...visit }) => ({
    ...visit,
    visitorVisitCount: counts.get(visit.visitorId) || 1,
  }))
}

async function deletePaths(pathnames) {
  for (let index = 0; index < pathnames.length; index += 12) {
    await Promise.all(pathnames.slice(index, index + 12).map((pathname) => deletePrivate(pathname)))
  }
}

export async function deleteVisitsByIds(ids) {
  const wanted = new Set((Array.isArray(ids) ? ids : [])
    .map((id) => String(id || ''))
    .filter((id) => ID_PATTERN.test(id))
    .slice(0, 500))
  if (!wanted.size) return { deleted: 0 }

  const [standaloneBlobs, legacyBlobs] = await Promise.all([
    listPrivate(VISIT_PREFIX),
    listPrivate(LEGACY_VISIT_PREFIX),
  ])

  const standalonePaths = standaloneBlobs.flatMap((blob) => {
    const match = VISIT_PATH_PATTERN.exec(blob.pathname)
    return match && wanted.has(match[2]) ? [blob.pathname] : []
  })
  await deletePaths(standalonePaths)

  let legacyDeleted = 0
  for (const blob of legacyBlobs) {
    if (!LEGACY_PATH_PATTERN.test(blob.pathname)) continue
    await mutatePrivateJson(blob.pathname, null, (document) => {
      if (!document || !Array.isArray(document.visits)) return document
      const nextVisits = document.visits.filter((visit) => {
        const remove = wanted.has(String(visit?.id || ''))
        if (remove) legacyDeleted += 1
        return !remove
      })
      return nextVisits.length === document.visits.length ? document : { ...document, visits: nextVisits }
    })
  }

  return { deleted: standalonePaths.length + legacyDeleted }
}

export async function deleteAllVisits() {
  const [standaloneBlobs, legacyBlobs] = await Promise.all([
    listPrivate(VISIT_PREFIX),
    listPrivate(LEGACY_VISIT_PREFIX),
  ])
  const paths = [
    ...standaloneBlobs.filter((blob) => VISIT_PATH_PATTERN.test(blob.pathname)).map((blob) => blob.pathname),
    ...legacyBlobs.filter((blob) => LEGACY_PATH_PATTERN.test(blob.pathname)).map((blob) => blob.pathname),
  ]
  await deletePaths(paths)
  return { deletedFiles: paths.length }
}
