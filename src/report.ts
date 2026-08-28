import { analyzePolygon, dominantUtmZone, formatNumber, formatPoint } from './geo'
import { validateCoordinates } from './coordinateValidation'
import { readRouteArchive, type RouteArchiveItem } from './routeArchive'
import { readReportFieldPhoto, readReportFieldPoints, type ReportFieldPoint } from './reportData'
import type { BaseLayerId, GeoPoint, PolygonLayer } from './types'

export interface ReportMetadata {
  projectName: string
  reportNumber: string
  client: string
  location: string
  preparedBy: string
  notes: string
}

export interface ReportSections {
  map: boolean
  des: boolean
  standalonePoints: boolean
  fieldPoints: boolean
  photos: boolean
  validation: boolean
  routes: boolean
}

export interface ProjectReportInput {
  polygons: PolygonLayer[]
  standalonePoints: GeoPoint[]
  filename: string
  metadata: ReportMetadata
  selectedPolygonIds: string[]
  sections: ReportSections
  baseLayer: BaseLayerId
  mtaIndex25Visible: boolean
  mtaIndex100Visible: boolean
  manualPhotos: File[]
  fieldPoints?: ReportFieldPoint[]
  routes?: RouteArchiveItem[]
}

interface ReportImage {
  dataUrl: string
  width: number
  height: number
}

interface ReportPhoto extends ReportImage {
  title: string
  caption: string
}

interface CoordinatePreviewRow {
  id: string
  type: string
  source: string
  point: GeoPoint
  zone: number
}

const FONT_REGULAR = '/fonts/EvrenSans.ttf'
const FONT_BOLD = '/fonts/EvrenSans-Bold.ttf'
const LOGO_URL = '/icons/evren-jeofizik-logo.svg'
const PAGE_WIDTH = 210
const PAGE_HEIGHT = 297
const MARGIN = 15
const CONTENT_WIDTH = PAGE_WIDTH - MARGIN * 2

const COLORS = {
  navy: [7, 22, 41] as const,
  navySoft: [14, 34, 58] as const,
  blue: [21, 151, 229] as const,
  cyan: [56, 189, 248] as const,
  green: [34, 197, 94] as const,
  amber: [245, 158, 11] as const,
  violet: [124, 58, 237] as const,
  red: [239, 68, 68] as const,
  ink: [30, 41, 59] as const,
  muted: [100, 116, 139] as const,
  line: [216, 226, 236] as const,
  surface: [245, 248, 251] as const,
  white: [255, 255, 255] as const,
}

function arrayBufferToBase64(buffer: ArrayBuffer) {
  const bytes = new Uint8Array(buffer)
  let binary = ''
  for (let offset = 0; offset < bytes.length; offset += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + 0x8000))
  }
  return btoa(binary)
}

function fallbackPdfText(value: string) {
  return value
    .replaceAll('İ', 'I').replaceAll('ı', 'i')
    .replaceAll('Ş', 'S').replaceAll('ş', 's')
    .replaceAll('Ğ', 'G').replaceAll('ğ', 'g')
    .replaceAll('Ü', 'U').replaceAll('ü', 'u')
    .replaceAll('Ö', 'O').replaceAll('ö', 'o')
    .replaceAll('Ç', 'C').replaceAll('ç', 'c')
}

async function installTurkishFonts(pdf: import('jspdf').jsPDF) {
  try {
    const [regular, bold] = await Promise.all([fetch(FONT_REGULAR), fetch(FONT_BOLD)])
    if (!regular.ok || !bold.ok) throw new Error('Font dosyaları yüklenemedi.')
    const [regularBuffer, boldBuffer] = await Promise.all([regular.arrayBuffer(), bold.arrayBuffer()])
    pdf.addFileToVFS('EvrenSans.ttf', arrayBufferToBase64(regularBuffer))
    pdf.addFileToVFS('EvrenSans-Bold.ttf', arrayBufferToBase64(boldBuffer))
    pdf.addFont('EvrenSans.ttf', 'EvrenSans', 'normal')
    pdf.addFont('EvrenSans-Bold.ttf', 'EvrenSans', 'bold')
    return { family: 'EvrenSans', text: (value: string) => value }
  } catch {
    return { family: 'helvetica', text: fallbackPdfText }
  }
}

async function loadLogoDataUrl() {
  try {
    const response = await fetch(LOGO_URL)
    if (!response.ok) return null
    const svg = await response.text()
    const content = svg.match(/data:image\/(?:jpeg|jpg);base64,([^"']+)/i)?.[1]
    return content ? `data:image/jpeg;base64,${content}` : null
  } catch {
    return null
  }
}

function nextPaint() {
  return new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve())))
}

async function captureMapImage(): Promise<ReportImage | null> {
  if (typeof document === 'undefined') return null
  const map = document.querySelector<HTMLElement>('.map-shell')
  if (!map) return null
  try {
    await nextPaint()
    const { default: html2canvas } = await import('html2canvas')
    const source = await html2canvas(map, {
      useCORS: true,
      allowTaint: false,
      backgroundColor: '#dce8ee',
      logging: false,
      scale: Math.min(2, Math.max(1.35, window.devicePixelRatio || 1)),
      ignoreElements: (element) => [
        'smart-map-tools',
        'smart-measurement-sheet',
        'map-share-card',
        'map-delete-card',
        'locate-button',
        'gps-accuracy',
        'map-crosshair',
      ].some((className) => element.classList?.contains(className)),
    })

    const ratio = 16 / 9
    const sourceRatio = source.width / source.height
    const sourceWidth = sourceRatio > ratio ? source.height * ratio : source.width
    const sourceHeight = sourceRatio > ratio ? source.height : source.width / ratio
    const sourceX = (source.width - sourceWidth) / 2
    const sourceY = (source.height - sourceHeight) / 2
    const output = document.createElement('canvas')
    output.width = Math.min(1800, Math.round(sourceWidth))
    output.height = Math.round(output.width / ratio)
    output.getContext('2d')?.drawImage(source, sourceX, sourceY, sourceWidth, sourceHeight, 0, 0, output.width, output.height)
    return { dataUrl: output.toDataURL('image/jpeg', 0.88), width: output.width, height: output.height }
  } catch {
    return null
  }
}

function imageBlobToJpeg(blob: Blob) {
  return new Promise<ReportImage>((resolve, reject) => {
    const reader = new FileReader()
    reader.onerror = () => reject(new Error('Fotoğraf okunamadı.'))
    reader.onload = () => {
      const image = new Image()
      image.onerror = () => reject(new Error('Fotoğraf çözümlenemedi.'))
      image.onload = () => {
        const scale = Math.min(1, 1600 / Math.max(image.naturalWidth, image.naturalHeight))
        const width = Math.max(1, Math.round(image.naturalWidth * scale))
        const height = Math.max(1, Math.round(image.naturalHeight * scale))
        const canvas = document.createElement('canvas')
        canvas.width = width
        canvas.height = height
        canvas.getContext('2d')?.drawImage(image, 0, 0, width, height)
        resolve({ dataUrl: canvas.toDataURL('image/jpeg', 0.82), width, height })
      }
      image.src = String(reader.result)
    }
    reader.readAsDataURL(blob)
  })
}

async function collectPhotos(manual: File[], fieldPoints: ReportFieldPoint[]) {
  const manualPhotos = await Promise.all(manual.map(async (file, index) => ({
    ...(await imageBlobToJpeg(file)),
    title: `Proje Fotoğrafı ${index + 1}`,
    caption: file.name,
  })))
  const fieldPhotos = await Promise.all(fieldPoints.filter((point) => point.photoId).map(async (point) => {
    const blob = await readReportFieldPhoto(point.photoId!)
    if (!blob) return null
    return {
      ...(await imageBlobToJpeg(blob)),
      title: point.name,
      caption: point.note || point.description || 'Saha fotoğrafı',
    }
  }))
  return [...manualPhotos, ...fieldPhotos.filter((photo): photo is ReportPhoto => Boolean(photo))]
}

function hexToRgb(color: string) {
  const normalized = color.replace('#', '').padEnd(6, '0')
  return [0, 2, 4].map((offset) => Number.parseInt(normalized.slice(offset, offset + 2), 16)) as [number, number, number]
}

function mapSourceLabel(input: ProjectReportInput) {
  const base: Record<BaseLayerId, string> = {
    street: 'Standart harita',
    satellite: 'Uydu haritası',
    topographic: 'Topoğrafik harita',
  }
  const sources = [base[input.baseLayer]]
  if (input.mtaIndex25Visible) sources.push('MTA 1/25.000')
  if (input.mtaIndex100Visible) sources.push('MTA 1/100.000')
  return sources.join(' · ')
}

function totalAreaM2(polygons: PolygonLayer[]) {
  return polygons.reduce((sum, layer) => sum + analyzePolygon(layer.points).areaM2, 0)
}

function routeDuration(route: RouteArchiveItem) {
  return Math.max(0, route.finishedAt - route.startedAt - route.totalPausedMs)
}

function formatDuration(milliseconds: number) {
  const minutes = Math.round(milliseconds / 60_000)
  return minutes >= 60 ? `${Math.floor(minutes / 60)} sa ${minutes % 60} dk` : `${minutes} dk`
}

function truncate(value: string, length: number) {
  return value.length > length ? `${value.slice(0, length - 1)}…` : value
}

function allMapPoints(polygons: PolygonLayer[], standalone: GeoPoint[], field: ReportFieldPoint[], routes: RouteArchiveItem[]) {
  return [
    ...polygons.flatMap((layer) => [...layer.points, ...layer.desPoints]),
    ...standalone,
    ...field.map((point) => ({ id: point.id, lat: point.lat, lng: point.lng })),
    ...routes.flatMap((route) => route.points.map((point, index) => ({ id: `${route.id}-${index}`, lat: point.lat, lng: point.lng }))),
  ]
}

function drawVectorFallback(
  pdf: import('jspdf').jsPDF,
  data: { polygons: PolygonLayer[]; standalone: GeoPoint[]; field: ReportFieldPoint[]; routes: RouteArchiveItem[] },
  x: number,
  y: number,
  width: number,
  height: number,
) {
  pdf.setFillColor(222, 235, 241)
  pdf.rect(x, y, width, height, 'F')
  const points = allMapPoints(data.polygons, data.standalone, data.field, data.routes)
  if (!points.length) return
  const minLat = Math.min(...points.map((point) => point.lat))
  const maxLat = Math.max(...points.map((point) => point.lat))
  const minLng = Math.min(...points.map((point) => point.lng))
  const maxLng = Math.max(...points.map((point) => point.lng))
  const latSpan = Math.max(maxLat - minLat, 0.000001)
  const lngSpan = Math.max(maxLng - minLng, 0.000001)
  const project = (point: Pick<GeoPoint, 'lat' | 'lng'>) => ({
    x: x + 7 + ((point.lng - minLng) / lngSpan) * (width - 14),
    y: y + height - 7 - ((point.lat - minLat) / latSpan) * (height - 14),
  })
  data.polygons.forEach((layer) => {
    if (layer.points.length < 2) return
    const [red, green, blue] = hexToRgb(layer.color)
    pdf.setDrawColor(red, green, blue)
    pdf.setLineWidth(0.65)
    const projected = layer.points.map(project)
    projected.slice(1).forEach((point, index) => pdf.line(projected[index].x, projected[index].y, point.x, point.y))
    if (projected.length >= 3) pdf.line(projected.at(-1)!.x, projected.at(-1)!.y, projected[0].x, projected[0].y)
    pdf.setFillColor(red, green, blue)
    projected.forEach((point) => pdf.circle(point.x, point.y, 0.8, 'F'))
    pdf.setFillColor(...COLORS.green)
    layer.desPoints.forEach((point) => { const target = project(point); pdf.circle(target.x, target.y, 1, 'F') })
  })
  pdf.setDrawColor(...COLORS.amber)
  data.routes.forEach((route) => route.points.slice(1).forEach((point, index) => {
    const from = project(route.points[index])
    const to = project(point)
    pdf.line(from.x, from.y, to.x, to.y)
  }))
  pdf.setFillColor(250, 204, 21)
  data.standalone.forEach((point) => { const target = project(point); pdf.circle(target.x, target.y, 1.2, 'F') })
}

function createCoordinatePreview(
  polygons: PolygonLayer[],
  standalone: GeoPoint[],
  fieldPoints: ReportFieldPoint[],
  sections: ReportSections,
) {
  const vertexRows = polygons.flatMap((layer) => {
    const zone = layer.utmZone ?? dominantUtmZone(layer.points)
    return layer.points.map((point, index): CoordinatePreviewRow => ({ id: `P${index + 1}`, type: 'Köşe', source: layer.name, point, zone }))
  })
  const desRows = sections.des ? polygons.flatMap((layer) => {
    const zone = layer.utmZone ?? dominantUtmZone(layer.points)
    return layer.desPoints.map((point, index): CoordinatePreviewRow => ({ id: `D${index + 1}`, type: 'DES', source: layer.name, point, zone }))
  }) : []
  const standaloneRows = sections.standalonePoints ? standalone.map((point, index): CoordinatePreviewRow => ({
    id: `N${index + 1}`,
    type: 'Nokta',
    source: point.name || `Nokta ${index + 1}`,
    point,
    zone: dominantUtmZone([point]),
  })) : []
  const fieldRows = sections.fieldPoints ? fieldPoints.map((point, index): CoordinatePreviewRow => ({
    id: `S${index + 1}`,
    type: 'Saha',
    source: point.name,
    point: { id: point.id, lat: point.lat, lng: point.lng },
    zone: dominantUtmZone([point]),
  })) : []
  const priority = [...vertexRows.slice(0, 4), ...desRows.slice(0, 2), ...standaloneRows.slice(0, 1), ...fieldRows.slice(0, 1)]
  const selected = new Set(priority.map((row) => `${row.type}-${row.source}-${row.point.id}`))
  const remainder = [...vertexRows, ...desRows, ...standaloneRows, ...fieldRows].filter((row) => !selected.has(`${row.type}-${row.source}-${row.point.id}`))
  return [...priority, ...remainder].slice(0, 8)
}

function addFittedImage(pdf: import('jspdf').jsPDF, image: ReportImage, x: number, y: number, width: number, height: number) {
  const scale = Math.min(width / image.width, height / image.height)
  const targetWidth = image.width * scale
  const targetHeight = image.height * scale
  pdf.addImage(image.dataUrl, 'JPEG', x + (width - targetWidth) / 2, y + (height - targetHeight) / 2, targetWidth, targetHeight, undefined, 'FAST')
}

export async function buildProjectPdf(input: ProjectReportInput) {
  const { jsPDF } = await import('jspdf')
  const pdf = new jsPDF({ unit: 'mm', format: 'a4', compress: true })
  const font = await installTurkishFonts(pdf)
  const t = font.text
  const setFont = (style: 'normal' | 'bold' = 'normal') => pdf.setFont(font.family, style)
  const selectedIds = new Set(input.selectedPolygonIds)
  const polygons = input.polygons.filter((layer) => selectedIds.has(layer.id))
  const fieldPoints = input.fieldPoints ?? readReportFieldPoints()
  const routes = input.routes ?? readRouteArchive()
  const activeFieldPoints = input.sections.fieldPoints || input.sections.photos ? fieldPoints : []
  const activeRoutes = input.sections.routes ? routes : []
  const [mapImage, logo, photos] = await Promise.all([
    input.sections.map ? captureMapImage() : Promise.resolve(null),
    loadLogoDataUrl(),
    input.sections.photos ? collectPhotos(input.manualPhotos, activeFieldPoints) : Promise.resolve([]),
  ])
  const overview = { polygons, standalone: input.standalonePoints, field: activeFieldPoints, routes: activeRoutes }
  const totalPoints = polygons.reduce((sum, layer) => sum + layer.points.length, 0)
  const totalDes = polygons.reduce((sum, layer) => sum + layer.desPoints.length, 0)
  const totalArea = totalAreaM2(polygons)
  const totalWarnings = input.sections.validation
    ? polygons.reduce((sum, layer) => sum + validateCoordinates(layer.points, layer.utmZone ?? dominantUtmZone(layer.points)).length, 0)
    : 0
  const zones = Array.from(new Set(polygons.map((layer) => layer.utmZone ?? dominantUtmZone(layer.points)))).sort((a, b) => a - b)
  const coordinateRows = createCoordinatePreview(polygons, input.standalonePoints, fieldPoints, input.sections)
  const totalCoordinateRecords = totalPoints
    + (input.sections.des ? totalDes : 0)
    + (input.sections.standalonePoints ? input.standalonePoints.length : 0)
    + (input.sections.fieldPoints ? fieldPoints.length : 0)
  const totalRouteDistance = activeRoutes.reduce((sum, route) => sum + route.distanceM, 0)
  const totalRouteDuration = activeRoutes.reduce((sum, route) => sum + routeDuration(route), 0)

  const fillPage = () => { pdf.setFillColor(...COLORS.surface); pdf.rect(0, 0, PAGE_WIDTH, PAGE_HEIGHT, 'F') }
  const footer = (page: number) => {
    pdf.setDrawColor(...COLORS.line); pdf.line(MARGIN, 286, PAGE_WIDTH - MARGIN, 286)
    setFont(); pdf.setFontSize(6.5); pdf.setTextColor(...COLORS.muted)
    pdf.text(t(`Evren Jeofizik GIS · ${input.metadata.reportNumber || 'Rapor'}`), MARGIN, 291)
    pdf.text(`${page} / 2`, PAGE_WIDTH - MARGIN, 291, { align: 'right' })
  }
  const card = (x: number, y: number, width: number, height: number, accent: readonly [number, number, number] = COLORS.blue) => {
    pdf.setFillColor(...COLORS.white); pdf.roundedRect(x, y, width, height, 3, 3, 'F')
    pdf.setFillColor(...accent); pdf.roundedRect(x, y, 2.2, height, 1.1, 1.1, 'F')
  }
  const statCard = (x: number, label: string, value: string, accent: readonly [number, number, number]) => {
    card(x, 199, 42.75, 27, accent)
    pdf.setFillColor(...accent); pdf.circle(x + 7, 207, 2.2, 'F')
    setFont(); pdf.setFontSize(6.5); pdf.setTextColor(...COLORS.muted); pdf.text(t(label), x + 12, 208.5)
    setFont('bold'); pdf.setFontSize(11); pdf.setTextColor(...COLORS.ink); pdf.text(t(value), x + 6, 219)
  }
  const pageHeader = (title: string, subtitle: string) => {
    pdf.setFillColor(...COLORS.navy); pdf.rect(0, 0, PAGE_WIDTH, 29, 'F')
    pdf.setFillColor(...COLORS.cyan); pdf.rect(0, 28, PAGE_WIDTH, 1, 'F')
    pdf.setFillColor(...COLORS.navySoft); pdf.circle(PAGE_WIDTH - 18, -1, 29, 'F')
    if (logo) { try { pdf.addImage(logo, 'JPEG', MARGIN, 7, 25, 15, undefined, 'FAST') } catch { /* Metin logosu kullanılır. */ } }
    setFont('bold'); pdf.setTextColor(...COLORS.white); pdf.setFontSize(10)
    pdf.text(t('EVREN JEOFİZİK'), logo ? 45 : MARGIN, 13)
    setFont(); pdf.setTextColor(148, 178, 207); pdf.setFontSize(6.5)
    pdf.text(t('AKILLI SAHA GIS'), logo ? 45 : MARGIN, 19)
    setFont('bold'); pdf.setTextColor(...COLORS.white); pdf.setFontSize(10)
    pdf.text(t(title), PAGE_WIDTH - MARGIN, 12, { align: 'right' })
    setFont(); pdf.setTextColor(148, 178, 207); pdf.setFontSize(6.5)
    pdf.text(t(subtitle), PAGE_WIDTH - MARGIN, 19, { align: 'right' })
  }

  // SAYFA 1 - Akıllı mobil proje özeti ve gerçek harita ekran görüntüsü
  fillPage()
  pdf.setFillColor(...COLORS.navy); pdf.rect(0, 0, PAGE_WIDTH, 36, 'F')
  pdf.setFillColor(...COLORS.navySoft); pdf.circle(201, -2, 39, 'F')
  pdf.setFillColor(...COLORS.blue); pdf.rect(0, 35, PAGE_WIDTH, 1, 'F')
  if (logo) { try { pdf.addImage(logo, 'JPEG', MARGIN, 9, 30, 18, undefined, 'FAST') } catch { /* Metin başlığı yeterlidir. */ } }
  setFont('bold'); pdf.setTextColor(...COLORS.white); pdf.setFontSize(11)
  pdf.text(t('EVREN JEOFİZİK HİZMETLERİ'), logo ? 51 : MARGIN, 16)
  setFont(); pdf.setTextColor(147, 179, 208); pdf.setFontSize(7)
  pdf.text(t('AKILLI SAHA GIS · YÖNETİCİ RAPORU'), logo ? 51 : MARGIN, 23)
  pdf.setFillColor(13, 51, 77); pdf.roundedRect(157, 10, 38, 11, 5.5, 5.5, 'F')
  pdf.setFillColor(...COLORS.green); pdf.circle(163, 15.5, 1.5, 'F')
  setFont('bold'); pdf.setTextColor(203, 232, 255); pdf.setFontSize(6.5); pdf.text(t('SAHA RAPORU'), 168, 17)

  setFont('bold'); pdf.setTextColor(...COLORS.ink); pdf.setFontSize(18)
  const titleLines = pdf.splitTextToSize(t(input.metadata.projectName || 'Jeofizik Saha Projesi'), 128).slice(0, 2)
  pdf.text(titleLines, MARGIN, 49)
  const titleBottom = 49 + (titleLines.length - 1) * 7
  setFont(); pdf.setFontSize(6.7); pdf.setTextColor(...COLORS.muted)
  pdf.text(t(`${input.metadata.location || 'Konum belirtilmedi'} · ${new Date().toLocaleDateString('tr-TR')}`), MARGIN, titleBottom + 8)
  pdf.setFillColor(230, 240, 247); pdf.roundedRect(151, 43, 44, 19, 3, 3, 'F')
  setFont(); pdf.setFontSize(5.8); pdf.setTextColor(...COLORS.muted); pdf.text(t('RAPOR NUMARASI'), 156, 50)
  setFont('bold'); pdf.setFontSize(7.5); pdf.setTextColor(...COLORS.navy); pdf.text(t(truncate(input.metadata.reportNumber || '-', 20)), 156, 57)

  card(MARGIN, 69, CONTENT_WIDTH, 121, COLORS.cyan)
  pdf.setFillColor(...COLORS.navy); pdf.roundedRect(MARGIN + 2, 71, CONTENT_WIDTH - 4, 11, 2.5, 2.5, 'F')
  pdf.setFillColor(...COLORS.green); pdf.circle(MARGIN + 8, 76.5, 1.4, 'F')
  setFont('bold'); pdf.setFontSize(6.5); pdf.setTextColor(215, 236, 251); pdf.text(t('CANLI HARİTA GÖRÜNÜMÜ'), MARGIN + 13, 78)
  setFont(); pdf.setTextColor(135, 170, 200); pdf.text(t(mapSourceLabel(input)), PAGE_WIDTH - MARGIN - 5, 78, { align: 'right' })
  if (mapImage) addFittedImage(pdf, mapImage, MARGIN + 2, 83, CONTENT_WIDTH - 4, 101.25)
  else drawVectorFallback(pdf, overview, MARGIN + 2, 83, CONTENT_WIDTH - 4, 101.25)
  pdf.setDrawColor(194, 209, 220); pdf.rect(MARGIN + 2, 83, CONTENT_WIDTH - 4, 101.25)
  pdf.setFillColor(255, 255, 255); pdf.roundedRect(165, 88, 22, 20, 3, 3, 'F')
  pdf.setFillColor(...COLORS.navy); pdf.triangle(176, 91, 172, 103, 180, 103, 'F')
  setFont('bold'); pdf.setFontSize(6); pdf.setTextColor(...COLORS.navy); pdf.text(t('K'), 176, 106, { align: 'center' })

  statCard(MARGIN, 'POLİGON', String(polygons.length), COLORS.blue)
  statCard(MARGIN + 45.75, 'KÖŞE NOKTASI', String(totalPoints), COLORS.violet)
  statCard(MARGIN + 91.5, 'TOPLAM ALAN', `${formatNumber(totalArea / 10_000, 3)} ha`, COLORS.green)
  statCard(MARGIN + 137.25, 'DES NOKTASI', String(totalDes), COLORS.amber)

  card(MARGIN, 233, CONTENT_WIDTH, 43, COLORS.blue)
  const details = [
    ['MÜŞTERİ', input.metadata.client || '-'],
    ['HAZIRLAYAN', input.metadata.preparedBy || 'Evren Jeofizik'],
  ]
  details.forEach(([label, value], index) => {
    const x = MARGIN + 7 + index * 88
    setFont(); pdf.setFontSize(5.8); pdf.setTextColor(...COLORS.muted); pdf.text(t(label), x, 243)
    setFont('bold'); pdf.setFontSize(7.5); pdf.setTextColor(...COLORS.ink); pdf.text(t(truncate(value, 35)), x, 250)
  })
  pdf.setDrawColor(...COLORS.line); pdf.line(MARGIN + 7, 255, PAGE_WIDTH - MARGIN - 7, 255)
  setFont(); pdf.setFontSize(6.5); pdf.setTextColor(...COLORS.muted)
  const note = input.metadata.notes.trim() || 'Bu rapor saha verilerinin hızlı değerlendirilmesi amacıyla hazırlanmıştır.'
  pdf.text(pdf.splitTextToSize(t(note), CONTENT_WIDTH - 14).slice(0, 2), MARGIN + 7, 262)
  footer(1)

  // SAYFA 2 - İki sayfaya sığan teknik özet
  pdf.addPage()
  fillPage()
  pageHeader('TEKNİK ÖZET', 'Poligon · Koordinat · DES · Rota')
  setFont('bold'); pdf.setFontSize(13); pdf.setTextColor(...COLORS.ink); pdf.text(t('Saha verileri, tek bakışta.'), MARGIN, 41)
  setFont(); pdf.setFontSize(6.5); pdf.setTextColor(...COLORS.muted)
  pdf.text(t(`Seçilen ${polygons.length} poligon · ${totalCoordinateRecords} koordinat kaydı · WGS84`), MARGIN, 47)

  card(MARGIN, 53, 88, 31, COLORS.blue)
  setFont('bold'); pdf.setFontSize(7); pdf.setTextColor(...COLORS.blue); pdf.text(t('POLİGON & ALAN'), MARGIN + 6, 62)
  polygons.slice(0, 3).forEach((layer, index) => {
    const area = analyzePolygon(layer.points).areaM2 / 10_000
    setFont(); pdf.setFontSize(6.2); pdf.setTextColor(...COLORS.ink)
    pdf.text(t(truncate(layer.name, 25)), MARGIN + 6, 69 + index * 5)
    setFont('bold'); pdf.text(t(`${formatNumber(area, 3)} ha`), MARGIN + 82, 69 + index * 5, { align: 'right' })
  })
  if (polygons.length > 3) { setFont(); pdf.setFontSize(5.5); pdf.setTextColor(...COLORS.muted); pdf.text(t(`+ ${polygons.length - 3} poligon daha`), MARGIN + 6, 82) }

  card(107, 53, 88, 31, COLORS.violet)
  setFont('bold'); pdf.setFontSize(7); pdf.setTextColor(...COLORS.violet); pdf.text(t('SAHA KAYITLARI'), 113, 62)
  const fieldSummary = [
    `DES ${input.sections.des ? totalDes : 0}`,
    `Nokta ${input.sections.standalonePoints ? input.standalonePoints.length : 0}`,
    `Saha ${input.sections.fieldPoints ? fieldPoints.length : 0}`,
    `Foto ${input.sections.photos ? photos.length : 0}`,
  ]
  fieldSummary.forEach((value, index) => {
    const x = 113 + (index % 2) * 39
    const y = 70 + Math.floor(index / 2) * 8
    pdf.setFillColor(244, 241, 255); pdf.roundedRect(x, y - 4.5, 34, 6.5, 3.2, 3.2, 'F')
    setFont('bold'); pdf.setFontSize(6.2); pdf.setTextColor(...COLORS.ink); pdf.text(t(value), x + 17, y, { align: 'center' })
  })

  card(MARGIN, 89, 88, 31, COLORS.cyan)
  setFont('bold'); pdf.setFontSize(7); pdf.setTextColor(2, 132, 199); pdf.text(t('KOORDİNAT SİSTEMİ'), MARGIN + 6, 98)
  setFont(); pdf.setFontSize(6.2); pdf.setTextColor(...COLORS.ink)
  pdf.text(t(`Datum: WGS84 · EPSG:4326`), MARGIN + 6, 106)
  pdf.text(t(`UTM Zone: ${zones.length ? zones.join(', ') : '-'} · Yarımküre: ${polygons[0]?.points[0]?.lat >= 0 ? 'N' : 'S'}`), MARGIN + 6, 113)

  const validationAccent: readonly [number, number, number] = totalWarnings ? COLORS.red : COLORS.green
  card(107, 89, 88, 31, validationAccent)
  setFont('bold'); pdf.setFontSize(7); pdf.setTextColor(...validationAccent)
  pdf.text(t('KOORDİNAT HATA KONTROLÜ'), 113, 98)
  setFont('bold'); pdf.setFontSize(10); pdf.setTextColor(...COLORS.ink)
  pdf.text(t(input.sections.validation ? (totalWarnings ? `${totalWarnings} uyarı` : 'Hata bulunmadı') : 'Kontrol kapalı'), 113, 108)
  setFont(); pdf.setFontSize(5.7); pdf.setTextColor(...COLORS.muted)
  pdf.text(t('Tekrar · UTM zonu · Mesafe · Kesişim'), 113, 115)

  setFont('bold'); pdf.setFontSize(8); pdf.setTextColor(...COLORS.ink); pdf.text(t('KOORDİNAT ÖNİZLEMESİ'), MARGIN, 132)
  setFont(); pdf.setFontSize(5.8); pdf.setTextColor(...COLORS.muted)
  pdf.text(t(`İlk ${coordinateRows.length} kayıt gösteriliyor · Tam veri KML/CSV dışa aktarımında korunur`), PAGE_WIDTH - MARGIN, 132, { align: 'right' })
  pdf.setFillColor(...COLORS.navy); pdf.roundedRect(MARGIN, 137, CONTENT_WIDTH, 9, 2, 2, 'F')
  const columns = [
    { label: 'TÜR', x: MARGIN + 5 },
    { label: 'KATMAN / AD', x: MARGIN + 27 },
    { label: 'ENLEM / BOYLAM', x: MARGIN + 84 },
    { label: 'UTM', x: MARGIN + 137 },
  ]
  setFont('bold'); pdf.setFontSize(5.8); pdf.setTextColor(208, 229, 246)
  columns.forEach((column) => pdf.text(t(column.label), column.x, 143))
  coordinateRows.forEach((row, index) => {
    const y = 153 + index * 7.2
    if (index % 2 === 0) { pdf.setFillColor(236, 242, 247); pdf.roundedRect(MARGIN, y - 5, CONTENT_WIDTH, 7, 1, 1, 'F') }
    setFont('bold'); pdf.setFontSize(5.8); pdf.setTextColor(...COLORS.blue); pdf.text(t(`${row.type} ${row.id}`), MARGIN + 5, y)
    setFont(); pdf.setTextColor(...COLORS.ink); pdf.text(t(truncate(row.source, 24)), MARGIN + 27, y)
    pdf.text(`${row.point.lat.toFixed(6)}, ${row.point.lng.toFixed(6)}`, MARGIN + 84, y)
    pdf.setFontSize(5.3); pdf.text(formatPoint(row.point, 'utm', row.zone), MARGIN + 137, y)
  })
  if (!coordinateRows.length) {
    setFont(); pdf.setFontSize(7); pdf.setTextColor(...COLORS.muted); pdf.text(t('Koordinat kaydı bulunmuyor.'), PAGE_WIDTH / 2, 164, { align: 'center' })
  }

  const lowerY = 216
  if (photos.length) {
    setFont('bold'); pdf.setFontSize(8); pdf.setTextColor(...COLORS.ink); pdf.text(t('SAHA FOTOĞRAFLARI'), MARGIN, lowerY)
    setFont(); pdf.setFontSize(5.8); pdf.setTextColor(...COLORS.muted); pdf.text(t(`${photos.length} fotoğraftan ilk ${Math.min(3, photos.length)} kayıt`), PAGE_WIDTH - MARGIN, lowerY, { align: 'right' })
    const gap = 4
    const photoWidth = (CONTENT_WIDTH - gap * 2) / 3
    photos.slice(0, 3).forEach((photo, index) => {
      const x = MARGIN + index * (photoWidth + gap)
      card(x, lowerY + 5, photoWidth, 53, index === 0 ? COLORS.blue : index === 1 ? COLORS.violet : COLORS.green)
      addFittedImage(pdf, photo, x + 2, lowerY + 7, photoWidth - 4, 38)
      setFont('bold'); pdf.setFontSize(5.8); pdf.setTextColor(...COLORS.ink)
      pdf.text(t(truncate(photo.title, 21)), x + 4, lowerY + 50)
    })
  } else {
    card(MARGIN, lowerY, CONTENT_WIDTH, 58, COLORS.amber)
    setFont('bold'); pdf.setFontSize(8); pdf.setTextColor(...COLORS.amber); pdf.text(t('ROTA & SAHA ÖZETİ'), MARGIN + 7, lowerY + 10)
    const routeValue = input.sections.routes && activeRoutes.length
      ? `${activeRoutes.length} rota · ${formatNumber(totalRouteDistance / 1000, 2)} km · ${formatDuration(totalRouteDuration)}`
      : 'Arşivlenmiş rota bulunmuyor'
    setFont('bold'); pdf.setFontSize(8); pdf.setTextColor(...COLORS.ink); pdf.text(t(routeValue), MARGIN + 7, lowerY + 21)
    setFont(); pdf.setFontSize(6.3); pdf.setTextColor(...COLORS.muted)
    const bottomNotes = [
      `DES planı: ${input.sections.des ? `${totalDes} nokta` : 'rapora dahil değil'}`,
      `Bağımsız nokta: ${input.sections.standalonePoints ? input.standalonePoints.length : 0}`,
      `Saha kaydı: ${input.sections.fieldPoints ? fieldPoints.length : 0}`,
      `Harita kaynağı: ${mapSourceLabel(input)}`,
    ]
    bottomNotes.forEach((noteLine, index) => pdf.text(t(noteLine), MARGIN + 7 + (index % 2) * 88, lowerY + 33 + Math.floor(index / 2) * 9))
  }
  footer(2)

  return pdf
}

export async function exportProjectPdf(input: ProjectReportInput) {
  const pdf = await buildProjectPdf(input)
  pdf.save(`${input.filename}-rapor.pdf`)
}
