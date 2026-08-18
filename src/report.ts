import { analyzePolygon, formatNumber, formatPoint } from './geo'
import type { PolygonLayer } from './types'

export interface ReportMetadata {
  projectName: string
  client: string
  location: string
  notes: string
}

function safePdfText(value: string) {
  return value
    .replaceAll('İ', 'I').replaceAll('ı', 'i')
    .replaceAll('Ş', 'S').replaceAll('ş', 's')
    .replaceAll('Ğ', 'G').replaceAll('ğ', 'g')
    .replaceAll('Ü', 'U').replaceAll('ü', 'u')
    .replaceAll('Ö', 'O').replaceAll('ö', 'o')
    .replaceAll('Ç', 'C').replaceAll('ç', 'c')
}

async function captureMapImage() {
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
        'map-mode-actions',
        'coordinate-card',
        'measurement-card',
        'locate-button',
        'gps-accuracy',
        'map-crosshair',
      ].some((className) => element.classList?.contains(className)),
    })
    return canvas.toDataURL('image/jpeg', 0.82)
  } catch {
    return null
  }
}

function drawVectorOverview(pdf: import('jspdf').jsPDF, polygons: PolygonLayer[], x: number, y: number, width: number, height: number) {
  pdf.setFillColor(242, 247, 250)
  pdf.roundedRect(x, y, width, height, 2, 2, 'F')
  const points = polygons.flatMap((layer) => layer.points)
  if (!points.length) return
  const minLat = Math.min(...points.map((point) => point.lat))
  const maxLat = Math.max(...points.map((point) => point.lat))
  const minLng = Math.min(...points.map((point) => point.lng))
  const maxLng = Math.max(...points.map((point) => point.lng))
  const latSpan = Math.max(maxLat - minLat, 0.000001)
  const lngSpan = Math.max(maxLng - minLng, 0.000001)
  const padding = 7
  const project = (lat: number, lng: number) => ({
    x: x + padding + ((lng - minLng) / lngSpan) * (width - padding * 2),
    y: y + height - padding - ((lat - minLat) / latSpan) * (height - padding * 2),
  })
  polygons.forEach((layer) => {
    if (layer.points.length < 2) return
    const color = layer.color.replace('#', '')
    pdf.setDrawColor(Number.parseInt(color.slice(0, 2), 16), Number.parseInt(color.slice(2, 4), 16), Number.parseInt(color.slice(4, 6), 16))
    pdf.setLineWidth(Math.max(0.35, (layer.strokeWidth ?? 3) * 0.18))
    const projected = layer.points.map((point) => project(point.lat, point.lng))
    projected.slice(1).forEach((point, index) => pdf.line(projected[index].x, projected[index].y, point.x, point.y))
    if (layer.points.length >= 3) pdf.line(projected[projected.length - 1].x, projected[projected.length - 1].y, projected[0].x, projected[0].y)
  })
}

export async function exportProjectPdf({
  polygons,
  filename,
  metadata,
  includeMap,
}: {
  polygons: PolygonLayer[]
  filename: string
  metadata: ReportMetadata
  includeMap: boolean
}) {
  const { jsPDF } = await import('jspdf')
  const pdf = new jsPDF({ unit: 'mm', format: 'a4', compress: true })
  const pageWidth = pdf.internal.pageSize.getWidth()
  const pageHeight = pdf.internal.pageSize.getHeight()
  const margin = 15
  const contentWidth = pageWidth - margin * 2
  const totalPoints = polygons.reduce((sum, layer) => sum + layer.points.length, 0)
  const totalArea = polygons.reduce((sum, layer) => sum + analyzePolygon(layer.points).areaM2, 0)
  const mapImage = includeMap ? await captureMapImage() : null

  const header = (subtitle: string) => {
    pdf.setFillColor(28, 116, 201)
    pdf.rect(0, 0, pageWidth, 14, 'F')
    pdf.setTextColor(255, 255, 255)
    pdf.setFont('helvetica', 'bold')
    pdf.setFontSize(12)
    pdf.text('EVREN JEOFIZIK HIZMETLERI', margin, 9)
    pdf.setFont('helvetica', 'normal')
    pdf.setFontSize(8)
    pdf.text(safePdfText(subtitle), pageWidth - margin, 9, { align: 'right' })
    pdf.setTextColor(30, 41, 59)
  }

  header('Saha Koordinat ve Poligon Raporu')
  pdf.setFont('helvetica', 'bold')
  pdf.setFontSize(19)
  pdf.text(safePdfText(metadata.projectName || 'Jeofizik Saha Projesi'), margin, 27)
  pdf.setFont('helvetica', 'normal')
  pdf.setFontSize(9)
  const details = [
    metadata.client && `Musteri: ${metadata.client}`,
    metadata.location && `Konum: ${metadata.location}`,
    `Rapor tarihi: ${new Date().toLocaleString('tr-TR')}`,
  ].filter(Boolean).map((item) => safePdfText(item as string))
  pdf.text(details, margin, 34)

  let y = details.length ? 34 + details.length * 4.5 + 3 : 39
  if (includeMap) {
    const mapHeight = 78
    if (mapImage) pdf.addImage(mapImage, 'JPEG', margin, y, contentWidth, mapHeight, undefined, 'FAST')
    else drawVectorOverview(pdf, polygons, margin, y, contentWidth, mapHeight)
    pdf.setDrawColor(203, 213, 225)
    pdf.rect(margin, y, contentWidth, mapHeight)
    y += mapHeight + 8
  }

  pdf.setFillColor(239, 246, 255)
  pdf.roundedRect(margin, y, contentWidth, 18, 2, 2, 'F')
  const summaries = [
    ['Poligon', String(polygons.length)],
    ['Toplam Nokta', String(totalPoints)],
    ['Toplam Alan', `${formatNumber(totalArea, 2)} m2`],
  ]
  summaries.forEach(([label, value], index) => {
    const cellX = margin + index * (contentWidth / 3)
    pdf.setFontSize(7); pdf.setTextColor(100, 116, 139); pdf.text(label, cellX + 5, y + 6)
    pdf.setFontSize(11); pdf.setFont('helvetica', 'bold'); pdf.setTextColor(30, 64, 175); pdf.text(value, cellX + 5, y + 13)
    pdf.setFont('helvetica', 'normal')
  })
  y += 25

  pdf.setFont('helvetica', 'bold'); pdf.setFontSize(11); pdf.setTextColor(30, 41, 59)
  pdf.text('POLIGON OZETI', margin, y); y += 6
  polygons.forEach((layer, index) => {
    const analysis = analyzePolygon(layer.points)
    if (y > pageHeight - 20) { pdf.addPage(); header('Poligon Ozeti'); y = 23 }
    if (index % 2 === 0) { pdf.setFillColor(248, 250, 252); pdf.rect(margin, y - 4, contentWidth, 8, 'F') }
    pdf.setFontSize(8); pdf.setTextColor(30, 41, 59)
    pdf.text(safePdfText(layer.name), margin + 2, y)
    pdf.text(`${layer.points.length} nokta`, margin + 75, y)
    pdf.text(`${formatNumber(analysis.areaM2, 2)} m2`, margin + 105, y)
    pdf.text(`${formatNumber(analysis.perimeterM, 2)} m`, pageWidth - margin - 2, y, { align: 'right' })
    y += 8
  })

  if (metadata.notes.trim()) {
    y += 3
    if (y > pageHeight - 40) { pdf.addPage(); header('Proje Notlari'); y = 23 }
    pdf.setFont('helvetica', 'bold'); pdf.setFontSize(10); pdf.text('PROJE NOTLARI', margin, y); y += 5
    pdf.setFont('helvetica', 'normal'); pdf.setFontSize(8)
    const lines = pdf.splitTextToSize(safePdfText(metadata.notes), contentWidth)
    pdf.text(lines, margin, y)
  }

  polygons.forEach((layer) => {
    const analysis = analyzePolygon(layer.points)
    pdf.addPage()
    header(layer.name)
    let rowY = 23
    pdf.setFont('helvetica', 'bold'); pdf.setFontSize(15)
    pdf.text(safePdfText(layer.name), margin, rowY); rowY += 7
    pdf.setFont('helvetica', 'normal'); pdf.setFontSize(8)
    pdf.text(`${layer.points.length} nokta  |  Alan ${formatNumber(analysis.areaM2, 2)} m2  |  Cevre ${formatNumber(analysis.perimeterM, 2)} m`, margin, rowY); rowY += 9

    const tableHeader = () => {
      pdf.setFillColor(226, 232, 240); pdf.rect(margin, rowY - 4, contentWidth, 7, 'F')
      pdf.setFont('helvetica', 'bold'); pdf.setFontSize(7)
      pdf.text('NO', margin + 2, rowY)
      pdf.text('ENLEM / BOYLAM', margin + 14, rowY)
      pdf.text('UTM KOORDINATI', margin + 87, rowY)
      pdf.setFont('helvetica', 'normal'); rowY += 7
    }
    tableHeader()
    layer.points.forEach((point, index) => {
      if (rowY > pageHeight - 17) { pdf.addPage(); header(`${layer.name} · Koordinatlar`); rowY = 23; tableHeader() }
      if (index % 2 === 0) { pdf.setFillColor(248, 250, 252); pdf.rect(margin, rowY - 4, contentWidth, 6, 'F') }
      pdf.setFontSize(7)
      pdf.text(String(index + 1), margin + 2, rowY)
      pdf.text(`${point.lat.toFixed(7)}, ${point.lng.toFixed(7)}`, margin + 14, rowY)
      pdf.text(formatPoint(point, 'utm'), margin + 87, rowY)
      rowY += 6
    })

    if (analysis.edgeLengths.length) {
      rowY += 4
      if (rowY > pageHeight - 35) { pdf.addPage(); header(`${layer.name} · Kenarlar`); rowY = 23 }
      pdf.setFont('helvetica', 'bold'); pdf.setFontSize(10); pdf.text('KENAR UZUNLUKLARI VE AZIMUTLAR', margin, rowY); rowY += 7
      analysis.edgeLengths.forEach((length, index) => {
        if (rowY > pageHeight - 17) { pdf.addPage(); header(`${layer.name} · Kenarlar`); rowY = 23 }
        pdf.setFont('helvetica', 'normal'); pdf.setFontSize(8)
        pdf.text(`K${index + 1}`, margin + 2, rowY)
        pdf.text(`${formatNumber(length, 2)} m`, margin + 22, rowY)
        pdf.text(`${formatNumber(analysis.edgeBearings[index], 2)} derece`, margin + 70, rowY)
        rowY += 6
      })
    }
  })

  const pageCount = pdf.getNumberOfPages()
  for (let page = 1; page <= pageCount; page += 1) {
    pdf.setPage(page)
    pdf.setDrawColor(226, 232, 240); pdf.line(margin, pageHeight - 10, pageWidth - margin, pageHeight - 10)
    pdf.setFontSize(7); pdf.setTextColor(100, 116, 139)
    pdf.text('Evren Jeofizik GIS', margin, pageHeight - 5)
    pdf.text(`${page} / ${pageCount}`, pageWidth - margin, pageHeight - 5, { align: 'right' })
  }

  pdf.save(`${filename}-rapor.pdf`)
}
