import {
  area as turfArea,
  bearing as turfBearing,
  bbox as turfBbox,
  centroid as turfCentroid,
  distance as turfDistance,
  length as turfLength,
  pointGrid,
  polygon as turfPolygon,
} from '@turf/turf'
import proj4 from 'proj4'
import type { AnalysisResult, CoordinateFormat, GeoPoint, PolygonLayer } from './types'

export const MAP_CENTER: [number, number] = [39.9255, 32.8663]
export const POLYGON_COLORS = ['#1597e5', '#7c3aed', '#f59e0b', '#10b981', '#ef4444', '#ec4899']
export const DEFAULT_POLYGON_APPEARANCE = {
  strokeWidth: 3,
  strokeOpacity: 1,
  fillOpacity: 0.14,
}

export function uid(prefix = 'id') {
  return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`
}

export function formatNumber(value: number, maxDigits = 2) {
  return new Intl.NumberFormat('tr-TR', { maximumFractionDigits: maxDigits }).format(value)
}

export function formatAreaShort(areaM2: number) {
  if (!areaM2) return '0 m²'
  if (areaM2 >= 1_000_000) return `${formatNumber(areaM2 / 1_000_000, 2)} km²`
  if (areaM2 >= 10_000) return `${formatNumber(areaM2 / 10_000, 1)} Hektar`
  if (areaM2 >= 1_000) return `${formatNumber(areaM2 / 1_000, 1)} Dekar`
  return `${formatNumber(areaM2, 1)} m²`
}

function utmDefinition(zone: number, hemisphere: 'N' | 'S', datum = 'WGS84') {
  const south = hemisphere === 'S' ? '+south' : ''
  const datumDef = datum === 'ED50'
    ? '+ellps=intl +towgs84=-87,-98,-121,0,0,0,0'
    : '+datum=WGS84'
  return `+proj=utm +zone=${zone} ${south} ${datumDef} +units=m +no_defs`
}

export function utmZoneForLng(lng: number) {
  return Math.max(1, Math.min(60, Math.floor((lng + 180) / 6) + 1))
}

export function utmLatitudeBand(lat: number) {
  const bands = 'CDEFGHJKLMNPQRSTUVWX'
  const boundedLatitude = Math.max(-80, Math.min(84, lat))
  if (boundedLatitude >= 72) return 'X'
  return bands[Math.floor((boundedLatitude + 80) / 8)]
}

export function toUtm(lat: number, lng: number, zone = utmZoneForLng(lng), hemisphere: 'N' | 'S' = lat >= 0 ? 'N' : 'S', datum = 'WGS84') {
  const [easting, northing] = proj4('EPSG:4326', utmDefinition(zone, hemisphere, datum), [lng, lat])
  return { zone, hemisphere, easting, northing }
}

export function fromUtm(easting: number, northing: number, zone: number, hemisphere: 'N' | 'S', datum = 'WGS84') {
  const [lng, lat] = proj4(utmDefinition(zone, hemisphere, datum), 'EPSG:4326', [easting, northing])
  return { lat, lng }
}

export function toDms(value: number, axis: 'lat' | 'lng') {
  const abs = Math.abs(value)
  const deg = Math.floor(abs)
  const minutesFloat = (abs - deg) * 60
  const min = Math.floor(minutesFloat)
  const sec = (minutesFloat - min) * 60
  const hemi = axis === 'lat' ? (value >= 0 ? 'N' : 'S') : (value >= 0 ? 'E' : 'W')
  return `${deg}° ${min}' ${sec.toFixed(2)}" ${hemi}`
}

export function toDdm(value: number, axis: 'lat' | 'lng') {
  const abs = Math.abs(value)
  const deg = Math.floor(abs)
  const min = (abs - deg) * 60
  const hemi = axis === 'lat' ? (value >= 0 ? 'N' : 'S') : (value >= 0 ? 'E' : 'W')
  return `${deg}° ${min.toFixed(5)}' ${hemi}`
}

function numbersFrom(value: string) {
  return value.match(/[-+]?\d+(?:[.,]\d+)?/g)?.map((part) => Number(part.replace(',', '.'))) ?? []
}

function signedByHemisphere(value: number, hemisphere?: string) {
  return hemisphere && /[SW]/i.test(hemisphere) ? -Math.abs(value) : Math.abs(value)
}

export function parseCoordinate(value: string, format: CoordinateFormat, defaults: { zone: number; hemisphere: 'N' | 'S'; datum: string }): Omit<GeoPoint, 'id'> | null {
  const nums = numbersFrom(value)
  if (format === 'utm') {
    if (nums.length < 2) return null
    const hasZone = nums.length >= 3 && nums[0] >= 1 && nums[0] <= 60
    const zone = hasZone ? nums[0] : defaults.zone
    const easting = hasZone ? nums[1] : nums[0]
    const northing = hasZone ? nums[2] : nums[1]
    if (!Number.isFinite(easting) || !Number.isFinite(northing)) return null
    const hemiMatch = value.match(/\b([NS])\b/i)
    const hemisphere = (hemiMatch?.[1]?.toUpperCase() as 'N' | 'S' | undefined) ?? defaults.hemisphere
    return fromUtm(easting, northing, zone, hemisphere, defaults.datum)
  }
  if (format === 'latlon') {
    if (nums.length < 2) return null
    const lat = nums[0]
    const lng = nums[1]
    if (Math.abs(lat) > 90 || Math.abs(lng) > 180) return null
    return { lat, lng }
  }
  const hemispheres = value.match(/[NSEW]/gi) ?? []
  if (format === 'dms' && nums.length >= 6) {
    const lat = signedByHemisphere(nums[0] + nums[1] / 60 + nums[2] / 3600, hemispheres.find((h) => /[NS]/i.test(h)))
    const lng = signedByHemisphere(nums[3] + nums[4] / 60 + nums[5] / 3600, hemispheres.find((h) => /[EW]/i.test(h)))
    return { lat, lng }
  }
  if (format === 'ddm' && nums.length >= 4) {
    const lat = signedByHemisphere(nums[0] + nums[1] / 60, hemispheres.find((h) => /[NS]/i.test(h)))
    const lng = signedByHemisphere(nums[2] + nums[3] / 60, hemispheres.find((h) => /[EW]/i.test(h)))
    return { lat, lng }
  }
  return null
}

export function formatPoint(point: GeoPoint, format: CoordinateFormat, zone = utmZoneForLng(point.lng), datum = 'WGS84') {
  if (format === 'latlon') return `${point.lat.toFixed(6)}, ${point.lng.toFixed(6)}`
  if (format === 'dms') return `${toDms(point.lat, 'lat')}  ${toDms(point.lng, 'lng')}`
  if (format === 'ddm') return `${toDdm(point.lat, 'lat')}  ${toDdm(point.lng, 'lng')}`
  const utm = toUtm(point.lat, point.lng, zone, point.lat >= 0 ? 'N' : 'S', datum)
  return `${utm.zone}${utm.hemisphere} ${utm.easting.toFixed(2)} ${utm.northing.toFixed(2)}`
}

export function analyzePolygon(points: GeoPoint[]): AnalysisResult {
  if (points.length === 0) return { areaM2: 0, perimeterM: 0, centroid: null, edgeLengths: [], edgeBearings: [] }
  const edgeLengths: number[] = []
  const edgeBearings: number[] = []
  const edgeCount = points.length >= 3 ? points.length : points.length - 1
  for (let index = 0; index < edgeCount; index += 1) {
    const a = points[index]
    const b = points[(index + 1) % points.length]
    edgeLengths.push(turfDistance([a.lng, a.lat], [b.lng, b.lat], { units: 'meters' }))
    edgeBearings.push((turfBearing([a.lng, a.lat], [b.lng, b.lat]) + 360) % 360)
  }
  if (points.length < 3) {
    return { areaM2: 0, perimeterM: edgeLengths.reduce((sum, value) => sum + value, 0), centroid: { id: 'centroid', lat: points[0].lat, lng: points[0].lng }, edgeLengths, edgeBearings }
  }
  const ring = [...points.map((p) => [p.lng, p.lat] as [number, number]), [points[0].lng, points[0].lat] as [number, number]]
  const polygon = turfPolygon([ring])
  const center = turfCentroid(polygon).geometry.coordinates
  return {
    areaM2: turfArea(polygon),
    perimeterM: turfLength(polygon, { units: 'meters' }),
    centroid: { id: 'centroid', lat: center[1], lng: center[0] },
    edgeLengths,
    edgeBearings,
  }
}

export function pointDistance(a?: GeoPoint, b?: GeoPoint) {
  if (!a || !b || a.id === b.id) return null
  return turfDistance([a.lng, a.lat], [b.lng, b.lat], { units: 'meters' })
}

export function pointBearing(a?: GeoPoint, b?: GeoPoint) {
  if (!a || !b || a.id === b.id) return null
  return (turfBearing([a.lng, a.lat], [b.lng, b.lat]) + 360) % 360
}

export function deltaEastNorth(a?: GeoPoint, b?: GeoPoint) {
  if (!a || !b || a.id === b.id) return null
  const zone = utmZoneForLng((a.lng + b.lng) / 2)
  const hemisphere: 'N' | 'S' = (a.lat + b.lat) / 2 >= 0 ? 'N' : 'S'
  const from = toUtm(a.lat, a.lng, zone, hemisphere)
  const to = toUtm(b.lat, b.lng, zone, hemisphere)
  return { east: to.easting - from.easting, north: to.northing - from.northing }
}

export function generateDesGrid(points: GeoPoint[], spacingM: number, prefix: string) {
  if (points.length < 3 || spacingM <= 0) return []
  const ring = [...points.map((p) => [p.lng, p.lat] as [number, number]), [points[0].lng, points[0].lat] as [number, number]]
  const mask = turfPolygon([ring])
  const grid = pointGrid(turfBbox(mask), spacingM / 1000, { units: 'kilometers', mask })
  const match = prefix.match(/^(.*?)(\d+)$/)
  const label = match?.[1] || prefix || 'DES'
  const start = Number(match?.[2] ?? 1)
  return grid.features.slice(0, 5000).map((feature, index) => ({
    id: uid('des'),
    lng: feature.geometry.coordinates[0],
    lat: feature.geometry.coordinates[1],
    name: `${label}${start + index}`,
  }))
}

function xmlEscape(value: string) {
  return value.replace(/[<>&'"]/g, (char) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', "'": '&apos;', '"': '&quot;' })[char]!)
}

export function polygonsToKml(polygons: PolygonLayer[]) {
  const placemarks = polygons.map((layer) => {
    const coordinates = layer.points.map((p) => `${p.lng},${p.lat},0`).join(' ')
    const ring = layer.points.length ? `${coordinates} ${layer.points[0].lng},${layer.points[0].lat},0` : coordinates
    const des = layer.desPoints.map((p) => `<Placemark><name>${xmlEscape(p.name || 'DES')}</name><Point><coordinates>${p.lng},${p.lat},0</coordinates></Point></Placemark>`).join('')
    const geometry = layer.points.length >= 3
      ? `<Polygon><outerBoundaryIs><LinearRing><coordinates>${ring}</coordinates></LinearRing></outerBoundaryIs></Polygon>`
      : `<LineString><coordinates>${coordinates}</coordinates></LineString>`
    return `<Folder><name>${xmlEscape(layer.name)}</name><Placemark><name>${xmlEscape(layer.name)}</name>${geometry}</Placemark>${des}</Folder>`
  }).join('')
  return `<?xml version="1.0" encoding="UTF-8"?><kml xmlns="http://www.opengis.net/kml/2.2"><Document><name>Evren Jeofizik</name>${placemarks}</Document></kml>`
}

export function polygonsToGeoJson(polygons: PolygonLayer[]) {
  return {
    type: 'FeatureCollection',
    features: polygons.filter((layer) => layer.points.length).map((layer) => ({
      type: 'Feature',
      properties: {
        id: layer.id,
        name: layer.name,
        color: layer.color,
        strokeWidth: layer.strokeWidth ?? DEFAULT_POLYGON_APPEARANCE.strokeWidth,
        strokeOpacity: layer.strokeOpacity ?? DEFAULT_POLYGON_APPEARANCE.strokeOpacity,
        fillOpacity: layer.fillOpacity ?? DEFAULT_POLYGON_APPEARANCE.fillOpacity,
      },
      geometry: layer.points.length >= 3
        ? { type: 'Polygon', coordinates: [[...layer.points.map((p) => [p.lng, p.lat]), [layer.points[0].lng, layer.points[0].lat]]] }
        : { type: 'LineString', coordinates: layer.points.map((p) => [p.lng, p.lat]) },
    })),
  }
}

function coordinatesFromText(text: string) {
  return text.trim().split(/\s+/).map((pair) => {
    const [lng, lat] = pair.split(',').map(Number)
    return { id: uid('pt'), lat, lng }
  }).filter((point) => Number.isFinite(point.lat) && Number.isFinite(point.lng))
}

export function parseKml(text: string): PolygonLayer[] {
  const xml = new DOMParser().parseFromString(text, 'application/xml')
  const placemarks = Array.from(xml.getElementsByTagName('Placemark'))
  const layers: PolygonLayer[] = []
  placemarks.forEach((placemark, index) => {
    const geometry = placemark.querySelector('Polygon coordinates, LineString coordinates')
    if (!geometry?.textContent) return
    let points = coordinatesFromText(geometry.textContent)
    if (points.length > 1) {
      const first = points[0]
      const last = points[points.length - 1]
      if (Math.abs(first.lat - last.lat) < 1e-10 && Math.abs(first.lng - last.lng) < 1e-10) points = points.slice(0, -1)
    }
    if (!points.length) return
    layers.push({
      id: uid('polygon'),
      name: placemark.querySelector('name')?.textContent?.trim() || `İçe Aktarılan ${index + 1}`,
      color: POLYGON_COLORS[layers.length % POLYGON_COLORS.length],
      ...DEFAULT_POLYGON_APPEARANCE,
      points,
      desPoints: [],
    })
  })
  return layers
}

export function parseGeoJson(text: string): PolygonLayer[] {
  const data = JSON.parse(text)
  const features = data.type === 'FeatureCollection' ? data.features : [data]
  return features.flatMap((feature: any, index: number) => {
    const type = feature.geometry?.type
    const coordinates = type === 'Polygon' ? feature.geometry.coordinates?.[0] : type === 'LineString' ? feature.geometry.coordinates : null
    if (!Array.isArray(coordinates)) return []
    let points = coordinates.map((pair: number[]) => ({ id: uid('pt'), lng: Number(pair[0]), lat: Number(pair[1]) }))
      .filter((point: GeoPoint) => Number.isFinite(point.lat) && Number.isFinite(point.lng))
    if (type === 'Polygon' && points.length > 1) points = points.slice(0, -1)
    return [{
      id: uid('polygon'),
      name: feature.properties?.name || `GeoJSON ${index + 1}`,
      color: feature.properties?.color || POLYGON_COLORS[index % POLYGON_COLORS.length],
      strokeWidth: Number(feature.properties?.strokeWidth) || DEFAULT_POLYGON_APPEARANCE.strokeWidth,
      strokeOpacity: Number.isFinite(Number(feature.properties?.strokeOpacity)) ? Number(feature.properties.strokeOpacity) : DEFAULT_POLYGON_APPEARANCE.strokeOpacity,
      fillOpacity: Number.isFinite(Number(feature.properties?.fillOpacity)) ? Number(feature.properties.fillOpacity) : DEFAULT_POLYGON_APPEARANCE.fillOpacity,
      points,
      desPoints: [],
    }]
  })
}

function csvCells(line: string, delimiter: string) {
  const cells: string[] = []
  let value = ''
  let quoted = false
  for (let index = 0; index < line.length; index += 1) {
    const char = line[index]
    if (char === '"' && line[index + 1] === '"' && quoted) {
      value += '"'
      index += 1
    } else if (char === '"') {
      quoted = !quoted
    } else if (char === delimiter && !quoted) {
      cells.push(value.trim())
      value = ''
    } else {
      value += char
    }
  }
  cells.push(value.trim())
  return cells
}

function headerIndex(headers: string[], aliases: string[]) {
  return headers.findIndex((header) => aliases.some((alias) => header === alias || (alias.length > 2 && header.includes(alias))))
}

export function parseCsv(text: string, filename = 'CSV Katmanı'): PolygonLayer[] {
  const lines = text.split(/\r?\n/).map((line) => line.trim()).filter(Boolean)
  if (lines.length < 2) return []
  const delimiter = (lines[0].match(/;/g)?.length ?? 0) > (lines[0].match(/,/g)?.length ?? 0) ? ';' : ','
  const headers = csvCells(lines[0], delimiter).map((header) => header.toLocaleLowerCase('tr-TR').replace(/[^a-z0-9ğüşöçı]/g, ''))
  const latIndex = headerIndex(headers, ['latitude', 'lat', 'enlem'])
  const lngIndex = headerIndex(headers, ['longitude', 'lon', 'lng', 'boylam'])
  const eastIndex = headerIndex(headers, ['easting', 'east', 'x'])
  const northIndex = headerIndex(headers, ['northing', 'north', 'y'])
  const zoneIndex = headerIndex(headers, ['zone', 'zon'])
  const hemisphereIndex = headerIndex(headers, ['hemisphere', 'yarımküre', 'yarimkure'])
  const datumIndex = headerIndex(headers, ['datum'])
  const nameIndex = headerIndex(headers, ['name', 'ad', 'nokta'])
  const groupIndex = headerIndex(headers, ['polygon', 'poligon', 'layer', 'katman'])
  const groups = new Map<string, GeoPoint[]>()

  lines.slice(1).forEach((line) => {
    const cells = csvCells(line, delimiter)
    let point: Omit<GeoPoint, 'id'> | null = null
    if (latIndex >= 0 && lngIndex >= 0) {
      const lat = Number(cells[latIndex]?.replace(',', '.'))
      const lng = Number(cells[lngIndex]?.replace(',', '.'))
      if (Number.isFinite(lat) && Number.isFinite(lng) && Math.abs(lat) <= 90 && Math.abs(lng) <= 180) point = { lat, lng }
    } else if (eastIndex >= 0 && northIndex >= 0) {
      const easting = Number(cells[eastIndex]?.replace(',', '.'))
      const northing = Number(cells[northIndex]?.replace(',', '.'))
      const zone = Number(cells[zoneIndex] || 36)
      const hemisphere: 'N' | 'S' = cells[hemisphereIndex]?.toUpperCase().startsWith('S') ? 'S' : 'N'
      if (Number.isFinite(easting) && Number.isFinite(northing)) point = fromUtm(easting, northing, zone, hemisphere, cells[datumIndex] || 'WGS84')
    } else {
      const lat = Number(cells[0]?.replace(',', '.'))
      const lng = Number(cells[1]?.replace(',', '.'))
      if (Number.isFinite(lat) && Number.isFinite(lng) && Math.abs(lat) <= 90 && Math.abs(lng) <= 180) point = { lat, lng }
    }
    if (!point) return
    const group = cells[groupIndex]?.trim() || filename.replace(/\.csv$/i, '') || 'CSV Katmanı'
    const points = groups.get(group) ?? []
    points.push({ ...point, id: uid('pt'), name: cells[nameIndex]?.trim() || undefined })
    groups.set(group, points)
  })

  return Array.from(groups.entries()).map(([name, points], index) => ({
    id: uid('polygon'),
    name,
    color: POLYGON_COLORS[index % POLYGON_COLORS.length],
    ...DEFAULT_POLYGON_APPEARANCE,
    points,
    desPoints: [],
  }))
}

export async function readSpatialFile(file: File) {
  const lower = file.name.toLowerCase()
  if (lower.endsWith('.kmz')) {
    const { default: JSZip } = await import('jszip')
    const zip = await JSZip.loadAsync(await file.arrayBuffer())
    const kmlFile = Object.values(zip.files).find((entry) => entry.name.toLowerCase().endsWith('.kml'))
    if (!kmlFile) throw new Error('KMZ içinde KML bulunamadı.')
    return parseKml(await kmlFile.async('text'))
  }
  const text = await file.text()
  if (lower.endsWith('.csv')) return parseCsv(text, file.name)
  return lower.endsWith('.geojson') || lower.endsWith('.json') ? parseGeoJson(text) : parseKml(text)
}

export function downloadBlob(content: BlobPart, filename: string, type: string) {
  const url = URL.createObjectURL(new Blob([content], { type }))
  const anchor = document.createElement('a')
  anchor.href = url
  anchor.download = filename
  anchor.click()
  window.setTimeout(() => URL.revokeObjectURL(url), 1000)
}

export async function downloadKmz(polygons: PolygonLayer[], filename: string) {
  const { default: JSZip } = await import('jszip')
  const zip = new JSZip()
  zip.file('doc.kml', polygonsToKml(polygons))
  downloadBlob(await zip.generateAsync({ type: 'blob' }), `${filename}.kmz`, 'application/vnd.google-earth.kmz')
}

export function polygonsToCsv(polygons: PolygonLayer[], format: CoordinateFormat) {
  const rows = ['Poligon,Nokta,Koordinat']
  polygons.forEach((layer) => layer.points.forEach((point, index) => {
    rows.push(`"${layer.name.replaceAll('"', '""')}",${index + 1},"${formatPoint(point, format)}"`)
  }))
  return rows.join('\n')
}
