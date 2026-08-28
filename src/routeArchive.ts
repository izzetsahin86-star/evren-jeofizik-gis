import type { LiveTrackPoint } from './liveTrackingBridge'

const ROUTE_ARCHIVE_KEY = 'evren-jeofizik-gis-route-archive-v1'
const MAX_ARCHIVE_ROUTES = 20
const MAX_ARCHIVE_POINTS = 20_000

export interface RouteArchiveItem {
  id: string
  name: string
  points: LiveTrackPoint[]
  segmentBreaks: number[]
  startedAt: number
  finishedAt: number
  totalPausedMs: number
  distanceM: number
  rejectedCount: number
}

function validPoints(value: unknown): LiveTrackPoint[] {
  if (!Array.isArray(value)) return []
  return value.filter((point): point is LiveTrackPoint => {
    if (!point || typeof point !== 'object') return false
    const candidate = point as Partial<LiveTrackPoint>
    return Number.isFinite(candidate.lat) && Number.isFinite(candidate.lng)
  })
}

function normalizeItem(value: unknown): RouteArchiveItem | null {
  if (!value || typeof value !== 'object') return null
  const item = value as Partial<RouteArchiveItem>
  const points = validPoints(item.points)
  if (!item.id || !item.name || points.length < 2) return null
  const segmentBreaks = Array.isArray(item.segmentBreaks)
    ? item.segmentBreaks.filter((index) => Number.isInteger(index) && index >= 0 && index < points.length)
    : [0]
  return {
    id: item.id,
    name: item.name,
    points,
    segmentBreaks: segmentBreaks.length ? Array.from(new Set([0, ...segmentBreaks])).sort((a, b) => a - b) : [0],
    startedAt: Number.isFinite(item.startedAt) ? Number(item.startedAt) : Number(points[0].timestamp) || Date.now(),
    finishedAt: Number.isFinite(item.finishedAt) ? Number(item.finishedAt) : Number(points.at(-1)?.timestamp) || Date.now(),
    totalPausedMs: Number.isFinite(item.totalPausedMs) ? Math.max(0, Number(item.totalPausedMs)) : 0,
    distanceM: Number.isFinite(item.distanceM) ? Math.max(0, Number(item.distanceM)) : 0,
    rejectedCount: Number.isFinite(item.rejectedCount) ? Math.max(0, Number(item.rejectedCount)) : 0,
  }
}

export function readRouteArchive(): RouteArchiveItem[] {
  if (typeof window === 'undefined') return []
  try {
    const value = JSON.parse(localStorage.getItem(ROUTE_ARCHIVE_KEY) || '[]') as unknown
    if (!Array.isArray(value)) return []
    return value.map(normalizeItem).filter((item): item is RouteArchiveItem => Boolean(item))
  } catch {
    return []
  }
}

function fitArchive(items: RouteArchiveItem[]) {
  const result: RouteArchiveItem[] = []
  let pointCount = 0
  for (const item of items.slice(0, MAX_ARCHIVE_ROUTES)) {
    if (result.length && pointCount + item.points.length > MAX_ARCHIVE_POINTS) break
    result.push(item)
    pointCount += item.points.length
  }
  return result
}

function persistArchive(items: RouteArchiveItem[]) {
  let candidate = fitArchive(items)
  while (candidate.length) {
    try {
      localStorage.setItem(ROUTE_ARCHIVE_KEY, JSON.stringify(candidate))
      return candidate
    } catch {
      candidate = candidate.slice(0, -1)
    }
  }
  throw new Error('Rota arşivi için cihaz depolama alanı yetersiz.')
}

export function addRouteToArchive(input: Omit<RouteArchiveItem, 'id'>) {
  const item: RouteArchiveItem = {
    ...input,
    id: `route-${input.finishedAt}-${Math.random().toString(36).slice(2, 8)}`,
  }
  const items = persistArchive([item, ...readRouteArchive()])
  return { item, items }
}

export function removeRouteFromArchive(id: string) {
  const items = readRouteArchive().filter((item) => item.id !== id)
  localStorage.setItem(ROUTE_ARCHIVE_KEY, JSON.stringify(items))
  return items
}
