import type { GeoPoint } from './types'

export type CoordinateIssueType = 'duplicate' | 'zone' | 'swapped' | 'distance' | 'intersection'

export interface CoordinateIssue {
  id: string
  type: CoordinateIssueType
  title: string
  description: string
  target: Pick<GeoPoint, 'lat' | 'lng'>
  pointId?: string
  relatedPointId?: string
  canDelete?: boolean
  canSwap?: boolean
}

const EARTH_RADIUS_M = 6_371_008.8

function distanceMeters(a: Pick<GeoPoint, 'lat' | 'lng'>, b: Pick<GeoPoint, 'lat' | 'lng'>) {
  const toRad = (value: number) => value * Math.PI / 180
  const dLat = toRad(b.lat - a.lat)
  const dLng = toRad(b.lng - a.lng)
  const lat1 = toRad(a.lat)
  const lat2 = toRad(b.lat)
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLng / 2) ** 2
  return 2 * EARTH_RADIUS_M * Math.asin(Math.min(1, Math.sqrt(h)))
}

function zoneForLongitude(lng: number) {
  return Math.max(1, Math.min(60, Math.floor((lng + 180) / 6) + 1))
}

function median(values: number[]) {
  if (!values.length) return 0
  const sorted = [...values].sort((a, b) => a - b)
  const middle = Math.floor(sorted.length / 2)
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2
}

function orientation(a: GeoPoint, b: GeoPoint, c: GeoPoint) {
  const value = (b.lng - a.lng) * (c.lat - a.lat) - (b.lat - a.lat) * (c.lng - a.lng)
  return Math.abs(value) < 1e-12 ? 0 : value > 0 ? 1 : -1
}

function onSegment(a: GeoPoint, b: GeoPoint, c: GeoPoint) {
  return b.lng <= Math.max(a.lng, c.lng) + 1e-12 && b.lng >= Math.min(a.lng, c.lng) - 1e-12
    && b.lat <= Math.max(a.lat, c.lat) + 1e-12 && b.lat >= Math.min(a.lat, c.lat) - 1e-12
}

function segmentsIntersect(a: GeoPoint, b: GeoPoint, c: GeoPoint, d: GeoPoint) {
  const o1 = orientation(a, b, c)
  const o2 = orientation(a, b, d)
  const o3 = orientation(c, d, a)
  const o4 = orientation(c, d, b)
  if (o1 !== o2 && o3 !== o4) return true
  if (o1 === 0 && onSegment(a, c, b)) return true
  if (o2 === 0 && onSegment(a, d, b)) return true
  if (o3 === 0 && onSegment(c, a, d)) return true
  return o4 === 0 && onSegment(c, b, d)
}

function formatDistance(value: number) {
  return value >= 1000 ? `${(value / 1000).toFixed(1)} km` : `${Math.round(value)} m`
}

export function validateCoordinates(points: GeoPoint[], expectedZone: number): CoordinateIssue[] {
  const issues: CoordinateIssue[] = []
  const swappedIds = new Set<string>()
  const duplicateIds = new Set<string>()

  points.forEach((point, index) => {
    const earlier = points.slice(0, index).find((candidate) => distanceMeters(point, candidate) <= 0.5)
    if (earlier) {
      duplicateIds.add(point.id)
      issues.push({
        id: `duplicate-${point.id}`,
        type: 'duplicate',
        title: `Tekrarlanan nokta · ${index + 1}`,
        description: 'Bu koordinat daha önce eklenmiş. Yinelenen kaydı silebilirsiniz.',
        target: point,
        pointId: point.id,
        relatedPointId: earlier.id,
        canDelete: true,
      })
    }
  })

  if (points.length >= 2) {
    points.forEach((point, index) => {
      if (Math.abs(point.lng) > 90) return
      const others = points.filter((candidate) => candidate.id !== point.id)
      const normalNearest = Math.min(...others.map((candidate) => distanceMeters(point, candidate)))
      const swapped = { lat: point.lng, lng: point.lat }
      if (Math.abs(swapped.lat) > 90 || Math.abs(swapped.lng) > 180) return
      const swappedNearest = Math.min(...others.map((candidate) => distanceMeters(swapped, candidate)))
      if (normalNearest > 20_000 && swappedNearest < 20_000 && normalNearest > swappedNearest * 5) {
        swappedIds.add(point.id)
        issues.push({
          id: `swapped-${point.id}`,
          type: 'swapped',
          title: `Enlem–boylam ters olabilir · ${index + 1}`,
          description: `Ters çevrildiğinde en yakın noktaya uzaklık ${formatDistance(swappedNearest)} oluyor.`,
          target: point,
          pointId: point.id,
          canSwap: true,
        })
      }
    })
  }

  points.forEach((point, index) => {
    if (swappedIds.has(point.id)) return
    const actualZone = zoneForLongitude(point.lng)
    if (actualZone !== expectedZone) {
      issues.push({
        id: `zone-${point.id}`,
        type: 'zone',
        title: `UTM zonu uyuşmuyor · ${index + 1}`,
        description: `Nokta Zone ${actualZone} içinde; seçili varsayılan Zone ${expectedZone}.`,
        target: point,
        pointId: point.id,
      })
    }
  })

  if (points.length >= 3) {
    const edges = points.map((point, index) => ({
      from: point,
      to: points[(index + 1) % points.length],
      index,
      distance: distanceMeters(point, points[(index + 1) % points.length]),
    }))
    const typical = median(edges.map((edge) => edge.distance))
    const threshold = Math.max(points.length < 4 ? 100_000 : 20_000, typical * 8)
    edges.forEach((edge) => {
      if (edge.distance <= threshold || swappedIds.has(edge.from.id) || swappedIds.has(edge.to.id)) return
      issues.push({
        id: `distance-${edge.from.id}-${edge.to.id}`,
        type: 'distance',
        title: `Sıra dışı mesafe · ${edge.index + 1}–${(edge.index + 1) % points.length + 1}`,
        description: `Ardışık noktalar arasındaki mesafe ${formatDistance(edge.distance)}.`,
        target: { lat: (edge.from.lat + edge.to.lat) / 2, lng: (edge.from.lng + edge.to.lng) / 2 },
        pointId: edge.from.id,
        relatedPointId: edge.to.id,
      })
    })

    for (let first = 0; first < edges.length; first += 1) {
      for (let second = first + 1; second < edges.length; second += 1) {
        const adjacent = second === first + 1 || (first === 0 && second === edges.length - 1)
        if (adjacent) continue
        const a = edges[first]
        const b = edges[second]
        if ([a.from.id, a.to.id, b.from.id, b.to.id].some((id) => duplicateIds.has(id))) continue
        if (!segmentsIntersect(a.from, a.to, b.from, b.to)) continue
        issues.push({
          id: `intersection-${first}-${second}`,
          type: 'intersection',
          title: `Kesişen poligon kenarları · ${first + 1} ve ${second + 1}`,
          description: 'Poligon kendi üzerine kesişiyor. Nokta sırasını kontrol edin.',
          target: { lat: (a.from.lat + a.to.lat + b.from.lat + b.to.lat) / 4, lng: (a.from.lng + a.to.lng + b.from.lng + b.to.lng) / 4 },
        })
      }
    }
  }

  return issues
}
