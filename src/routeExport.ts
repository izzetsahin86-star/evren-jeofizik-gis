import { downloadBlob } from './geo'

export interface RouteExportPoint {
  lat: number
  lng: number
  altitude?: number | null
  timestamp?: number
}

function escapeKml(value: string) {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;')
}

function safeFilename(value: string) {
  return value
    .trim()
    .replace(/[<>:"/\\|?*]/g, '-')
    .replace(/[. ]+$/g, '')
    .slice(0, 120) || 'Evren Jeofizik Rota'
}

function routeSegments(points: RouteExportPoint[], segmentBreaks: number[]) {
  const starts = Array.from(new Set([0, ...segmentBreaks]))
    .filter((index) => Number.isInteger(index) && index >= 0 && index < points.length)
    .sort((a, b) => a - b)

  return starts
    .map((start, index) => points.slice(start, starts[index + 1] ?? points.length))
    .filter((segment) => segment.length)
}

export function routeToKml(name: string, points: RouteExportPoint[], segmentBreaks: number[]) {
  const safeName = name.trim() || 'Evren Jeofizik Rota'
  const segments = routeSegments(points, segmentBreaks)
  const startedAt = points.find((point) => Number.isFinite(point.timestamp))?.timestamp
  const finishedAt = points.slice().reverse().find((point) => Number.isFinite(point.timestamp))?.timestamp
  const description = [
    `${points.length} GPS noktası`,
    `${segments.length} segment`,
    startedAt ? `Başlangıç: ${new Date(startedAt).toLocaleString('tr-TR')}` : '',
    finishedAt ? `Bitiş: ${new Date(finishedAt).toLocaleString('tr-TR')}` : '',
    'Evren Jeofizik GIS',
  ].filter(Boolean).join(' | ')

  const placemarks = segments.map((segment, index) => {
    const coordinates = segment.map((point) => {
      const altitude = typeof point.altitude === 'number' && Number.isFinite(point.altitude) ? point.altitude.toFixed(2) : '0'
      return `${point.lng.toFixed(8)},${point.lat.toFixed(8)},${altitude}`
    }).join(' ')
    const segmentName = segments.length > 1 ? `${safeName} · Segment ${index + 1}` : safeName
    return `    <Placemark>
      <name>${escapeKml(segmentName)}</name>
      <description>${escapeKml(description)}</description>
      <styleUrl>#route-style</styleUrl>
      <LineString>
        <tessellate>1</tessellate>
        <altitudeMode>clampToGround</altitudeMode>
        <coordinates>${coordinates}</coordinates>
      </LineString>
    </Placemark>`
  }).join('\n')

  return `<?xml version="1.0" encoding="UTF-8"?>
<kml xmlns="http://www.opengis.net/kml/2.2">
  <Document>
    <name>${escapeKml(safeName)}</name>
    <Style id="route-style">
      <LineStyle><color>ff00a5ff</color><width>4</width></LineStyle>
    </Style>
${placemarks}
  </Document>
</kml>`
}

export function downloadRouteKml(name: string, points: RouteExportPoint[], segmentBreaks: number[]) {
  const filename = safeFilename(name)
  downloadBlob(routeToKml(name, points, segmentBreaks), `${filename}.kml`, 'application/vnd.google-earth.kml+xml')
}

export async function downloadRouteKmz(name: string, points: RouteExportPoint[], segmentBreaks: number[]) {
  const { default: JSZip } = await import('jszip')
  const zip = new JSZip()
  zip.file('doc.kml', routeToKml(name, points, segmentBreaks))
  const archive = await zip.generateAsync({ type: 'blob', compression: 'DEFLATE', compressionOptions: { level: 6 } })
  downloadBlob(archive, `${safeFilename(name)}.kmz`, 'application/vnd.google-earth.kmz')
}
