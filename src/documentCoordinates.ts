import type { PDFPageProxy } from 'pdfjs-dist'
import { fromUtm } from './geo'

export type DocumentCoordinateFormat = 'Lat/Lon' | 'DMS' | 'DDM' | 'UTM'
export type DocumentCoordinateSource = 'Metin' | 'OCR'
export type DocumentCoordinateConfidence = 'high' | 'medium' | 'low'

export interface DocumentCoordinateCandidate {
  id: string
  lat: number
  lng: number
  format: DocumentCoordinateFormat
  raw: string
  source: string
  sourceKind: DocumentCoordinateSource
  name?: string
  group?: string
  confidence: number
  confidenceLevel: DocumentCoordinateConfidence
  reasons: string[]
  zone?: number
  hemisphere?: 'N' | 'S'
  datum?: string
  correctedOrder?: boolean
}

export interface DocumentCoordinateOptions {
  zone: number
  hemisphere: 'N' | 'S'
  datum: string
}

export interface DocumentScanProgress {
  percent: number
  label: string
}

export interface DocumentDetectionSummary {
  zone?: number
  hemisphere?: 'N' | 'S'
  datum?: string
  evidence: string[]
}

export interface DocumentScanStats {
  high: number
  medium: number
  low: number
  duplicatesRemoved: number
  tableRows: number
}

export interface DocumentScanResult {
  fileName: string
  pageCount: number
  usedOcr: boolean
  candidates: DocumentCoordinateCandidate[]
  detection: DocumentDetectionSummary
  stats: DocumentScanStats
  warning?: string
}

type ProgressHandler = (progress: DocumentScanProgress) => void
type CandidateInput = Omit<DocumentCoordinateCandidate, 'id' | 'confidenceLevel'>

type TextAnalysis = {
  candidates: DocumentCoordinateCandidate[]
  detection: DocumentDetectionSummary
  duplicatesRemoved: number
  tableRows: number
}

const MAX_FILE_BYTES = 30 * 1024 * 1024
const MAX_PDF_PAGES = 50
const MAX_OCR_PIXELS = 8_000_000
const TURKEY_BOUNDS = { south: 34.5, north: 43.2, west: 24.5, east: 46.5 }
const DECIMAL_TOKEN = /[-+]?\d{1,3}(?:[.,]\d{2,9})/g
const METRIC_TOKEN = /[-+]?(?:\d{1,3}(?:[.\s]\d{3})+|\d{5,8})(?:[.,]\d+)?/g
const DMS_PAIR = /(?:(\d{1,3})\s*[°º˚]\s*(\d{1,2})\s*['′’]\s*(\d{1,2}(?:[.,]\d+)?)\s*(?:["″“”])?\s*([NS])?)\s*[,;/|\s]+(?:(\d{1,3})\s*[°º˚]\s*(\d{1,2})\s*['′’]\s*(\d{1,2}(?:[.,]\d+)?)\s*(?:["″“”])?\s*([EW])?)/gi
const DDM_PAIR = /(?:(\d{1,3})\s*[°º˚]\s*(\d{1,2}(?:[.,]\d+)?)\s*['′’]?\s*([NS]))\s*[,;/|\s]+(?:(\d{1,3})\s*[°º˚]\s*(\d{1,2}(?:[.,]\d+)?)\s*['′’]?\s*([EW]))/gi
const DECIMAL_HEMISPHERE_PAIR = /([-+]?\d{1,3}(?:[.,]\d+)?)\s*[°º˚]?\s*([NS])\s*[,;/|\s]+([-+]?\d{1,3}(?:[.,]\d+)?)\s*[°º˚]?\s*([EW])/gi

function normalizeText(text: string) {
  return text
    .replace(/\u00a0/g, ' ')
    .replace(/[−–—]/g, '-')
    .replace(/[º˚]/g, '°')
    .replace(/[′’]/g, "'")
    .replace(/[″“”]/g, '"')
    .replace(/(?<=\d)[OoQ](?=\d)/g, '0')
    .replace(/(?<=\d)[Il|](?=\d)/g, '1')
    .replace(/(?<=\d)S(?=\d)/g, '5')
    .replace(/[ \t]+/g, ' ')
}

function parseDecimal(value: string) {
  return Number(value.replace(',', '.'))
}

function parseMetric(value: string) {
  const compact = value.trim().replace(/\s+/g, '')
  if (!compact) return Number.NaN
  const separators = Array.from(compact.matchAll(/[.,]/g), (match) => match.index ?? -1)
  if (separators.length > 1) {
    const last = separators.at(-1) ?? -1
    const fractionLength = compact.length - last - 1
    if (fractionLength > 0 && fractionLength < 3) {
      return Number(`${compact.slice(0, last).replace(/[.,]/g, '')}.${compact.slice(last + 1)}`)
    }
    return Number(compact.replace(/[.,]/g, ''))
  }
  const match = compact.match(/^([-+]?)(\d+)([.,])(\d+)$/)
  if (!match) return Number(compact)
  const [, sign, whole, , fraction] = match
  if (fraction.length === 3 && whole.length <= 3) return Number(`${sign}${whole}${fraction}`)
  return Number(`${sign}${whole}.${fraction}`)
}

function isValidLatLng(lat: number, lng: number) {
  return Number.isFinite(lat) && Number.isFinite(lng) && Math.abs(lat) <= 90 && Math.abs(lng) <= 180
}

function isTurkeyPoint(lat: number, lng: number) {
  return lat >= TURKEY_BOUNDS.south && lat <= TURKEY_BOUNDS.north && lng >= TURKEY_BOUNDS.west && lng <= TURKEY_BOUNDS.east
}

function isValidUtm(easting: number, northing: number, zone: number) {
  return Number.isFinite(easting) && Number.isFinite(northing)
    && zone >= 1 && zone <= 60
    && easting >= 100_000 && easting <= 900_000
    && northing >= 0 && northing <= 10_000_000
}

function confidenceLevel(value: number): DocumentCoordinateConfidence {
  if (value >= 85) return 'high'
  if (value >= 65) return 'medium'
  return 'low'
}

function clampConfidence(value: number) {
  return Math.max(10, Math.min(99, Math.round(value)))
}

function sourceLabel(base: string, line?: number) {
  return line ? `${base} · satır ${line}` : base
}

function inferPointName(line: string, coordinateStart = line.length) {
  const prefix = line.slice(0, coordinateStart).trim().replace(/[|;,:]+$/g, '').trim()
  if (!prefix || /^(?:x|y|easting|northing|enlem|boylam|lat|lon|lng|doğu|kuzey)$/i.test(prefix)) return undefined
  const explicit = prefix.match(/(?:^|\s)((?:DES|NOKTA|POINT|P|K|S|SONDAJ|İSTASYON|ISTASYON|ST|SP|TP|BH|KUYU)[-_. ]?\d+[A-Z]?|[A-Z]{1,4}[-_.]?\d{1,5}[A-Z]?)$/i)
  if (explicit) return explicit[1].replace(/\s+/g, ' ').trim().slice(0, 40)
  const firstCell = prefix.split(/[\t|;]/)[0]?.trim()
  if (firstCell && firstCell.length <= 32 && /[A-Za-zÇĞİÖŞÜçğıöşü]/.test(firstCell) && /\d/.test(firstCell)) return firstCell
  return undefined
}

function headingFromLine(line: string) {
  const clean = line.trim().replace(/[:;]+$/g, '')
  if (clean.length > 60) return undefined
  if (/^(?:parsel|poligon|alan|saha|blok|grup|hat|profil)\b/i.test(clean)) return clean.slice(0, 60)
  return undefined
}

function detectContext(rawText: string, fallback: DocumentCoordinateOptions): DocumentDetectionSummary {
  const text = normalizeText(rawText)
  const evidence: string[] = []
  let zone: number | undefined
  let hemisphere: 'N' | 'S' | undefined
  let datum: string | undefined

  const zoneMatch = text.match(/\b(?:UTM\s*)?(?:ZONE|ZON|D[İI]L[İI]M)\s*[:=-]?\s*([1-5]?\d|60)\s*([C-HJ-NP-X]|[NS])?\b/i)
    || text.match(/\b(3[4-9])\s*([NS])\b/i)
  if (zoneMatch) {
    const value = Number(zoneMatch[1])
    if (value >= 1 && value <= 60) {
      zone = value
      evidence.push(`Zone ${value} belgeden algılandı`)
    }
    const band = zoneMatch[2]?.toUpperCase()
    if (band) hemisphere = band === 'S' || (band.length === 1 && band < 'N') ? 'S' : 'N'
  }

  if (/\b(?:ED\s*[- ]?50|EUROPEAN\s+DATUM\s+1950)\b/i.test(text)) {
    datum = 'ED50'
    evidence.push('ED50 datum belgeden algılandı')
  } else if (/\b(?:WGS\s*[- ]?84|ITRF\d*|TUREF|ETRS\d*)\b/i.test(text)) {
    datum = 'WGS84'
    evidence.push(/WGS/i.test(text) ? 'WGS84 datum belgeden algılandı' : 'Modern datum WGS84 uyumlu kabul edildi')
  }

  if (!hemisphere) {
    if (/\b(?:KUZEY|NORTH|NORTHERN\s+HEMISPHERE)\b/i.test(text)) hemisphere = 'N'
    if (/\b(?:G[ÜU]NEY|SOUTH|SOUTHERN\s+HEMISPHERE)\b/i.test(text)) hemisphere = 'S'
  }

  return {
    zone: zone ?? fallback.zone,
    hemisphere: hemisphere ?? fallback.hemisphere,
    datum: datum ?? fallback.datum,
    evidence,
  }
}

function addCandidate(target: CandidateInput[], input: Omit<CandidateInput, 'confidence' | 'reasons'> & { confidence: number; reasons?: string[] }) {
  if (!isValidLatLng(input.lat, input.lng)) return
  let confidence = input.confidence
  const reasons = [...(input.reasons ?? [])]
  if (isTurkeyPoint(input.lat, input.lng)) {
    confidence += 8
    reasons.push('Türkiye sınırlarıyla tutarlı')
  }
  if (input.sourceKind === 'OCR') {
    confidence -= 5
    reasons.push('OCR sonucu')
  }
  target.push({ ...input, confidence: clampConfidence(confidence), reasons })
}

function extractDegreeCoordinates(text: string, source: string, sourceKind: DocumentCoordinateSource, target: CandidateInput[]) {
  for (const match of text.matchAll(DMS_PAIR)) {
    const latDeg = Number(match[1]); const latMin = Number(match[2]); const latSec = parseDecimal(match[3])
    const lngDeg = Number(match[5]); const lngMin = Number(match[6]); const lngSec = parseDecimal(match[7])
    if (latMin >= 60 || lngMin >= 60 || latSec >= 60 || lngSec >= 60) continue
    const latSign = match[4]?.toUpperCase() === 'S' ? -1 : 1
    const lngSign = match[8]?.toUpperCase() === 'W' ? -1 : 1
    const lat = latSign * (latDeg + latMin / 60 + latSec / 3600)
    const lng = lngSign * (lngDeg + lngMin / 60 + lngSec / 3600)
    const index = match.index ?? 0
    const lineNumber = text.slice(0, index).split('\n').length
    const line = text.split('\n')[lineNumber - 1] ?? match[0]
    addCandidate(target, { lat, lng, format: 'DMS', raw: match[0], source: sourceLabel(source, lineNumber), sourceKind, name: inferPointName(line, Math.max(0, line.indexOf(match[0]))), confidence: match[4] && match[8] ? 94 : 82, reasons: [match[4] && match[8] ? 'Yön harfleriyle DMS' : 'DMS koordinat çifti'] })
  }

  for (const match of text.matchAll(DDM_PAIR)) {
    const latDeg = Number(match[1]); const latMin = parseDecimal(match[2])
    const lngDeg = Number(match[4]); const lngMin = parseDecimal(match[5])
    if (latMin >= 60 || lngMin >= 60) continue
    const lat = (match[3].toUpperCase() === 'S' ? -1 : 1) * (latDeg + latMin / 60)
    const lng = (match[6].toUpperCase() === 'W' ? -1 : 1) * (lngDeg + lngMin / 60)
    const index = match.index ?? 0
    const lineNumber = text.slice(0, index).split('\n').length
    const line = text.split('\n')[lineNumber - 1] ?? match[0]
    addCandidate(target, { lat, lng, format: 'DDM', raw: match[0], source: sourceLabel(source, lineNumber), sourceKind, name: inferPointName(line, Math.max(0, line.indexOf(match[0]))), confidence: 94, reasons: ['Yön harfleriyle DDM'] })
  }

  for (const match of text.matchAll(DECIMAL_HEMISPHERE_PAIR)) {
    const lat = Math.abs(parseDecimal(match[1])) * (match[2].toUpperCase() === 'S' ? -1 : 1)
    const lng = Math.abs(parseDecimal(match[3])) * (match[4].toUpperCase() === 'W' ? -1 : 1)
    const index = match.index ?? 0
    const lineNumber = text.slice(0, index).split('\n').length
    const line = text.split('\n')[lineNumber - 1] ?? match[0]
    addCandidate(target, { lat, lng, format: 'Lat/Lon', raw: match[0], source: sourceLabel(source, lineNumber), sourceKind, name: inferPointName(line, Math.max(0, line.indexOf(match[0]))), confidence: 95, reasons: ['Enlem/boylam yön harfleriyle açık'] })
  }
}

function safeFromUtm(easting: number, northing: number, zone: number, hemisphere: 'N' | 'S', datum: string) {
  try {
    const point = fromUtm(easting, northing, zone, hemisphere, datum)
    return isValidLatLng(point.lat, point.lng) ? point : null
  } catch {
    return null
  }
}

function bestUtmOrder(a: number, b: number, zone: number, hemisphere: 'N' | 'S', datum: string) {
  const normal = isValidUtm(a, b, zone) ? safeFromUtm(a, b, zone, hemisphere, datum) : null
  const reverse = isValidUtm(b, a, zone) ? safeFromUtm(b, a, zone, hemisphere, datum) : null
  if (!normal && !reverse) return null
  if (normal && !reverse) return { point: normal, easting: a, northing: b, corrected: false }
  if (!normal && reverse) return { point: reverse!, easting: b, northing: a, corrected: true }
  const normalTurkey = normal ? isTurkeyPoint(normal.lat, normal.lng) : false
  const reverseTurkey = reverse ? isTurkeyPoint(reverse.lat, reverse.lng) : false
  if (reverseTurkey && !normalTurkey) return { point: reverse!, easting: b, northing: a, corrected: true }
  return { point: normal!, easting: a, northing: b, corrected: false }
}

function extractStructuredLines(text: string, source: string, sourceKind: DocumentCoordinateSource, options: DocumentCoordinateOptions, detection: DocumentDetectionSummary, target: CandidateInput[]) {
  const lines = text.split('\n')
  const zone = detection.zone ?? options.zone
  const hemisphere = detection.hemisphere ?? options.hemisphere
  const datum = detection.datum ?? options.datum
  let group: string | undefined
  let tableMode: 'utm' | 'latlon' | null = null
  let tableRows = 0

  lines.forEach((rawLine, lineIndex) => {
    const line = rawLine.trim()
    if (!line) return
    const heading = headingFromLine(line)
    if (heading) group = heading

    const hasUtmHeader = /\b(?:EASTING|NORTHING|DO[ĞG]U|KUZEY)\b/i.test(line) || (/\bX\b/i.test(line) && /\bY\b/i.test(line))
    const hasLatLonHeader = /\b(?:ENLEM|LAT(?:ITUDE)?)\b/i.test(line) && /\b(?:BOYLAM|LON(?:GITUDE)?|LNG)\b/i.test(line)
    if (hasUtmHeader && !METRIC_TOKEN.test(line)) { tableMode = 'utm'; METRIC_TOKEN.lastIndex = 0; return }
    METRIC_TOKEN.lastIndex = 0
    if (hasLatLonHeader && !DECIMAL_TOKEN.test(line)) { tableMode = 'latlon'; DECIMAL_TOKEN.lastIndex = 0; return }
    DECIMAL_TOKEN.lastIndex = 0

    const decimalMatches = Array.from(line.matchAll(DECIMAL_TOKEN))
    const labelsLatLon = /\b(?:ENLEM|LAT(?:ITUDE)?|BOYLAM|LON(?:GITUDE)?|LNG)\b/i.test(line)
    if ((tableMode === 'latlon' || labelsLatLon || decimalMatches.length >= 2) && !/[°'"]/.test(line)) {
      for (let index = 0; index < decimalMatches.length - 1; index += 1) {
        const first = parseDecimal(decimalMatches[index][0])
        const second = parseDecimal(decimalMatches[index + 1][0])
        if (Math.abs(first) > 180 || Math.abs(second) > 180) continue
        const lonFirst = /(?:BOYLAM|LON(?:GITUDE)?|LNG)\D{0,18}[-+]?\d/i.test(line)
        const lat = lonFirst || Math.abs(first) > 90 ? second : first
        const lng = lonFirst || Math.abs(first) > 90 ? first : second
        if (!isValidLatLng(lat, lng)) continue
        const name = inferPointName(line, decimalMatches[index].index ?? line.length)
        const confidence = labelsLatLon ? 91 : tableMode === 'latlon' ? 86 : 62
        const reasons = [labelsLatLon ? 'Enlem/boylam başlığı bulundu' : tableMode === 'latlon' ? 'Enlem/boylam tablosu' : 'Yan yana ondalık koordinat']
        if (!isTurkeyPoint(lat, lng) && isTurkeyPoint(lng, lat) && Math.abs(lng) <= 90) {
          addCandidate(target, { lat: lng, lng: lat, format: 'Lat/Lon', raw: line, source: sourceLabel(source, lineIndex + 1), sourceKind, name, group, confidence: confidence + 3, reasons: [...reasons, 'Enlem/boylam sırası otomatik düzeltildi'], correctedOrder: true })
        } else {
          addCandidate(target, { lat, lng, format: 'Lat/Lon', raw: line, source: sourceLabel(source, lineIndex + 1), sourceKind, name, group, confidence, reasons })
        }
        if (tableMode === 'latlon') tableRows += 1
        return
      }
    }

    const metricMatches = Array.from(line.matchAll(METRIC_TOKEN))
    if (metricMatches.length < 2) return
    const labeledUtm = /\b(?:EASTING|NORTHING|DO[ĞG]U|KUZEY|\bX\b|\bY\b)\b/i.test(line)
    for (let index = 0; index < metricMatches.length - 1; index += 1) {
      const a = parseMetric(metricMatches[index][0])
      const b = parseMetric(metricMatches[index + 1][0])
      const chosen = bestUtmOrder(a, b, zone, hemisphere, datum)
      if (!chosen) continue
      const name = inferPointName(line, metricMatches[index].index ?? line.length)
      let confidence = labeledUtm ? 92 : tableMode === 'utm' ? 86 : 58
      const reasons = [labeledUtm ? 'X/Y veya Easting/Northing etiketi bulundu' : tableMode === 'utm' ? 'UTM tablo satırı' : 'UTM aralığına uyan sayı çifti']
      if (detection.evidence.length) confidence += 3
      if (chosen.corrected) reasons.push('X/Y sırası otomatik düzeltildi')
      addCandidate(target, {
        lat: chosen.point.lat, lng: chosen.point.lng, format: 'UTM', raw: line,
        source: sourceLabel(source, lineIndex + 1), sourceKind, name, group,
        confidence, reasons, zone, hemisphere, datum, correctedOrder: chosen.corrected,
      })
      if (tableMode === 'utm') tableRows += 1
      return
    }
  })

  return tableRows
}

function deduplicateCandidates(candidates: CandidateInput[]) {
  const map = new Map<string, CandidateInput>()
  let duplicatesRemoved = 0
  for (const candidate of candidates) {
    const key = `${candidate.lat.toFixed(7)}:${candidate.lng.toFixed(7)}`
    const current = map.get(key)
    if (!current) {
      map.set(key, candidate)
      continue
    }
    duplicatesRemoved += 1
    if (candidate.confidence > current.confidence || (candidate.confidence === current.confidence && candidate.sourceKind === 'Metin')) {
      map.set(key, { ...candidate, reasons: Array.from(new Set([...current.reasons, ...candidate.reasons])) })
    } else {
      current.reasons = Array.from(new Set([...current.reasons, ...candidate.reasons]))
    }
  }
  const candidatesWithIds = Array.from(map.values()).map((candidate, index) => ({
    ...candidate,
    confidenceLevel: confidenceLevel(candidate.confidence),
    id: `doc-${index}-${candidate.lat.toFixed(6)}-${candidate.lng.toFixed(6)}`,
  }))
  return { candidates: candidatesWithIds, duplicatesRemoved }
}

function analyzeText(rawText: string, source: string, sourceKind: DocumentCoordinateSource, options: DocumentCoordinateOptions): TextAnalysis {
  const text = normalizeText(rawText)
  const detection = detectContext(text, options)
  const collected: CandidateInput[] = []
  extractDegreeCoordinates(text, source, sourceKind, collected)
  const tableRows = extractStructuredLines(text, source, sourceKind, options, detection, collected) ?? 0
  const deduped = deduplicateCandidates(collected)
  return { ...deduped, detection, tableRows }
}

export function extractCoordinatesFromText(rawText: string, source: string, sourceKind: DocumentCoordinateSource, options: DocumentCoordinateOptions) {
  return analyzeText(rawText, source, sourceKind, options).candidates
}

function mergeAnalyses(analyses: TextAnalysis[], fallback: DocumentCoordinateOptions) {
  const allCandidates = analyses.flatMap((analysis) => analysis.candidates.map(({ id, confidenceLevel, ...candidate }) => {
    void id
    void confidenceLevel
    return candidate
  }))
  const deduped = deduplicateCandidates(allCandidates)
  const evidence = Array.from(new Set(analyses.flatMap((analysis) => analysis.detection.evidence)))
  const detectedZone = analyses.find((analysis) => analysis.detection.evidence.some((item) => item.startsWith('Zone ')))?.detection.zone
  const detectedDatum = analyses.find((analysis) => analysis.detection.evidence.some((item) => /datum|WGS84/i.test(item)))?.detection.datum
  const detectedHemisphere = analyses.find((analysis) => analysis.detection.evidence.some((item) => item.startsWith('Zone ')))?.detection.hemisphere
  return {
    candidates: deduped.candidates,
    detection: {
      zone: detectedZone ?? fallback.zone,
      hemisphere: detectedHemisphere ?? fallback.hemisphere,
      datum: detectedDatum ?? fallback.datum,
      evidence,
    } satisfies DocumentDetectionSummary,
    duplicatesRemoved: deduped.duplicatesRemoved + analyses.reduce((sum, analysis) => sum + analysis.duplicatesRemoved, 0),
    tableRows: analyses.reduce((sum, analysis) => sum + analysis.tableRows, 0),
  }
}

function buildStats(candidates: DocumentCoordinateCandidate[], duplicatesRemoved: number, tableRows: number): DocumentScanStats {
  return {
    high: candidates.filter((candidate) => candidate.confidenceLevel === 'high').length,
    medium: candidates.filter((candidate) => candidate.confidenceLevel === 'medium').length,
    low: candidates.filter((candidate) => candidate.confidenceLevel === 'low').length,
    duplicatesRemoved,
    tableRows,
  }
}

async function createOcrWorker(onProgress: ProgressHandler, progressWindow: { offset: number; weight: number }) {
  const { createWorker, PSM } = await import('tesseract.js')
  const worker = await createWorker('eng', 1, {
    logger: (message) => {
      if (message.status !== 'recognizing text') return
      onProgress({ percent: Math.min(98, Math.round(progressWindow.offset + message.progress * progressWindow.weight)), label: `OCR ile tablo ve koordinatlar okunuyor · %${Math.round(message.progress * 100)}` })
    },
  })
  await worker.setParameters({ tessedit_pageseg_mode: PSM.SPARSE_TEXT, preserve_interword_spaces: '1' })
  return worker
}

function improveCanvasForOcr(canvas: HTMLCanvasElement) {
  const context = canvas.getContext('2d', { willReadFrequently: true })
  if (!context) return
  const image = context.getImageData(0, 0, canvas.width, canvas.height)
  for (let index = 0; index < image.data.length; index += 4) {
    const gray = image.data[index] * 0.299 + image.data[index + 1] * 0.587 + image.data[index + 2] * 0.114
    const contrasted = Math.max(0, Math.min(255, (gray - 128) * 1.55 + 128))
    image.data[index] = contrasted
    image.data[index + 1] = contrasted
    image.data[index + 2] = contrasted
  }
  context.putImageData(image, 0, 0)
}

async function renderPdfPage(page: PDFPageProxy) {
  const natural = page.getViewport({ scale: 1 })
  const scale = Math.min(2.4, Math.sqrt(MAX_OCR_PIXELS / Math.max(1, natural.width * natural.height)))
  const viewport = page.getViewport({ scale })
  const canvas = document.createElement('canvas')
  canvas.width = Math.ceil(viewport.width)
  canvas.height = Math.ceil(viewport.height)
  await page.render({ canvas, viewport, background: '#ffffff' }).promise
  improveCanvasForOcr(canvas)
  return canvas
}

async function textFromPdfPage(page: PDFPageProxy) {
  const content = await page.getTextContent()
  return content.items.map((item) => {
    if (!('str' in item)) return ''
    return `${item.str}${item.hasEOL ? '\n' : ' '}`
  }).join('')
}

function warningText(pageWarning: string | undefined, candidates: DocumentCoordinateCandidate[], detection: DocumentDetectionSummary) {
  const warnings: string[] = []
  if (pageWarning) warnings.push(pageWarning)
  const low = candidates.filter((candidate) => candidate.confidenceLevel === 'low').length
  if (low) warnings.push(`${low} düşük güvenli aday manuel kontrol edilmeli.`)
  if (candidates.some((candidate) => candidate.format === 'UTM') && !detection.evidence.some((item) => item.startsWith('Zone '))) warnings.push(`UTM Zone belgede bulunamadı; varsayılan Zone ${detection.zone} kullanıldı.`)
  return warnings.length ? warnings.join(' ') : undefined
}

async function scanPdf(file: File, options: DocumentCoordinateOptions, onProgress: ProgressHandler) {
  onProgress({ percent: 3, label: 'PDF açılıyor…' })
  const [{ getDocument, GlobalWorkerOptions }, workerModule] = await Promise.all([import('pdfjs-dist'), import('pdfjs-dist/build/pdf.worker.min.mjs?url')])
  GlobalWorkerOptions.workerSrc = workerModule.default
  const loadingTask = getDocument({ data: new Uint8Array(await file.arrayBuffer()) })
  const pdf = await loadingTask.promise
  const totalPages = pdf.numPages
  const pageCount = Math.min(totalPages, MAX_PDF_PAGES)
  const analyses: TextAnalysis[] = []
  const pagesForOcr: Array<{ pageNumber: number; page: PDFPageProxy }> = []

  for (let pageNumber = 1; pageNumber <= pageCount; pageNumber += 1) {
    onProgress({ percent: 5 + Math.round((pageNumber / pageCount) * 35), label: `PDF yapısı analiz ediliyor · sayfa ${pageNumber}/${pageCount}` })
    const page = await pdf.getPage(pageNumber)
    const text = await textFromPdfPage(page)
    const analysis = analyzeText(text, `PDF s. ${pageNumber}`, 'Metin', options)
    analyses.push(analysis)
    const reliable = analysis.candidates.filter((candidate) => candidate.confidence >= 65).length
    if (text.trim().length < 50 || reliable === 0) pagesForOcr.push({ pageNumber, page })
  }

  let usedOcr = false
  if (pagesForOcr.length) {
    usedOcr = true
    const pageWeight = 55 / pagesForOcr.length
    const progressWindow = { offset: 40, weight: pageWeight }
    const worker = await createOcrWorker(onProgress, progressWindow)
    try {
      for (let index = 0; index < pagesForOcr.length; index += 1) {
        const { pageNumber, page } = pagesForOcr[index]
        progressWindow.offset = 40 + index * pageWeight
        onProgress({ percent: Math.round(progressWindow.offset), label: `OCR ile sayfa okunuyor · ${pageNumber}/${pageCount}` })
        const canvas = await renderPdfPage(page)
        const result = await worker.recognize(canvas)
        analyses.push(analyzeText(result.data.text, `PDF s. ${pageNumber}`, 'OCR', options))
        canvas.width = 1; canvas.height = 1
      }
    } finally {
      await worker.terminate()
    }
  }

  await loadingTask.destroy()
  const merged = mergeAnalyses(analyses, options)
  const pageWarning = totalPages > MAX_PDF_PAGES ? `İlk ${MAX_PDF_PAGES} sayfa tarandı; belge toplam ${totalPages} sayfa.` : undefined
  return {
    pageCount: totalPages,
    usedOcr,
    candidates: merged.candidates,
    detection: merged.detection,
    stats: buildStats(merged.candidates, merged.duplicatesRemoved, merged.tableRows),
    warning: warningText(pageWarning, merged.candidates, merged.detection),
  }
}

async function scanImage(file: File, options: DocumentCoordinateOptions, onProgress: ProgressHandler) {
  const worker = await createOcrWorker(onProgress, { offset: 8, weight: 88 })
  try {
    const result = await worker.recognize(file)
    const analysis = analyzeText(result.data.text, 'Görsel', 'OCR', options)
    return {
      pageCount: 1,
      usedOcr: true,
      candidates: analysis.candidates,
      detection: analysis.detection,
      stats: buildStats(analysis.candidates, analysis.duplicatesRemoved, analysis.tableRows),
      warning: warningText(undefined, analysis.candidates, analysis.detection),
    }
  } finally {
    await worker.terminate()
  }
}

async function textFromDocx(file: File) {
  const { default: JSZip } = await import('jszip')
  const archive = await JSZip.loadAsync(file)
  const documentXml = await archive.file('word/document.xml')?.async('string')
  if (!documentXml) throw new Error('DOCX içeriği bulunamadı.')
  const xml = new DOMParser().parseFromString(documentXml, 'application/xml')
  return Array.from(xml.getElementsByTagName('w:p')).map((paragraph) => Array.from(paragraph.getElementsByTagName('w:t')).map((node) => node.textContent ?? '').join(' ')).join('\n')
}

export async function scanCoordinateDocument(file: File, options: DocumentCoordinateOptions, onProgress: ProgressHandler): Promise<DocumentScanResult> {
  if (file.size > MAX_FILE_BYTES) throw new Error('Belge en fazla 30 MB olabilir.')
  const lowerName = file.name.toLowerCase()
  let scan: Omit<DocumentScanResult, 'fileName'>

  if (file.type === 'application/pdf' || lowerName.endsWith('.pdf')) {
    scan = await scanPdf(file, options, onProgress)
  } else if (file.type.startsWith('image/')) {
    scan = await scanImage(file, options, onProgress)
  } else {
    onProgress({ percent: 18, label: 'Belge yapısı ve tablolar okunuyor…' })
    const text = lowerName.endsWith('.docx') ? await textFromDocx(file) : await file.text()
    const analysis = analyzeText(text, lowerName.endsWith('.docx') ? 'Word belgesi' : 'Belge', 'Metin', options)
    scan = {
      pageCount: 1,
      usedOcr: false,
      candidates: analysis.candidates,
      detection: analysis.detection,
      stats: buildStats(analysis.candidates, analysis.duplicatesRemoved, analysis.tableRows),
      warning: warningText(undefined, analysis.candidates, analysis.detection),
    }
  }

  onProgress({ percent: 100, label: `${scan.candidates.length} koordinat analiz edildi` })
  return { fileName: file.name, ...scan }
}
