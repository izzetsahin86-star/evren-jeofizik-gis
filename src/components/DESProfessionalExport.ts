import JSZip from 'jszip'
import { jsPDF } from 'jspdf'
import {
  curveTypeFromLayers,
  logRms,
  prepareObserved,
  responseFor,
  type DesLayerModel,
  type ObservedPoint,
} from './DESProfessionalEngine'

export type DesReportRecord = {
  id: string
  name: string
  number: number | null
  fileName: string
  province: string
  district: string
  easting: number | null
  northing: number | null
  elevation: number | null
  zone: number
  hemisphere: 'N' | 'S'
  note: string
  measurements: Array<{ ab2: number; mn: number; rho: number }>
}

export type DesReportSnapshot = {
  record: DesReportRecord
  layers: DesLayerModel[]
}

export type DesReportFormat = 'pdf' | 'docx'

const PAGE_WIDTH = 1782
const PAGE_HEIGHT = 1260
const PAGE_MARGIN = 58
const HEADER_HEIGHT = 92
const FOOTER_HEIGHT = 34
const GAP = 24

function cloneLayers(layers: DesLayerModel[]) {
  return layers.map((layer) => ({ ...layer }))
}

function createCanvas(width: number, height: number) {
  const canvas = document.createElement('canvas')
  canvas.width = width
  canvas.height = height
  return canvas
}

function roundedRect(ctx: CanvasRenderingContext2D, x: number, y: number, width: number, height: number, radius: number) {
  const r = Math.min(radius, width / 2, height / 2)
  ctx.beginPath()
  ctx.moveTo(x + r, y)
  ctx.lineTo(x + width - r, y)
  ctx.quadraticCurveTo(x + width, y, x + width, y + r)
  ctx.lineTo(x + width, y + height - r)
  ctx.quadraticCurveTo(x + width, y + height, x + width - r, y + height)
  ctx.lineTo(x + r, y + height)
  ctx.quadraticCurveTo(x, y + height, x, y + height - r)
  ctx.lineTo(x, y + r)
  ctx.quadraticCurveTo(x, y, x + r, y)
  ctx.closePath()
}

function niceLogTicks(min: number, max: number) {
  const values: number[] = []
  const start = Math.floor(Math.log10(min)) - 1
  const end = Math.ceil(Math.log10(max)) + 1
  for (let power = start; power <= end; power += 1) {
    ;[1, 2, 5].forEach((multiplier) => {
      const value = multiplier * 10 ** power
      if (value >= min && value <= max) values.push(value)
    })
  }
  return values
}

function formatTick(value: number) {
  if (value >= 1000) return `${Number((value / 1000).toPrecision(2))}k`
  if (value < 1) return Number(value.toPrecision(2)).toString()
  return Number(value.toPrecision(3)).toString()
}

function drawCurveCanvas(observed: ObservedPoint[], response: number[]) {
  const canvas = createCanvas(1040, 510)
  const ctx = canvas.getContext('2d')!
  ctx.fillStyle = '#ffffff'
  ctx.fillRect(0, 0, canvas.width, canvas.height)

  const allY = [...observed.map((point) => point.rho), ...response.filter((value) => value > 0)]
  const minX = Math.max(0.1, Math.min(...observed.map((point) => point.ab2)) * 0.86)
  const maxX = Math.max(...observed.map((point) => point.ab2)) * 1.16
  const minY = Math.max(0.01, Math.min(...allY) * 0.72)
  const maxY = Math.max(...allY) * 1.38
  const left = 82
  const right = 26
  const top = 28
  const bottom = 64
  const innerW = canvas.width - left - right
  const innerH = canvas.height - top - bottom
  const lx0 = Math.log10(minX)
  const lx1 = Math.log10(maxX)
  const ly0 = Math.log10(minY)
  const ly1 = Math.log10(maxY)
  const x = (value: number) => left + (Math.log10(value) - lx0) / Math.max(0.001, lx1 - lx0) * innerW
  const y = (value: number) => top + (ly1 - Math.log10(Math.max(0.001, value))) / Math.max(0.001, ly1 - ly0) * innerH

  ctx.fillStyle = '#f7fafc'
  ctx.fillRect(left, top, innerW, innerH)
  ctx.lineWidth = 1
  ctx.strokeStyle = '#d9e3e8'
  ctx.fillStyle = '#607786'
  ctx.font = '18px Arial, sans-serif'
  ctx.textBaseline = 'middle'
  niceLogTicks(minX, maxX).forEach((tick) => {
    const px = x(tick)
    ctx.beginPath()
    ctx.moveTo(px, top)
    ctx.lineTo(px, top + innerH)
    ctx.stroke()
    ctx.textAlign = 'center'
    ctx.fillText(formatTick(tick), px, top + innerH + 28)
  })
  niceLogTicks(minY, maxY).forEach((tick) => {
    const py = y(tick)
    ctx.beginPath()
    ctx.moveTo(left, py)
    ctx.lineTo(left + innerW, py)
    ctx.stroke()
    ctx.textAlign = 'right'
    ctx.fillText(formatTick(tick), left - 12, py)
  })

  ctx.strokeStyle = '#5d7480'
  ctx.lineWidth = 2
  ctx.beginPath()
  ctx.moveTo(left, top)
  ctx.lineTo(left, top + innerH)
  ctx.lineTo(left + innerW, top + innerH)
  ctx.stroke()

  ctx.strokeStyle = '#9aafb9'
  ctx.lineWidth = 2
  ctx.setLineDash([7, 8])
  ctx.beginPath()
  observed.forEach((point, index) => {
    const px = x(point.ab2)
    const py = y(point.rho)
    if (index === 0) ctx.moveTo(px, py)
    else ctx.lineTo(px, py)
  })
  ctx.stroke()
  ctx.setLineDash([])

  ctx.strokeStyle = '#e99424'
  ctx.lineWidth = 4
  ctx.lineJoin = 'round'
  ctx.lineCap = 'round'
  ctx.beginPath()
  observed.forEach((point, index) => {
    const px = x(point.ab2)
    const py = y(response[index] || point.rho)
    if (index === 0) ctx.moveTo(px, py)
    else ctx.lineTo(px, py)
  })
  ctx.stroke()

  observed.forEach((point) => {
    ctx.beginPath()
    ctx.arc(x(point.ab2), y(point.rho), 6, 0, Math.PI * 2)
    ctx.fillStyle = '#ffffff'
    ctx.fill()
    ctx.strokeStyle = '#1a9bb8'
    ctx.lineWidth = 3
    ctx.stroke()
  })

  ctx.fillStyle = '#425d6b'
  ctx.font = '700 19px Arial, sans-serif'
  ctx.textAlign = 'center'
  ctx.fillText('AB/2 (m) · log', left + innerW / 2, canvas.height - 18)
  ctx.save()
  ctx.translate(20, top + innerH / 2)
  ctx.rotate(-Math.PI / 2)
  ctx.fillText('ρa (Ωm) · log', 0, 0)
  ctx.restore()

  const legendY = 16
  ctx.font = '700 17px Arial, sans-serif'
  ctx.textAlign = 'left'
  ctx.fillStyle = '#526a76'
  ctx.fillText('Gözlenen', 100, legendY)
  ctx.strokeStyle = '#1a9bb8'
  ctx.lineWidth = 4
  ctx.beginPath(); ctx.moveTo(62, legendY); ctx.lineTo(88, legendY); ctx.stroke()
  ctx.fillText('Hesaplanan 1B', 250, legendY)
  ctx.strokeStyle = '#e99424'
  ctx.beginPath(); ctx.moveTo(212, legendY); ctx.lineTo(238, legendY); ctx.stroke()
  return canvas
}

function rhoHue(rho: number, min: number, max: number) {
  const lo = Math.log10(Math.max(0.1, min))
  const hi = Math.log10(Math.max(min * 1.01, max))
  const t = (Math.log10(Math.max(0.1, rho)) - lo) / Math.max(0.001, hi - lo)
  return 210 - Math.max(0, Math.min(1, t)) * 175
}

function wrapText(ctx: CanvasRenderingContext2D, text: string, maxWidth: number, maxLines = 2) {
  const words = text.trim().split(/\s+/).filter(Boolean)
  const lines: string[] = []
  let current = ''
  words.forEach((word) => {
    const test = current ? `${current} ${word}` : word
    if (ctx.measureText(test).width <= maxWidth || !current) current = test
    else { lines.push(current); current = word }
  })
  if (current) lines.push(current)
  if (lines.length <= maxLines) return lines
  const clipped = lines.slice(0, maxLines)
  clipped[maxLines - 1] = `${clipped[maxLines - 1].replace(/…$/, '')}…`
  while (ctx.measureText(clipped[maxLines - 1]).width > maxWidth && clipped[maxLines - 1].length > 2) {
    clipped[maxLines - 1] = `${clipped[maxLines - 1].slice(0, -2)}…`
  }
  return clipped
}

function drawLayerCanvas(layers: DesLayerModel[]) {
  const canvas = createCanvas(520, 510)
  const ctx = canvas.getContext('2d')!
  ctx.fillStyle = '#ffffff'
  ctx.fillRect(0, 0, canvas.width, canvas.height)
  const finiteDepth = layers.slice(0, -1).reduce((sum, layer) => sum + (layer.thickness || 0), 0)
  const maxDepth = Math.max(10, finiteDepth * 1.18)
  const minRho = Math.min(...layers.map((layer) => layer.rho))
  const maxRho = Math.max(...layers.map((layer) => layer.rho))
  const axisX = 72
  const colX = 104
  const colY = 26
  const colW = canvas.width - colX - 24
  const colH = canvas.height - 50

  ctx.fillStyle = '#f5f8fa'
  roundedRect(ctx, colX, colY, colW, colH, 10)
  ctx.fill()
  ctx.strokeStyle = '#b9cbd4'
  ctx.lineWidth = 2
  ctx.stroke()
  ctx.fillStyle = '#627987'
  ctx.font = '17px Arial, sans-serif'
  ctx.textAlign = 'right'
  ctx.textBaseline = 'middle'
  ctx.fillText('0 m', axisX, colY + 8)
  ctx.fillText(`${(maxDepth / 2).toFixed(0)} m`, axisX, colY + colH / 2)
  ctx.fillText(`${maxDepth.toFixed(0)} m`, axisX, colY + colH - 8)

  let topDepth = 0
  let pixelY = colY
  layers.forEach((layer, index) => {
    const start = topDepth
    const thickness = layer.thickness ?? Math.max(12, maxDepth - start)
    topDepth += layer.thickness || 0
    const height = index === layers.length - 1
      ? Math.max(34, colY + colH - pixelY)
      : Math.max(34, thickness / maxDepth * colH)
    const hue = rhoHue(layer.rho, minRho, maxRho)
    ctx.fillStyle = `hsl(${hue} 55% 38%)`
    ctx.fillRect(colX + 2, pixelY + 1, colW - 4, Math.max(12, height - 1))
    ctx.strokeStyle = 'rgba(255,255,255,.62)'
    ctx.lineWidth = 1
    ctx.beginPath(); ctx.moveTo(colX + 2, pixelY + height); ctx.lineTo(colX + colW - 2, pixelY + height); ctx.stroke()

    const lineHeight = 21
    const availableH = Math.max(30, height)
    ctx.fillStyle = '#ffffff'
    ctx.textAlign = 'left'
    ctx.font = '700 18px Arial, sans-serif'
    ctx.fillText(`${index + 1}. Tabaka · ${layer.rho.toFixed(1)} Ωm`, colX + 14, pixelY + Math.min(23, availableH / 2))
    ctx.font = '15px Arial, sans-serif'
    const depthLabel = layer.thickness === null ? `${start.toFixed(1)} m +` : `${start.toFixed(1)}–${(start + thickness).toFixed(1)} m`
    if (availableH >= 50) ctx.fillText(depthLabel, colX + 14, pixelY + 44)
    if (layer.interpretation && availableH >= 78) {
      ctx.font = 'italic 14px Arial, sans-serif'
      wrapText(ctx, layer.interpretation, colW - 28, 2).forEach((line, lineIndex) => {
        ctx.fillText(line, colX + 14, pixelY + 66 + lineIndex * lineHeight)
      })
    }
    pixelY += height
  })
  return canvas
}

function drawFitted(ctx: CanvasRenderingContext2D, image: HTMLCanvasElement, x: number, y: number, width: number, height: number) {
  const scale = Math.min(width / image.width, height / image.height)
  const targetW = image.width * scale
  const targetH = image.height * scale
  ctx.drawImage(image, x + (width - targetW) / 2, y + (height - targetH) / 2, targetW, targetH)
}

function reportData(snapshot: DesReportSnapshot) {
  const layers = cloneLayers(snapshot.layers)
  const observed = prepareObserved(snapshot.record.measurements)
  const response = responseFor(observed, layers)
  return {
    snapshot: { record: snapshot.record, layers },
    observed,
    response,
    rms: logRms(observed, response),
    curveType: curveTypeFromLayers(layers),
  }
}

function drawReportCard(
  ctx: CanvasRenderingContext2D,
  data: ReturnType<typeof reportData>,
  x: number,
  y: number,
  width: number,
  height: number,
) {
  roundedRect(ctx, x, y, width, height, 18)
  ctx.fillStyle = '#ffffff'
  ctx.fill()
  ctx.strokeStyle = '#cbdbe3'
  ctx.lineWidth = 2
  ctx.stroke()

  const pad = 18
  const titleY = y + 28
  ctx.fillStyle = '#102b3a'
  ctx.font = '700 24px Arial, sans-serif'
  ctx.textAlign = 'left'
  ctx.textBaseline = 'middle'
  ctx.fillText(data.snapshot.record.name, x + pad, titleY)

  const location = [data.snapshot.record.province, data.snapshot.record.district].filter(Boolean).join(' · ')
  const meta = `${location ? `${location} · ` : ''}Log RMS ${Number.isFinite(data.rms) ? data.rms.toFixed(2) : '–'}% · Eğri ${data.curveType} · ${data.snapshot.layers.length} tabaka`
  ctx.fillStyle = '#607786'
  ctx.font = '16px Arial, sans-serif'
  ctx.fillText(meta, x + pad, titleY + 28)

  const chartTop = y + 72
  const chartHeight = height - 90
  const curveWidth = Math.max(100, (width - pad * 2 - 14) * 0.68)
  const modelWidth = Math.max(80, width - pad * 2 - 14 - curveWidth)
  const curve = drawCurveCanvas(data.observed, data.response)
  const model = drawLayerCanvas(data.snapshot.layers)

  ctx.save()
  roundedRect(ctx, x + pad, chartTop, curveWidth, chartHeight, 10)
  ctx.clip()
  ctx.fillStyle = '#f8fbfc'
  ctx.fillRect(x + pad, chartTop, curveWidth, chartHeight)
  drawFitted(ctx, curve, x + pad + 4, chartTop + 4, curveWidth - 8, chartHeight - 8)
  ctx.restore()
  ctx.strokeStyle = '#d8e4e9'
  roundedRect(ctx, x + pad, chartTop, curveWidth, chartHeight, 10)
  ctx.stroke()

  const modelX = x + pad + curveWidth + 14
  ctx.save()
  roundedRect(ctx, modelX, chartTop, modelWidth, chartHeight, 10)
  ctx.clip()
  ctx.fillStyle = '#f8fbfc'
  ctx.fillRect(modelX, chartTop, modelWidth, chartHeight)
  drawFitted(ctx, model, modelX + 4, chartTop + 4, modelWidth - 8, chartHeight - 8)
  ctx.restore()
  ctx.strokeStyle = '#d8e4e9'
  roundedRect(ctx, modelX, chartTop, modelWidth, chartHeight, 10)
  ctx.stroke()
}

function renderReportPages(snapshots: DesReportSnapshot[], perPage: 1 | 2 | 3 | 4) {
  const data = snapshots.map(reportData)
  const pages: HTMLCanvasElement[] = []
  for (let offset = 0; offset < data.length; offset += perPage) {
    const chunk = data.slice(offset, offset + perPage)
    const page = createCanvas(PAGE_WIDTH, PAGE_HEIGHT)
    const ctx = page.getContext('2d')!
    ctx.fillStyle = '#eef4f7'
    ctx.fillRect(0, 0, PAGE_WIDTH, PAGE_HEIGHT)

    ctx.fillStyle = '#0b2433'
    ctx.fillRect(0, 0, PAGE_WIDTH, HEADER_HEIGHT)
    ctx.fillStyle = '#ffffff'
    ctx.font = '700 30px Arial, sans-serif'
    ctx.textAlign = 'left'
    ctx.textBaseline = 'middle'
    ctx.fillText('EVREN JEOFİZİK · DES PROFESSIONAL', PAGE_MARGIN, 36)
    ctx.fillStyle = '#98c3d6'
    ctx.font = '17px Arial, sans-serif'
    ctx.fillText('Gözlenen / Hesaplanan Eğri + 1B Elektriksel Model', PAGE_MARGIN, 67)
    ctx.textAlign = 'right'
    ctx.fillStyle = '#d8edf5'
    ctx.fillText(`${offset + 1}–${offset + chunk.length} / ${data.length} DES`, PAGE_WIDTH - PAGE_MARGIN, 51)

    const contentTop = HEADER_HEIGHT + 22
    const contentBottom = PAGE_HEIGHT - FOOTER_HEIGHT - 18
    const contentW = PAGE_WIDTH - PAGE_MARGIN * 2
    const contentH = contentBottom - contentTop
    const cols = perPage <= 2 ? 1 : 2
    const rows = perPage === 1 ? 1 : 2
    const cellW = (contentW - GAP * (cols - 1)) / cols
    const cellH = (contentH - GAP * (rows - 1)) / rows

    chunk.forEach((item, index) => {
      const col = index % cols
      const row = Math.floor(index / cols)
      drawReportCard(ctx, item, PAGE_MARGIN + col * (cellW + GAP), contentTop + row * (cellH + GAP), cellW, cellH)
    })

    ctx.fillStyle = '#607786'
    ctx.font = '15px Arial, sans-serif'
    ctx.textAlign = 'left'
    ctx.fillText('Rapor, Professional Studio ekranındaki son model durumundan üretilmiştir.', PAGE_MARGIN, PAGE_HEIGHT - 16)
    ctx.textAlign = 'right'
    ctx.fillText(`Sayfa ${pages.length + 1}`, PAGE_WIDTH - PAGE_MARGIN, PAGE_HEIGHT - 16)
    pages.push(page)
  }
  return pages
}

function canvasBlob(canvas: HTMLCanvasElement, type: string, quality?: number) {
  return new Promise<Blob>((resolve, reject) => {
    canvas.toBlob((blob) => blob ? resolve(blob) : reject(new Error('Rapor görseli oluşturulamadı.')), type, quality)
  })
}

function safeFilePart(value: string) {
  const normalized = value.normalize('NFKD').replace(/[\u0300-\u036f]/g, '')
  return normalized.replace(/[^A-Za-z0-9_-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 80) || 'DES'
}

function fileBaseName(snapshots: DesReportSnapshot[]) {
  if (snapshots.length === 1) return `${safeFilePart(snapshots[0].record.name)}-Professional-DES`
  const stamp = new Date().toISOString().slice(0, 10)
  return `Evren-DES-Professional-${snapshots.length}-DES-${stamp}`
}

function downloadBlob(blob: Blob, filename: string) {
  const url = URL.createObjectURL(blob)
  const link = document.createElement('a')
  link.href = url
  link.download = filename
  document.body.appendChild(link)
  link.click()
  link.remove()
  window.setTimeout(() => URL.revokeObjectURL(url), 1200)
}

async function exportPdf(pages: HTMLCanvasElement[], filename: string) {
  const pdf = new jsPDF({ orientation: 'landscape', unit: 'mm', format: 'a4', compress: true })
  pages.forEach((page, index) => {
    if (index > 0) pdf.addPage('a4', 'landscape')
    pdf.addImage(page.toDataURL('image/jpeg', 0.92), 'JPEG', 0, 0, 297, 210, undefined, 'FAST')
  })
  pdf.save(filename)
}

function docxImageParagraph(rId: string, index: number) {
  const cx = 9940000
  const cy = 7028640
  return `<w:p><w:pPr><w:jc w:val="center"/><w:spacing w:before="0" w:after="0"/></w:pPr><w:r><w:drawing><wp:inline distT="0" distB="0" distL="0" distR="0"><wp:extent cx="${cx}" cy="${cy}"/><wp:effectExtent l="0" t="0" r="0" b="0"/><wp:docPr id="${index}" name="DES Professional Sayfa ${index}"/><wp:cNvGraphicFramePr><a:graphicFrameLocks xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" noChangeAspect="1"/></wp:cNvGraphicFramePr><a:graphic xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"><a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/picture"><pic:pic xmlns:pic="http://schemas.openxmlformats.org/drawingml/2006/picture"><pic:nvPicPr><pic:cNvPr id="${index}" name="page-${index}.jpg"/><pic:cNvPicPr/></pic:nvPicPr><pic:blipFill><a:blip r:embed="${rId}"/><a:stretch><a:fillRect/></a:stretch></pic:blipFill><pic:spPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="${cx}" cy="${cy}"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom></pic:spPr></pic:pic></a:graphicData></a:graphic></wp:inline></w:drawing></w:r></w:p>`
}

async function exportDocx(pages: HTMLCanvasElement[], filename: string) {
  const zip = new JSZip()
  const rels = pages.map((_, index) => `<Relationship Id="rId${index + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="media/page-${index + 1}.jpg"/>`).join('')
  const body = pages.map((_, index) => `${docxImageParagraph(`rId${index + 1}`, index + 1)}${index < pages.length - 1 ? '<w:p><w:r><w:br w:type="page"/></w:r></w:p>' : ''}`).join('')
  const now = new Date().toISOString()

  zip.file('[Content_Types].xml', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Default Extension="jpg" ContentType="image/jpeg"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/><Override PartName="/docProps/core.xml" ContentType="application/vnd.openxmlformats-package.core-properties+xml"/><Override PartName="/docProps/app.xml" ContentType="application/vnd.openxmlformats-officedocument.extended-properties+xml"/></Types>`)
  zip.folder('_rels')!.file('.rels', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties" Target="docProps/core.xml"/><Relationship Id="rId3" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/extended-properties" Target="docProps/app.xml"/></Relationships>`)
  zip.folder('word')!.file('document.xml', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" xmlns:wp="http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:pic="http://schemas.openxmlformats.org/drawingml/2006/picture"><w:body>${body}<w:sectPr><w:pgSz w:w="16838" w:h="11906" w:orient="landscape"/><w:pgMar w:top="300" w:right="300" w:bottom="300" w:left="300" w:header="0" w:footer="0" w:gutter="0"/></w:sectPr></w:body></w:document>`)
  zip.folder('word')!.folder('_rels')!.file('document.xml.rels', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${rels}</Relationships>`)
  zip.folder('docProps')!.file('core.xml', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:dcterms="http://purl.org/dc/terms/" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"><dc:title>Evren Jeofizik DES Professional Raporu</dc:title><dc:creator>Evren Jeofizik GIS</dc:creator><dcterms:created xsi:type="dcterms:W3CDTF">${now}</dcterms:created><dcterms:modified xsi:type="dcterms:W3CDTF">${now}</dcterms:modified></cp:coreProperties>`)
  zip.folder('docProps')!.file('app.xml', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Properties xmlns="http://schemas.openxmlformats.org/officeDocument/2006/extended-properties" xmlns:vt="http://schemas.openxmlformats.org/officeDocument/2006/docPropsVTypes"><Application>Evren Jeofizik GIS</Application><Pages>${pages.length}</Pages></Properties>`)

  const media = zip.folder('word')!.folder('media')!
  await Promise.all(pages.map(async (page, index) => media.file(`page-${index + 1}.jpg`, await canvasBlob(page, 'image/jpeg', 0.92))))
  const blob = await zip.generateAsync({ type: 'blob', compression: 'DEFLATE', compressionOptions: { level: 6 }, mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' })
  downloadBlob(blob, filename)
}

export async function exportDesProfessionalReport(
  snapshots: DesReportSnapshot[],
  perPage: 1 | 2 | 3 | 4,
  format: DesReportFormat,
) {
  if (!snapshots.length) throw new Error('Dışa aktarılacak DES seçilmedi.')
  const safePerPage = Math.max(1, Math.min(4, Math.round(perPage))) as 1 | 2 | 3 | 4
  const clean = snapshots
    .filter((snapshot) => snapshot.layers.length >= 3 && snapshot.record.measurements.length >= 3)
    .map((snapshot) => ({ record: snapshot.record, layers: cloneLayers(snapshot.layers) }))
  if (!clean.length) throw new Error('Raporlanabilir DES modeli bulunamadı.')
  const pages = renderReportPages(clean, safePerPage)
  const base = fileBaseName(clean)
  if (format === 'pdf') await exportPdf(pages, `${base}.pdf`)
  else await exportDocx(pages, `${base}.docx`)
  return { pages: pages.length, desCount: clean.length }
}
