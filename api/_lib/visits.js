import crypto from 'node:crypto'
import { clientIp, decodeHeader, finiteNumber, limitedText } from './http.js'
import { listPrivate, mutatePrivateJson, readPrivateJson } from './storage.js'

const VISIT_PREFIX = 'evren-admin/visits/'
const DAY_PATTERN = /^\d{4}-\d{2}-\d{2}$/
const ID_PATTERN = /^[0-9a-f-]{36}$/i

export class VisitRateLimitError extends Error {
  constructor() {
    super('Bu bağlantıdan kısa sürede çok fazla ziyaret kaydı geldi.')
    this.name = 'VisitRateLimitError'
  }
}

function dayPath(day) {
  if (!DAY_PATTERN.test(day)) throw new Error('Geçersiz ziyaret günü.')
  return `${VISIT_PREFIX}${day}.json`
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

export async function createVisit(req, body) {
  const visitId = crypto.randomUUID()
  const editToken = crypto.randomBytes(24).toString('base64url')
  const visitorId = ID_PATTERN.test(String(body?.visitorId || '')) ? String(body.visitorId) : crypto.randomUUID()
  const startedAt = new Date().toISOString()
  const day = startedAt.slice(0, 10)
  const visit = {
    id: visitId,
    visitorId,
    editTokenHash: hashToken(editToken),
    startedAt,
    lastSeenAt: startedAt,
    endedAt: null,
    durationSeconds: 0,
    ip: limitedText(clientIp(req), 80),
    approximateLocation: approximateLocation(req),
    gps: null,
    ...clientDetails(body, req),
  }

  await mutatePrivateJson(dayPath(day), { version: 1, day, visits: [] }, (document) => {
    const visits = Array.isArray(document.visits) ? document.visits : []
    const oneHourAgo = Date.now() - 60 * 60 * 1000
    const recentFromIp = visits.filter((item) => item.ip === visit.ip && new Date(item.startedAt).getTime() >= oneHourAgo).length
    if (recentFromIp >= 80) throw new VisitRateLimitError()
    return { version: 1, day, visits: [...visits, visit] }
  })

  return { visitId, visitorId, editToken, day }
}

export async function updateVisit(body, updater) {
  const day = limitedText(body?.day, 10)
  const visitId = limitedText(body?.visitId, 40)
  const editToken = limitedText(body?.editToken, 100)
  if (!DAY_PATTERN.test(day) || !ID_PATTERN.test(visitId) || !editToken) return false

  let updated = false
  await mutatePrivateJson(dayPath(day), { version: 1, day, visits: [] }, (document) => {
    const visits = Array.isArray(document.visits) ? document.visits : []
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
  for (let index = 0; index < blobs.length; index += 8) {
    const batch = blobs.slice(index, index + 8)
    const results = await Promise.allSettled(batch.map((blob) => readPrivateJson(blob.pathname)))
    results.forEach((result) => {
      if (result.status === 'fulfilled' && result.value?.data) documents.push(result.value.data)
    })
  }
  return documents
}

export async function listVisits(days = 90) {
  const safeDays = Math.max(1, Math.min(180, Math.round(Number(days) || 90)))
  const cutoff = new Date()
  cutoff.setUTCDate(cutoff.getUTCDate() - safeDays + 1)
  const cutoffDay = cutoff.toISOString().slice(0, 10)
  const blobs = (await listPrivate(VISIT_PREFIX))
    .filter((blob) => {
      const day = blob.pathname.slice(VISIT_PREFIX.length, -5)
      return DAY_PATTERN.test(day) && day >= cutoffDay && day <= todayUtc()
    })
    .sort((a, b) => b.pathname.localeCompare(a.pathname))

  const documents = await readDocuments(blobs)
  const visits = documents
    .flatMap((document) => Array.isArray(document.visits) ? document.visits : [])
    .filter((visit) => visit && typeof visit === 'object')
    .sort((a, b) => String(b.startedAt).localeCompare(String(a.startedAt)))
    .slice(0, 1500)

  const counts = new Map()
  visits.forEach((visit) => counts.set(visit.visitorId, (counts.get(visit.visitorId) || 0) + 1))
  return visits.map(({ editTokenHash: _privateToken, ...visit }) => ({
    ...visit,
    visitorVisitCount: counts.get(visit.visitorId) || 1,
  }))
}
