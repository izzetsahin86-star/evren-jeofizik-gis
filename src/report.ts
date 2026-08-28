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

interface ReportPhoto {
  title: string
  caption: string
  dataUrl: string
  width: number
  height: number
}

interface ValidationRow {
  polygon: string
  status: string
  details: string
}

const FONT_REGULAR = '/fonts/EvrenSans.ttf'
const FONT_BOLD = '/fonts/EvrenSans-Bold.ttf'
const LOGO_URL = '/icons/evren-jeofizik-logo.svg'
const PAGE_MARGIN = 15
const HEADER_HEIGHT = 15
const FOOTER_Y = 287
const CONTENT_BOTTOM = 279

function arrayBufferToBase64(buffer: ArrayBuffer) {
  const bytes = new Uint8Array(buffer)
  let binary = ''
  const chunkSize = 0x8000
  for (let offset = 0; offset < bytes.length; offset += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + chunkSize))
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
    pdf.setFont('EvrenSans', 'normal')
    return { family: 'EvrenSans', text: (value: string) => value }
  } catch {
    pdf.setFont('helvetica', 'normal')
    return { family: 'helvetica', text: fallbackPdfText }
  }
}

async function loadLogoDataUrl() {
  try {
    const response = await fetch(LOGO_URL)
    if (!response.ok) return null
    const svg = await response.text()
    return svg.match(/data:image\/(?:jpeg|jpg);base64,([^"']+)/i)?.[1]
      ? `data:image/jpeg;base64,${svg.match(/data:image\/(?:jpeg|jpg);base64,([^"']+)/i)?.[1]}`
      : null
  } catch {
    return null
  }
}

async function captureMapImage() {
  if (typeof document === 'undefined') return null
  const map = document.querySelector<HTMLElement>('.map-shell')
  if (!map) return null
  try {
    const { default: html2canvas } = await import('html2canvas')
    const canvas = await html2canvas(map, {
      useCORS: true,
      allowTaint: false,
      backgroundColor: '#e7eff3',
      logging: false,
      scale: Math.min(1.5, window.devicePixelRatio || 1),
      ignoreElements: (element) => [
        'smart-map-tools',
        'coordinate-card',
        'smart-measurement-sheet',
        'locate-button',
        'gps-accuracy',
        'map-crosshair',
        'bottom-panel',
        'smart-dock',
      ].some((className) => element.classList?.contains(className)),
    })
    return canvas.toDataURL('image/jpeg', 0.84)
  } catch {
    return null
  }
}

function imageBlobToJpeg(blob: Blob) {
  return new Promise<ReportPhoto>((resolve, reject) => {
    const reader = new FileReader()
    reader.onerror = () => reject(new Error('Fotoğraf okunamadı.'))
    reader.onload = () => {
      const image = new Image()
      image.onerror = () => reject(new Error('Fotoğraf çözümlenemedi.'))
      image.onload = () => {
        const maxDimension = 1800
        const scale = Math.min(1, maxDimension / Math.max(image.naturalWidth, image.naturalHeight))
        const width = Math.max(1, Math.round(image.naturalWidth * scale))
        const height = Math.max(1, Math.round(image.naturalHeight * scale))
        const canvas = document.createElement('canvas')
        canvas.width = width
        canvas.height = height
        canvas.getContext('2d')?.drawImage(image, 0, 0, width, height)
        resolve({ title: '', caption: '', dataUrl: canvas.toDataURL('image/jpeg', 0.82), width, height })
      }
      image.src = String(reader.result)
    }
    reader.readAsDataURL(blob)
  })
}

function hexToRgb(color: string) {
  const normalized = color.replace('#', '').padEnd(6, '0')
  return [0, 2, 4].map((offset) => Number.parseInt(normalized.slice(offset, offset + 2), 16)) as [number, number, number]
}

function areaDetails(areaM2: number) {
  return {
    hectares: `${formatNumber(areaM2 / 10_000, 4)} ha`,
    secondary: `${formatNumber(areaM2, 2)} m² · ${formatNumber(areaM2 / 1_000, 3)} da · ${formatNumber(areaM2 / 1_000_000, 6)} km²`,
  }
}

function routeDuration(route: RouteArchiveItem) {
  return Math.max(0, route.finishedAt - route.startedAt - route.totalPausedMs)
}

function formatDuration(milliseconds: number) {
  const totalSeconds = Math.round(milliseconds / 1000)
  const hours = Math.floor(totalSeconds / 3600)
  const minutes = Math.floor((totalSeconds % 3600) / 60)
  const seconds = totalSeconds % 60
  return [hours ? `${hours} sa` : '', minutes ? `${minutes} dk` : '', `${seconds} sn`].filter(Boolean).join(' ')
}

function mapSourceLabel(input: ProjectReportInput) {
  const base: Record<BaseLayerId, string> = {
    street: 'Standart harita',
    satellite: 'Uydu haritası',
    topographic: 'Topoğrafik harita',
  }
  const sources = [base[input.baseLayer]]
  if (input.mtaIndex25Visible) sources.push('MTA İNDEKS 1/25.000')
  if (input.mtaIndex100Visible) sources.push('MTA İNDEKS 1/100.000')
  return sources.join(' · ')
}

function allOverviewPoints(polygons: PolygonLayer[], standalone: GeoPoint[], field: ReportFieldPoint[], routes: RouteArchiveItem[]) {
  return [
    ...polygons.flatMap((layer) => [...layer.points, ...layer.desPoints]),
    ...standalone,
    ...field.map((point) => ({ id: point.id, lat: point.lat, lng: point.lng })),
    ...routes.flatMap((route) => route.points.map((point, index) => ({ id: `${route.id}-${index}`, lat: point.lat, lng: point.lng }))),
  ]
}

function drawNorthArrow(pdf: import('jspdf').jsPDF, x: number, y: number, text: (value: string) => string) {
  pdf.setDrawColor(15, 23, 42)
  pdf.setFillColor(15, 23, 42)
  pdf.triangle(x, y, x - 3, y + 10, x + 3, y + 10, 'F')
  pdf.setFillColor(255, 255, 255)
  pdf.triangle(x, y + 3, x - 1.2, y + 8, x + 1.2, y + 8, 'F')
  pdf.setFontSize(8)
  pdf.text(text('K'), x, y - 2, { align: 'center' })
}

function drawScaleBar(pdf: import('jspdf').jsPDF, x: number, y: number, points: Array<Pick<GeoPoint, 'lat' | 'lng'>>, text: (value: string) => string) {
  if (!points.length) return
  const minLng = Math.min(...points.map((point) => point.lng))
  const maxLng = Math.max(...points.map((point) => point.lng))
  const averageLat = points.reduce((sum, point) => sum + point.lat, 0) / points.length
  const extentM = Math.max(50, (maxLng - minLng) * 111_320 * Math.cos(averageLat * Math.PI / 180))
  const candidates = [10, 20, 50, 100, 200, 500, 1_000, 2_000, 5_000, 10_000, 20_000, 50_000, 100_000]
  const target = extentM / 4
  const distance = candidates.reduce((best, item) => Math.abs(item - target) < Math.abs(best - target) ? item : best, candidates[0])
  pdf.setLineWidth(0.7)
  pdf.setDrawColor(15, 23, 42)
  pdf.line(x, y, x + 28, y)
  pdf.line(x, y - 2, x, y + 2)
  pdf.line(x + 14, y - 2, x + 14, y + 2)
  pdf.line(x + 28, y - 2, x + 28, y + 2)
  pdf.setFontSize(6.5)
  pdf.text('0', x, y + 5)
  pdf.text(text(distance >= 1_000 ? `${formatNumber(distance / 1_000, 1)} km` : `${distance} m`), x + 28, y + 5, { align: 'right' })
}

function drawVectorOverview(
  pdf: import('jspdf').jsPDF,
  data: { polygons: PolygonLayer[]; standalone: GeoPoint[]; field: ReportFieldPoint[]; routes: RouteArchiveItem[] },
  x: number,
  y: number,
  width: number,
  height: number,
) {
  pdf.setFillColor(239, 246, 248)
  pdf.roundedRect(x, y, width, height, 2, 2, 'F')
  const points = allOverviewPoints(data.polygons, data.standalone, data.field, data.routes)
  if (!points.length) return points
  const minLat = Math.min(...points.map((point) => point.lat))
  const maxLat = Math.max(...points.map((point) => point.lat))
  const minLng = Math.min(...points.map((point) => point.lng))
  const maxLng = Math.max(...points.map((point) => point.lng))
  const latSpan = Math.max(maxLat - minLat, 0.000001)
  const lngSpan = Math.max(maxLng - minLng, 0.000001)
  const padding = 10
  const project = (lat: number, lng: number) => ({
    x: x + padding + ((lng - minLng) / lngSpan) * (width - padding * 2),
    y: y + height - padding - ((lat - minLat) / latSpan) * (height - padding * 2),
  })

  data.polygons.forEach((layer) => {
    if (layer.points.length < 2) return
    const [red, green, blue] = hexToRgb(layer.color)
    pdf.setDrawColor(red, green, blue)
    pdf.setLineWidth(Math.max(0.35, (layer.strokeWidth ?? 3) * 0.18))
    const projected = layer.points.map((point) => project(point.lat, point.lng))
    projected.slice(1).forEach((point, index) => pdf.line(projected[index].x, projected[index].y, point.x, point.y))
    if (layer.points.length >= 3) pdf.line(projected.at(-1)!.x, projected.at(-1)!.y, projected[0].x, projected[0].y)
    pdf.setFillColor(red, green, blue)
    projected.forEach((point) => pdf.circle(point.x, point.y, 0.9, 'F'))
    pdf.setFillColor(22, 163, 74)
    layer.desPoints.forEach((point) => {
      const projectedDes = project(point.lat, point.lng)
      pdf.circle(projectedDes.x, projectedDes.y, 1, 'F')
    })
  })

  data.routes.forEach((route) => {
    if (route.points.length < 2) return
    pdf.setDrawColor(234, 88, 12)
    pdf.setLineWidth(0.65)
    const routePoints = route.points.map((point) => project(point.lat, point.lng))
    routePoints.slice(1).forEach((point, index) => pdf.line(routePoints[index].x, routePoints[index].y, point.x, point.y))
  })
  pdf.setFillColor(250, 204, 21)
  data.standalone.forEach((point) => {
    const projected = project(point.lat, point.lng)
    pdf.circle(projected.x, projected.y, 1.3, 'F')
  })
  pdf.setFillColor(126, 34, 206)
  data.field.forEach((point) => {
    const projected = project(point.lat, point.lng)
    pdf.circle(projected.x, projected.y, 1.3, 'F')
  })
  return points
}

function validationRows(polygons: PolygonLayer[]): ValidationRow[] {
  return polygons.map((layer) => {
    const expectedZone = layer.utmZone ?? dominantUtmZone(layer.points)
    const issues = validateCoordinates(layer.points, expectedZone)
    if (!issues.length) return { polygon: layer.name, status: 'Hata bulunmadı', details: `Zone ${expectedZone} · ${layer.points.length} nokta` }
    const counts = new Map<string, number>()
    issues.forEach((issue) => counts.set(issue.title.split(' · ')[0], (counts.get(issue.title.split(' · ')[0]) ?? 0) + 1))
    return {
      polygon: layer.name,
      status: `${issues.length} uyarı`,
      details: Array.from(counts, ([name, count]) => `${name}: ${count}`).join(' · '),
    }
  })
}

async function collectPhotos(manual: File[], fieldPoints: ReportFieldPoint[]) {
  const manualPhotos = await Promise.all(manual.map(async (file, index) => {
    const photo = await imageBlobToJpeg(file)
    return { ...photo, title: `Proje Fotoğrafı ${index + 1}`, caption: file.name }
  }))
  const fieldPhotos = await Promise.all(fieldPoints.filter((point) => point.photoId).map(async (point) => {
    const blob = await readReportFieldPhoto(point.photoId!)
    if (!blob) return null
    const photo = await imageBlobToJpeg(blob)
    return { ...photo, title: point.name, caption: point.note || point.description || 'Saha noktası fotoğrafı' }
  }))
  return [...manualPhotos, ...fieldPhotos.filter((photo): photo is ReportPhoto => Boolean(photo))]
}

export async function buildProjectPdf(input: ProjectReportInput) {
  const { jsPDF } = await import('jspdf')
  const pdf = new jsPDF({ unit: 'mm', format: 'a4', compress: true })
  const font = await installTurkishFonts(pdf)
  const t = font.text
  const selectedIds = new Set(input.selectedPolygonIds)
  const polygons = input.polygons.filter((layer) => selectedIds.has(layer.id))
  const fieldPoints = input.fieldPoints ?? readReportFieldPoints()
  const routes = input.routes ?? readRouteArchive()
  const activeFieldPoints = input.sections.fieldPoints || input.sections.photos ? fieldPoints : []
  const activeRoutes = input.sections.routes ? routes : []
  const mapImagePromise = input.sections.map && polygons.length === input.polygons.length ? captureMapImage() : Promise.resolve(null)
  const logoPromise = loadLogoDataUrl()
  const photosPromise = input.sections.photos ? collectPhotos(input.manualPhotos, activeFieldPoints) : Promise.resolve([])
  const [mapImage, logo, photos] = await Promise.all([mapImagePromise, logoPromise, photosPromise])
  const pageWidth = pdf.internal.pageSize.getWidth()
  const contentWidth = pageWidth - PAGE_MARGIN * 2
  const totalPoints = polygons.reduce((sum, layer) => sum + layer.points.length, 0)
  const totalDes = polygons.reduce((sum, layer) => sum + layer.desPoints.length, 0)
  const totalArea = polygons.reduce((sum, layer) => sum + analyzePolygon(layer.points).areaM2, 0)
  const overviewData = { polygons, standalone: input.standalonePoints, field: activeFieldPoints, routes: activeRoutes }

  const setFont = (style: 'normal' | 'bold' = 'normal') => pdf.setFont(font.family, style)
  const header = (subtitle: string) => {
    pdf.setFillColor(13, 98, 82)
    pdf.rect(0, 0, pageWidth, HEADER_HEIGHT, 'F')
    pdf.setTextColor(255, 255, 255)
    setFont('bold')
    pdf.setFontSize(11)
    pdf.text(t('EVREN JEOFİZİK HİZMETLERİ'), PAGE_MARGIN, 9.5)
    setFont()
    pdf.setFontSize(7.5)
    pdf.text(t(subtitle), pageWidth - PAGE_MARGIN, 9.5, { align: 'right' })
    pdf.setTextColor(30, 41, 59)
  }
  const newPage = (subtitle: string) => {
    pdf.addPage()
    header(subtitle)
    return 24
  }
  const sectionTitle = (title: string, y: number) => {
    pdf.setFillColor(236, 253, 245)
    pdf.roundedRect(PAGE_MARGIN, y - 5, contentWidth, 9, 1.5, 1.5, 'F')
    pdf.setTextColor(6, 95, 70)
    setFont('bold')
    pdf.setFontSize(10)
    pdf.text(t(title), PAGE_MARGIN + 3, y + 1)
    pdf.setTextColor(30, 41, 59)
    setFont()
    return y + 9
  }
  const tableHeader = (labels: Array<{ label: string; x: number }>, y: number) => {
    pdf.setFillColor(226, 232, 240)
    pdf.rect(PAGE_MARGIN, y - 4.5, contentWidth, 7, 'F')
    setFont('bold')
    pdf.setFontSize(6.8)
    labels.forEach((column) => pdf.text(t(column.label), PAGE_MARGIN + column.x, y))
    setFont()
    return y + 7
  }

  // Kurumsal kapak
  pdf.setFillColor(13, 98, 82)
  pdf.rect(0, 0, pageWidth, 42, 'F')
  if (logo) {
    try { pdf.addImage(logo, 'JPEG', PAGE_MARGIN, 12, 34, 22, undefined, 'FAST') } catch { /* Vektör başlık yeterlidir. */ }
  }
  pdf.setTextColor(255, 255, 255)
  setFont('bold')
  pdf.setFontSize(17)
  pdf.text(t('EVREN JEOFİZİK HİZMETLERİ'), logo ? 54 : PAGE_MARGIN, 23)
  setFont()
  pdf.setFontSize(9)
  pdf.text(t('Gelişmiş Saha GIS Raporu'), logo ? 54 : PAGE_MARGIN, 31)
  pdf.setTextColor(15, 23, 42)
  setFont('bold')
  pdf.setFontSize(22)
  const projectTitle = pdf.splitTextToSize(t(input.metadata.projectName || 'Jeofizik Saha Projesi'), contentWidth)
  pdf.text(projectTitle, PAGE_MARGIN, 63)
  setFont()
  pdf.setFontSize(9)
  const titleBottom = 63 + projectTitle.length * 8
  const coverRows = [
    ['Rapor No', input.metadata.reportNumber || '-'],
    ['Müşteri', input.metadata.client || '-'],
    ['Çalışma Alanı', input.metadata.location || '-'],
    ['Hazırlayan', input.metadata.preparedBy || 'Evren Jeofizik'],
    ['Rapor Tarihi', new Date().toLocaleString('tr-TR')],
  ]
  let coverY = titleBottom + 8
  coverRows.forEach(([label, value], index) => {
    if (index % 2 === 0) { pdf.setFillColor(248, 250, 252); pdf.rect(PAGE_MARGIN, coverY - 5, contentWidth, 10, 'F') }
    setFont('bold'); pdf.text(t(label), PAGE_MARGIN + 3, coverY)
    setFont(); pdf.text(t(value), PAGE_MARGIN + 48, coverY)
    coverY += 10
  })
  coverY += 10
  pdf.setFillColor(240, 253, 250)
  pdf.roundedRect(PAGE_MARGIN, coverY, contentWidth, 36, 2, 2, 'F')
  const cards = [
    ['Poligon', String(polygons.length)],
    ['Toplam Nokta', String(totalPoints)],
    ['Toplam Alan', areaDetails(totalArea).hectares],
    ['DES Noktası', String(totalDes)],
  ]
  cards.forEach(([label, value], index) => {
    const x = PAGE_MARGIN + index * (contentWidth / cards.length) + 5
    pdf.setTextColor(71, 85, 105); pdf.setFontSize(7); setFont(); pdf.text(t(label), x, coverY + 12)
    pdf.setTextColor(6, 95, 70); pdf.setFontSize(12); setFont('bold'); pdf.text(t(value), x, coverY + 24)
  })
  if (input.metadata.notes.trim()) {
    pdf.setTextColor(30, 41, 59); setFont('bold'); pdf.setFontSize(9); pdf.text(t('PROJE NOTLARI'), PAGE_MARGIN, coverY + 50)
    setFont(); pdf.setFontSize(8)
    pdf.text(pdf.splitTextToSize(t(input.metadata.notes), contentWidth), PAGE_MARGIN, coverY + 57)
  }

  // Gelişmiş harita sayfası
  if (input.sections.map) {
    let y = newPage('Genel Yerleşim Haritası')
    y = sectionTitle('GENEL YERLEŞİM HARİTASI', y)
    const mapHeight = 152
    if (mapImage) {
      try { pdf.addImage(mapImage, 'JPEG', PAGE_MARGIN, y, contentWidth, mapHeight, undefined, 'FAST') } catch { drawVectorOverview(pdf, overviewData, PAGE_MARGIN, y, contentWidth, mapHeight) }
    } else {
      drawVectorOverview(pdf, overviewData, PAGE_MARGIN, y, contentWidth, mapHeight)
    }
    pdf.setDrawColor(148, 163, 184); pdf.rect(PAGE_MARGIN, y, contentWidth, mapHeight)
    const mapPoints = allOverviewPoints(polygons, input.standalonePoints, activeFieldPoints, activeRoutes)
    drawNorthArrow(pdf, pageWidth - PAGE_MARGIN - 12, y + 12, t)
    drawScaleBar(pdf, PAGE_MARGIN + 8, y + mapHeight - 11, mapPoints, t)
    y += mapHeight + 8
    pdf.setFontSize(7.5); setFont('bold'); pdf.text(t('Koordinat sistemi:'), PAGE_MARGIN, y)
    setFont(); pdf.text(t('WGS84 (EPSG:4326) · UTM zonu poligon bazında otomatik belirlenir'), PAGE_MARGIN + 32, y)
    y += 5
    setFont('bold'); pdf.text(t('Harita kaynağı:'), PAGE_MARGIN, y)
    setFont(); pdf.text(t(mapSourceLabel(input)), PAGE_MARGIN + 29, y)
    y += 8
    const legend = [
      ['Poligon ve köşe noktaları', 21, 151, 229],
      ['DES noktaları', 22, 163, 74],
      ['Bağımsız noktalar', 250, 204, 21],
      ['Saha noktaları', 126, 34, 206],
      ['Rotalar', 234, 88, 12],
    ] as const
    legend.forEach(([label, red, green, blue], index) => {
      const x = PAGE_MARGIN + (index % 3) * 61
      const rowY = y + Math.floor(index / 3) * 7
      pdf.setFillColor(red, green, blue); pdf.circle(x + 2, rowY - 1, 1.5, 'F')
      pdf.setTextColor(51, 65, 85); pdf.text(t(label), x + 6, rowY)
    })
  }

  // Poligon özeti
  let y = newPage('Poligon ve Alan Özeti')
  y = sectionTitle('POLİGON VE ALAN ÖZETİ', y)
  y = tableHeader([{ label: 'POLİGON', x: 2 }, { label: 'NOKTA', x: 75 }, { label: 'ALAN (HEKTAR)', x: 99 }, { label: 'ÇEVRE', x: 151 }], y)
  polygons.forEach((layer, index) => {
    if (y > CONTENT_BOTTOM - 9) { y = newPage('Poligon ve Alan Özeti'); y = tableHeader([{ label: 'POLİGON', x: 2 }, { label: 'NOKTA', x: 75 }, { label: 'ALAN (HEKTAR)', x: 99 }, { label: 'ÇEVRE', x: 151 }], y) }
    const analysis = analyzePolygon(layer.points)
    if (index % 2 === 0) { pdf.setFillColor(248, 250, 252); pdf.rect(PAGE_MARGIN, y - 4.5, contentWidth, 9, 'F') }
    pdf.setFontSize(7.5); setFont(); pdf.text(t(layer.name), PAGE_MARGIN + 2, y)
    pdf.text(String(layer.points.length), PAGE_MARGIN + 75, y)
    setFont('bold'); pdf.text(t(areaDetails(analysis.areaM2).hectares), PAGE_MARGIN + 99, y)
    setFont(); pdf.text(t(`${formatNumber(analysis.perimeterM, 2)} m`), PAGE_MARGIN + 151, y)
    y += 9
  })
  y += 3
  pdf.setFillColor(240, 253, 250); pdf.roundedRect(PAGE_MARGIN, y, contentWidth, 20, 2, 2, 'F')
  setFont('bold'); pdf.setFontSize(10); pdf.setTextColor(6, 95, 70); pdf.text(t(`Toplam: ${areaDetails(totalArea).hectares}`), PAGE_MARGIN + 5, y + 8)
  setFont(); pdf.setFontSize(7.5); pdf.setTextColor(71, 85, 105); pdf.text(t(areaDetails(totalArea).secondary), PAGE_MARGIN + 5, y + 15)

  // Poligon detay, koordinat ve kenar tabloları
  polygons.forEach((layer) => {
    const analysis = analyzePolygon(layer.points)
    const zone = layer.utmZone ?? dominantUtmZone(layer.points)
    let rowY = newPage(layer.name)
    rowY = sectionTitle(layer.name.toLocaleUpperCase('tr-TR'), rowY)
    setFont('bold'); pdf.setFontSize(10); pdf.text(t(areaDetails(analysis.areaM2).hectares), PAGE_MARGIN, rowY)
    setFont(); pdf.setFontSize(7.5); pdf.text(t(areaDetails(analysis.areaM2).secondary), PAGE_MARGIN + 33, rowY)
    rowY += 6
    pdf.text(t(`Çevre: ${formatNumber(analysis.perimeterM, 2)} m · Datum: WGS84 · UTM Zone: ${zone} · Yarımküre: ${layer.points[0]?.lat >= 0 ? 'N' : 'S'} · Dönüşüm: EPSG:4326 - UTM`), PAGE_MARGIN, rowY)
    rowY += 9
    const coordinateHeader = () => tableHeader([{ label: 'NO', x: 2 }, { label: 'ENLEM / BOYLAM', x: 14 }, { label: `UTM ${zone}${layer.points[0]?.lat >= 0 ? 'N' : 'S'}`, x: 86 }], rowY)
    rowY = coordinateHeader()
    layer.points.forEach((point, index) => {
      if (rowY > CONTENT_BOTTOM - 7) { rowY = newPage(`${layer.name} · Koordinatlar`); rowY = coordinateHeader() }
      if (index % 2 === 0) { pdf.setFillColor(248, 250, 252); pdf.rect(PAGE_MARGIN, rowY - 4.5, contentWidth, 6.5, 'F') }
      pdf.setFontSize(7); setFont(); pdf.text(String(index + 1), PAGE_MARGIN + 2, rowY)
      pdf.text(`${point.lat.toFixed(7)}, ${point.lng.toFixed(7)}`, PAGE_MARGIN + 14, rowY)
      pdf.text(formatPoint(point, 'utm', zone), PAGE_MARGIN + 86, rowY)
      rowY += 6.5
    })
    if (analysis.edgeLengths.length) {
      rowY += 4
      if (rowY > CONTENT_BOTTOM - 30) rowY = newPage(`${layer.name} · Kenarlar`)
      rowY = sectionTitle('KENAR UZUNLUKLARI VE AZİMUTLAR', rowY)
      rowY = tableHeader([{ label: 'KENAR', x: 2 }, { label: 'UZUNLUK', x: 38 }, { label: 'AZİMUT', x: 92 }], rowY)
      analysis.edgeLengths.forEach((length, index) => {
        if (rowY > CONTENT_BOTTOM - 7) { rowY = newPage(`${layer.name} · Kenarlar`); rowY = tableHeader([{ label: 'KENAR', x: 2 }, { label: 'UZUNLUK', x: 38 }, { label: 'AZİMUT', x: 92 }], rowY) }
        pdf.setFontSize(7.5); pdf.text(`K${index + 1}`, PAGE_MARGIN + 2, rowY)
        pdf.text(t(`${formatNumber(length, 2)} m`), PAGE_MARGIN + 38, rowY)
        pdf.text(t(`${formatNumber(analysis.edgeBearings[index], 2)}°`), PAGE_MARGIN + 92, rowY)
        rowY += 6.5
      })
    }
  })

  // DES planı
  if (input.sections.des) {
    const desPolygons = polygons.filter((layer) => layer.desPoints.length)
    desPolygons.forEach((layer) => {
      const zone = layer.utmZone ?? dominantUtmZone(layer.points)
      let desY = newPage(`${layer.name} · DES Planı`)
      desY = sectionTitle(`DES PLANI · ${layer.name}`, desY)
      setFont('bold'); pdf.setFontSize(9); pdf.text(t(`${layer.desPoints.length} DES noktası`), PAGE_MARGIN, desY)
      setFont(); pdf.setFontSize(7.5); pdf.text(t(`WGS84 · UTM ${zone}${layer.desPoints[0]?.lat >= 0 ? 'N' : 'S'}`), PAGE_MARGIN + 43, desY)
      desY += 7
      drawVectorOverview(pdf, { polygons: [layer], standalone: [], field: [], routes: [] }, PAGE_MARGIN, desY, contentWidth, 78)
      pdf.setDrawColor(148, 163, 184); pdf.rect(PAGE_MARGIN, desY, contentWidth, 78)
      desY += 86
      const desHeader = () => tableHeader([{ label: 'DES', x: 2 }, { label: 'ENLEM / BOYLAM', x: 22 }, { label: 'UTM', x: 91 }], desY)
      desY = desHeader()
      layer.desPoints.forEach((point, index) => {
        if (desY > CONTENT_BOTTOM - 7) { desY = newPage(`${layer.name} · DES Koordinatları`); desY = desHeader() }
        if (index % 2 === 0) { pdf.setFillColor(248, 250, 252); pdf.rect(PAGE_MARGIN, desY - 4.5, contentWidth, 6.5, 'F') }
        pdf.setFontSize(7); pdf.text(String(index + 1), PAGE_MARGIN + 2, desY)
        pdf.text(`${point.lat.toFixed(7)}, ${point.lng.toFixed(7)}`, PAGE_MARGIN + 22, desY)
        pdf.text(formatPoint(point, 'utm', zone), PAGE_MARGIN + 91, desY)
        desY += 6.5
      })
    })
  }

  // Bağımsız ve saha noktaları
  const pointRows = [
    ...(input.sections.standalonePoints ? input.standalonePoints.map((point, index) => ({ type: 'Nokta', name: point.name || `Nokta ${index + 1}`, symbol: 'Sarı raptiye', note: '', point })) : []),
    ...(input.sections.fieldPoints ? fieldPoints.map((point) => ({ type: 'Saha', name: point.name, symbol: point.symbol, note: point.note || point.description, point })) : []),
  ]
  if (pointRows.length) {
    let pointY = newPage('Nokta Kayıtları')
    pointY = sectionTitle('NOKTA KAYITLARI', pointY)
    pointRows.forEach((row, index) => {
      const rowHeight = row.note ? 20 : 15
      if (pointY > CONTENT_BOTTOM - rowHeight) pointY = newPage('Nokta Kayıtları')
      if (index % 2 === 0) { pdf.setFillColor(248, 250, 252); pdf.roundedRect(PAGE_MARGIN, pointY - 4, contentWidth, rowHeight - 2, 1, 1, 'F') }
      setFont('bold'); pdf.setFontSize(8); pdf.text(t(`${row.name} · ${row.type}`), PAGE_MARGIN + 3, pointY)
      setFont(); pdf.setFontSize(7); pdf.text(t(`Simge: ${row.symbol}`), PAGE_MARGIN + 75, pointY)
      pointY += 5
      pdf.text(`${row.point.lat.toFixed(7)}, ${row.point.lng.toFixed(7)}`, PAGE_MARGIN + 3, pointY)
      pdf.text(formatPoint({ id: row.point.id, lat: row.point.lat, lng: row.point.lng }, 'utm'), PAGE_MARGIN + 75, pointY)
      if (row.note) { pointY += 5; pdf.text(pdf.splitTextToSize(t(`Not: ${row.note}`), contentWidth - 6), PAGE_MARGIN + 3, pointY) }
      pointY += row.note ? 10 : 8
    })
  }

  // Koordinat hata kontrolü özeti
  if (input.sections.validation) {
    const rows = validationRows(polygons)
    let validationY = newPage('Koordinat Hata Kontrolü')
    validationY = sectionTitle('KOORDİNAT HATA KONTROLÜ', validationY)
    pdf.setFontSize(7.5); setFont(); pdf.text(t('Kontroller: tekrarlanan nokta, UTM zonu, ters enlem-boylam, sıra dışı mesafe ve kesişen kenarlar.'), PAGE_MARGIN, validationY)
    validationY += 10
    rows.forEach((row, index) => {
      const detailLines = pdf.splitTextToSize(t(row.details), contentWidth - 8)
      const rowHeight = 13 + detailLines.length * 4
      if (validationY > CONTENT_BOTTOM - rowHeight) validationY = newPage('Koordinat Hata Kontrolü')
      pdf.setFillColor(row.status === 'Hata bulunmadı' ? 240 : 255, row.status === 'Hata bulunmadı' ? 253 : 247, row.status === 'Hata bulunmadı' ? 244 : 237)
      pdf.roundedRect(PAGE_MARGIN, validationY - 4, contentWidth, rowHeight, 1.5, 1.5, 'F')
      setFont('bold'); pdf.setFontSize(8); pdf.setTextColor(30, 41, 59); pdf.text(t(row.polygon), PAGE_MARGIN + 3, validationY + 1)
      pdf.setTextColor(row.status === 'Hata bulunmadı' ? 21 : 185, row.status === 'Hata bulunmadı' ? 128 : 28, row.status === 'Hata bulunmadı' ? 61 : 28)
      pdf.text(t(row.status), pageWidth - PAGE_MARGIN - 3, validationY + 1, { align: 'right' })
      setFont(); pdf.setFontSize(7); pdf.setTextColor(71, 85, 105); pdf.text(detailLines, PAGE_MARGIN + 3, validationY + 7)
      validationY += rowHeight + 3
      void index
    })
  }

  // Rota arşivi
  if (input.sections.routes) {
    let routeY = newPage('Rota Arşivi')
    routeY = sectionTitle('GELİŞMİŞ ROTA KAYITLARI', routeY)
    if (!routes.length) {
      pdf.setFontSize(8); pdf.text(t('Arşivlenmiş rota bulunmuyor.'), PAGE_MARGIN, routeY)
    } else {
      drawVectorOverview(pdf, { polygons: [], standalone: [], field: [], routes }, PAGE_MARGIN, routeY, contentWidth, 76)
      pdf.setDrawColor(148, 163, 184); pdf.rect(PAGE_MARGIN, routeY, contentWidth, 76)
      routeY += 84
      routeY = tableHeader([{ label: 'ROTA', x: 2 }, { label: 'TARİH', x: 58 }, { label: 'MESAFE', x: 104 }, { label: 'SÜRE', x: 139 }, { label: 'NOKTA', x: 168 }], routeY)
      routes.forEach((route, index) => {
        if (routeY > CONTENT_BOTTOM - 8) { routeY = newPage('Rota Arşivi'); routeY = tableHeader([{ label: 'ROTA', x: 2 }, { label: 'TARİH', x: 58 }, { label: 'MESAFE', x: 104 }, { label: 'SÜRE', x: 139 }, { label: 'NOKTA', x: 168 }], routeY) }
        if (index % 2 === 0) { pdf.setFillColor(248, 250, 252); pdf.rect(PAGE_MARGIN, routeY - 4.5, contentWidth, 8, 'F') }
        pdf.setFontSize(7); pdf.text(t(route.name), PAGE_MARGIN + 2, routeY)
        pdf.text(t(new Date(route.startedAt).toLocaleString('tr-TR')), PAGE_MARGIN + 58, routeY)
        pdf.text(t(`${formatNumber(route.distanceM / 1000, 2)} km`), PAGE_MARGIN + 104, routeY)
        pdf.text(t(formatDuration(routeDuration(route))), PAGE_MARGIN + 139, routeY)
        pdf.text(String(route.points.length), PAGE_MARGIN + 168, routeY)
        routeY += 8
      })
    }
  }

  // Fotoğraf sayfaları
  if (input.sections.photos) {
    if (!photos.length) {
      let photoY = newPage('Fotoğraflar')
      photoY = sectionTitle('FOTOĞRAFLAR', photoY)
      pdf.setFontSize(8); pdf.text(t('Seçilmiş proje veya saha fotoğrafı bulunmuyor.'), PAGE_MARGIN, photoY)
    } else {
      photos.forEach((photo) => {
        let photoY = newPage('Fotoğraflar')
        photoY = sectionTitle(photo.title, photoY)
        const maxWidth = contentWidth
        const maxHeight = 207
        const scale = Math.min(maxWidth / photo.width, maxHeight / photo.height)
        const width = photo.width * scale
        const height = photo.height * scale
        const x = PAGE_MARGIN + (contentWidth - width) / 2
        pdf.addImage(photo.dataUrl, 'JPEG', x, photoY, width, height, undefined, 'FAST')
        pdf.setDrawColor(203, 213, 225); pdf.rect(x, photoY, width, height)
        pdf.setFontSize(7.5); pdf.setTextColor(71, 85, 105); pdf.text(pdf.splitTextToSize(t(photo.caption), contentWidth), PAGE_MARGIN, photoY + height + 7)
      })
    }
  }

  const pageCount = pdf.getNumberOfPages()
  for (let page = 1; page <= pageCount; page += 1) {
    pdf.setPage(page)
    pdf.setDrawColor(226, 232, 240)
    pdf.line(PAGE_MARGIN, FOOTER_Y, pageWidth - PAGE_MARGIN, FOOTER_Y)
    pdf.setFontSize(6.8); pdf.setTextColor(100, 116, 139); setFont()
    pdf.text(t(`Evren Jeofizik GIS · Rapor No: ${input.metadata.reportNumber || '-'}`), PAGE_MARGIN, FOOTER_Y + 5)
    pdf.text(`${page} / ${pageCount}`, pageWidth - PAGE_MARGIN, FOOTER_Y + 5, { align: 'right' })
  }
  return pdf
}

export async function exportProjectPdf(input: ProjectReportInput) {
  const pdf = await buildProjectPdf(input)
  pdf.save(`${input.filename}-rapor.pdf`)
}
