import type { PDFPageProxy } from 'pdfjs-dist'
import { fromUtm } from './geo'

export type DocumentCoordinateFormat = 'Lat/Lon' | 'DMS' | 'DDM' | 'UTM'
export type DocumentCoordinateSource = 'Metin' | 'OCR'

export interface DocumentCoordinateCandidate {
  id: string
  lat: number
  lng: number
  format: DocumentCoordinateFormat
  raw: string
  source: string
  sourceKind: DocumentCoordinateSource
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

export interface DocumentScanResult {
  fileName: string
  pageCount: number
  usedOcr: boolean
  candidates: DocumentCoordinateCandidate[]
  warning?: string
}

type ProgressHandler = (progress: DocumentScanProgress) => void

type CandidateInput = Omit<DocumentCoordinateCandidate, 'id'>

interface HemisphereComponent {
  value: number
  axis: 'lat' | 'lng'
  format: 'DMS' | 'DDM'
  index: number
  raw: string
}

const MAX_FILE_BYTES = 30 * 1024 * 1024
const MAX_PDF_PAGES = 50
const MAX_OCR_PIXELS = 8_000_000
const DECIMAL_TOKEN = /[-+]?\d{1,3}(?:[.,]\d{3,})/g
const DMS_HEMISPHERE_COMPONENT = /(\d{1,3})\s*[°º˚]\s*(\d{1,2})\s*['′’]\s*(\d{1,2}(?:[.,]\d+)?)\s*(?:["″“”])?\s*([NSEW])/gi
const DDM_HEMISPHERE_COMPONENT = /(\d{1,3})\s*[°º˚]\s*(\d{1,2}(?:[.,]\d+)?)\s*['′’]?\s*([NSEW])/gi
const DECIMAL_HEMISPHERE = /([-+]?\d{1,3}(?:[.,]\d+)?)\s*[°º˚]?\s*([NSEW])/gi
const DECIMAL_HEMISPHERE_PREFIX = /([NSEW])\s*([-+]?\d{1,3}(?:[.,]\d+)?)/gi
const METRIC_TOKEN = /[-+]?(?:\d{1,3}(?:[.\s]\d{3})+|\d{5,8})(?:,\d+)?/g

function normalizeText(text: string) {
  return text
    .replace(/\u00a0/g, ' ')
    .replace(/[−–—]/g, '-')
    .replace(/[º˚]/g, '°')
    .replace(/[′’]/g, "'")
    .replace(/[″“”]/g, '"')
    .replace(/(\d)[Oo](?=\d)/g, '$10')
    .replace(/(\d)[Il](?=\d)/g, '$11')
    .replace(/[ \t]+/g, ' ')
}

function parseDecimal(value: string) {
  return Number(value.replace(',', '.'))
}

function parseMetric(value: string) {
  const compact = value.trim().replace(/\s+/g, '')
  const separatorIndexes = Array.from(compact.matchAll(/[.,]/g), (match) => match.index ?? -1)
  if (separatorIndexes.length > 1) {
    const lastSeparator = separatorIndexes.at(-1) ?? -1
    const fractionLength = compact.length - lastSeparator - 1
    if (fractionLength > 0 && fractionLength < 3) {
      const integer = compact.slice(0, lastSeparator).replace(/[.,]/g, '')
      return Number(`${integer}.${compact.slice(lastSeparator + 1)}`)
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

function isValidUtm(easting: number, northing: number, zone: number) {
  return Number.isFinite(easting)
    && Number.isFinite(northing)
    && zone >= 1
    && zone <= 60
    && easting >= 100_000
    && easting <= 900_000
    && northing >= 0
    && northing <= 10_000_000
}

function latitudeHemisphereFromBand(band?: string, fallback: 'N' | 'S' = 'N'): 'N' | 'S' {
  if (!band) return fallback
  const normalized = band.toUpperCase()
  return normalized >= 'N' ? 'N' : 'S'
}

function lineNumberAt(text: string, index: number) {
  return text.slice(0, index).split('\n').length
}

function sourceLabel(base: string, line?: number) {
  return line ? `${base} · satır ${line}` : base
}

function pushLatLng(
  target: CandidateInput[],
  lat: number,
  lng: number,
  format: DocumentCoordinateFormat,
  raw: string,
  source: string,
  sourceKind: DocumentCoordinateSource,
) {
  if (!isValidLatLng(lat, lng)) return
  target.push({ lat, lng, format, raw: raw.trim().slice(0, 180), source, sourceKind })
}

function decimalHemisphereComponents(text: string) {
  const components: Array<{ value: number; axis: 'lat' | 'lng'; index: number; raw: string }> = []
  for (const match of text.matchAll(DECIMAL_HEMISPHERE)) {
    const hemisphere = match[2].toUpperCase()
    const axis = /[NS]/.test(hemisphere) ? 'lat' : 'lng'
    const unsigned = Math.abs(parseDecimal(match[1]))
    components.push({
      value: /[SW]/.test(hemisphere) ? -unsigned : unsigned,
      axis,
      index: match.index ?? 0,
      raw: match[0],
    })
  }
  return components
}

function decimalHemispherePrefixComponents(text: string) {
  const components: Array<{ value: number; axis: 'lat' | 'lng'; index: number; raw: string }> = []
  for (const match of text.matchAll(DECIMAL_HEMISPHERE_PREFIX)) {
    const hemisphere = match[1].toUpperCase()
    const axis = /[NS]/.test(hemisphere) ? 'lat' : 'lng'
    const unsigned = Math.abs(parseDecimal(match[2]))
    components.push({
      value: /[SW]/.test(hemisphere) ? -unsigned : unsigned,
      axis,
      index: match.index ?? 0,
      raw: match[0],
    })
  }
  return components
}

function degreeHemisphereComponents(text: string) {
  const components: HemisphereComponent[] = []
  for (const match of text.matchAll(DMS_HEMISPHERE_COMPONENT)) {
    const degrees = Number(match[1])
    const minutes = parseDecimal(match[2])
    const seconds = parseDecimal(match[3])
    if (minutes >= 60 || seconds >= 60) continue
    const hemisphere = match[4].toUpperCase()
    const axis = /[NS]/.test(hemisphere) ? 'lat' : 'lng'
    const unsigned = degrees + minutes / 60 + seconds / 3600
    components.push({
      value: /[SW]/.test(hemisphere) ? -unsigned : unsigned,
      axis,
      format: 'DMS',
      index: match.index ?? 0,
      raw: match[0],
    })
  }
  for (const match of text.matchAll(DDM_HEMISPHERE_COMPONENT)) {
    const degrees = Number(match[1])
    const minutes = parseDecimal(match[2])
    if (minutes >= 60) continue
    const hemisphere = match[3].toUpperCase()
    const axis = /[NS]/.test(hemisphere) ? 'lat' : 'lng'
    const unsigned = degrees + minutes / 60
    components.push({
      value: /[SW]/.test(hemisphere) ? -unsigned : unsigned,
      axis,
      format: 'DDM',
      index: match.index ?? 0,
      raw: match[0],
    })
  }
  components.sort((a, b) => a.index - b.index)
  return components
}

function pairHemisphereComponents(
  components: Array<{ value: number; axis: 'lat' | 'lng'; index: number; raw: string; format?: 'DMS' | 'DDM' }>,
  text: string,
  source: string,
  sourceKind: DocumentCoordinateSource,
  target: CandidateInput[],
) {
  for (let index = 0; index < components.length - 1; index += 1) {
    const first = components[index]
    const second = components[index + 1]
    if (first.axis === second.axis || second.index - first.index > 100) continue
    const lat = first.axis === 'lat' ? first.value : second.value
    const lng = first.axis === 'lng' ? first.value : second.value
    const format = first.format || second.format || 'Lat/Lon'
    const raw = text.slice(first.index, second.index + second.raw.length)
    pushLatLng(target, lat, lng, format, raw, sourceLabel(source, lineNumberAt(text, first.index)), sourceKind)
    index += 1
  }
}

function extractDecimalLines(text: string, source: string, sourceKind: DocumentCoordinateSource, target: CandidateInput[]) {
  text.split('\n').forEach((rawLine, index) => {
    const line = rawLine.trim()
    if (!line || /[°'"]/.test(line)) return
    const values = Array.from(line.matchAll(DECIMAL_TOKEN)).map((match) => ({ value: parseDecimal(match[0]), index: match.index ?? 0 }))
    if (values.length < 2) return
    for (let pairIndex = 0; pairIndex < values.length - 1; pairIndex += 1) {
      const first = values[pairIndex].value
      const second = values[pairIndex + 1].value
      if (Math.abs(first) > 180 || Math.abs(second) > 180) continue
      const hasLonFirstLabel = /(?:lon|lng|boylam)\D{0,12}[-+]?\d/i.test(line)
      const lat = hasLonFirstLabel || Math.abs(first) > 90 ? second : first
      const lng = hasLonFirstLabel || Math.abs(first) > 90 ? first : second
      if (!isValidLatLng(lat, lng)) continue
      pushLatLng(target, lat, lng, 'Lat/Lon', line, sourceLabel(source, index + 1), sourceKind)
      break
    }
  })
}

function extractUnmarkedDegrees(text: string, source: string, sourceKind: DocumentCoordinateSource, target: CandidateInput[]) {
  const pattern = /([-+]?\d{1,2})\s*°\s*(\d{1,2})\s*'\s*(\d{1,2}(?:[.,]\d+)?)\s*"?\s*[,;/\s]+([-+]?\d{1,3})\s*°\s*(\d{1,2})\s*'\s*(\d{1,2}(?:[.,]\d+)?)\s*"?/g
  for (const match of text.matchAll(pattern)) {
    const lat = Math.sign(Number(match[1]) || 1) * (Math.abs(Number(match[1])) + Number(match[2]) / 60 + parseDecimal(match[3]) / 3600)
    const lng = Math.sign(Number(match[4]) || 1) * (Math.abs(Number(match[4])) + Number(match[5]) / 60 + parseDecimal(match[6]) / 3600)
    pushLatLng(target, lat, lng, 'DMS', match[0], sourceLabel(source, lineNumberAt(text, match.index ?? 0)), sourceKind)
  }
}

function extractUtm(text: string, source: string, sourceKind: DocumentCoordinateSource, options: DocumentCoordinateOptions, target: CandidateInput[]) {
  const metric = '((?:\\d{1,3}(?:[.\\s]\\d{3})+|\\d{5,8})(?:,\\d+)?)'
  const labeledPairs = [
    new RegExp(`(?:EASTING|X|DO[ĞG]U|SA[ĞG]A)\\s*[:=]?\\s*${metric}[\\s\\S]{0,80}?(?:NORTHING|Y|KUZEY|YUKARI)\\s*[:=]?\\s*${metric}`, 'gi'),
    new RegExp(`(?:NORTHING|Y|KUZEY|YUKARI)\\s*[:=]?\\s*${metric}[\\s\\S]{0,80}?(?:EASTING|X|DO[ĞG]U|SA[ĞG]A)\\s*[:=]?\\s*${metric}`, 'gi'),
  ]
  labeledPairs.forEach((pattern, patternIndex) => {
    for (const match of text.matchAll(pattern)) {
      const first = parseMetric(match[1])
      const second = parseMetric(match[2])
      const easting = patternIndex === 0 ? first : second
      const northing = patternIndex === 0 ? second : first
      if (!isValidUtm(easting, northing, options.zone)) continue
      const point = fromUtm(easting, northing, options.zone, options.hemisphere, options.datum)
      pushLatLng(target, point.lat, point.lng, 'UTM', match[0], sourceLabel(source, lineNumberAt(text, match.index ?? 0)), sourceKind)
    }
  })

  const explicitZone = /\b(?:(ZONE|Z|D[İI]L[İI]M)\s*[:=]?\s*)?([1-5]?\d|60)\s*([C-HJ-NP-X]|[NS])?\s+(?:E(?:ASTING)?|X|DO[ĞG]U)?\s*[:=]?\s*((?:\d{1,3}(?:[.\s]\d{3})+|\d{5,8})(?:,\d+)?)\s*[,;:/|\s-]+(?:N(?:ORTHING)?|Y|KUZEY)?\s*[:=]?\s*((?:\d{1,3}(?:[.\s]\d{3})+|\d{5,8})(?:,\d+)?)/gi
  const claimedRanges: Array<[number, number]> = []
  for (const match of text.matchAll(explicitZone)) {
    if (!match[1] && !match[3]) continue
    const zone = Number(match[2])
    const easting = parseMetric(match[4])
    const northing = parseMetric(match[5])
    if (!isValidUtm(easting, northing, zone)) continue
    const hemisphere = latitudeHemisphereFromBand(match[3], options.hemisphere)
    const point = fromUtm(easting, northing, zone, hemisphere, options.datum)
    pushLatLng(target, point.lat, point.lng, 'UTM', match[0], sourceLabel(source, lineNumberAt(text, match.index ?? 0)), sourceKind)
    claimedRanges.push([match.index ?? 0, (match.index ?? 0) + match[0].length])
  }

  const lines = text.split('\n')
  let lineStart = 0
  for (let lineIndex = 0; lineIndex < lines.length; lineIndex += 1) {
    const rawLine = lines[lineIndex]
    const nextLineStart = lineStart + rawLine.length + 1
    if (claimedRanges.some(([start, end]) => lineStart <= end && nextLineStart >= start)) {
      lineStart = nextLineStart
      continue
    }
    const decimalValues = Array.from(rawLine.matchAll(DECIMAL_TOKEN), (match) => parseDecimal(match[0]))
    if (decimalValues.length >= 2 && isValidLatLng(decimalValues[0], decimalValues[1])) {
      lineStart = nextLineStart
      continue
    }
    const tokenGroups = [
      Array.from(rawLine.matchAll(METRIC_TOKEN), (match) => parseMetric(match[0])),
      Array.from(rawLine.matchAll(/\d{5,8}/g), (match) => Number(match[0])),
    ]
    let found = false
    for (const tokens of tokenGroups) {
      if (tokens.length < 2) continue
      for (let index = 0; index < tokens.length - 1; index += 1) {
        const a = tokens[index]
        const b = tokens[index + 1]
        const normalOrder = isValidUtm(a, b, options.zone)
        const reverseOrder = isValidUtm(b, a, options.zone)
        if (!normalOrder && !reverseOrder) continue
        const easting = normalOrder ? a : b
        const northing = normalOrder ? b : a
        const point = fromUtm(easting, northing, options.zone, options.hemisphere, options.datum)
        pushLatLng(target, point.lat, point.lng, 'UTM', rawLine, sourceLabel(source, lineIndex + 1), sourceKind)
        found = true
        break
      }
      if (found) break
    }
    lineStart = nextLineStart
  }
}

function deduplicateCandidates(candidates: CandidateInput[]) {
  const seen = new Set<string>()
  return candidates.flatMap((candidate, index) => {
    const key = `${candidate.lat.toFixed(7)}:${candidate.lng.toFixed(7)}`
    if (seen.has(key)) return []
    seen.add(key)
    return [{ ...candidate, id: `doc-${index}-${key}` }]
  })
}

export function extractCoordinatesFromText(
  rawText: string,
  source: string,
  sourceKind: DocumentCoordinateSource,
  options: DocumentCoordinateOptions,
) {
  const text = normalizeText(rawText)
  const candidates: CandidateInput[] = []
  pairHemisphereComponents(degreeHemisphereComponents(text), text, source, sourceKind, candidates)
  pairHemisphereComponents(decimalHemisphereComponents(text), text, source, sourceKind, candidates)
  pairHemisphereComponents(decimalHemispherePrefixComponents(text), text, source, sourceKind, candidates)
  extractUnmarkedDegrees(text, source, sourceKind, candidates)
  extractDecimalLines(text, source, sourceKind, candidates)
  extractUtm(text, source, sourceKind, options, candidates)
  return deduplicateCandidates(candidates)
}

function mergeCandidates(...groups: DocumentCoordinateCandidate[][]) {
  return deduplicateCandidates(groups.flat())
}

async function createOcrWorker(onProgress: ProgressHandler, progressWindow: { offset: number; weight: number }) {
  const { createWorker, PSM } = await import('tesseract.js')
  const worker = await createWorker('eng', 1, {
    logger: (message) => {
      if (message.status !== 'recognizing text') return
      onProgress({
        percent: Math.min(98, Math.round(progressWindow.offset + message.progress * progressWindow.weight)),
        label: `OCR ile koordinatlar aranıyor · %${Math.round(message.progress * 100)}`,
      })
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
    const contrasted = Math.max(0, Math.min(255, (gray - 128) * 1.35 + 128))
    image.data[index] = contrasted
    image.data[index + 1] = contrasted
    image.data[index + 2] = contrasted
  }
  context.putImageData(image, 0, 0)
}

async function renderPdfPage(page: PDFPageProxy) {
  const natural = page.getViewport({ scale: 1 })
  const scale = Math.min(2.2, Math.sqrt(MAX_OCR_PIXELS / Math.max(1, natural.width * natural.height)))
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

async function scanPdf(file: File, options: DocumentCoordinateOptions, onProgress: ProgressHandler) {
  onProgress({ percent: 4, label: 'PDF açılıyor…' })
  const [{ getDocument, GlobalWorkerOptions }, workerModule] = await Promise.all([
    import('pdfjs-dist'),
    import('pdfjs-dist/build/pdf.worker.min.mjs?url'),
  ])
  GlobalWorkerOptions.workerSrc = workerModule.default
  const loadingTask = getDocument({ data: new Uint8Array(await file.arrayBuffer()) })
  const pdf = await loadingTask.promise
  const totalPages = pdf.numPages
  const pageCount = Math.min(totalPages, MAX_PDF_PAGES)
  const extracted: DocumentCoordinateCandidate[][] = []
  const pagesForOcr: Array<{ pageNumber: number; page: PDFPageProxy }> = []

  for (let pageNumber = 1; pageNumber <= pageCount; pageNumber += 1) {
    onProgress({ percent: 5 + Math.round((pageNumber / pageCount) * 35), label: `PDF metni taranıyor · sayfa ${pageNumber}/${pageCount}` })
    const page = await pdf.getPage(pageNumber)
    const text = await textFromPdfPage(page)
    const candidates = extractCoordinatesFromText(text, `PDF s. ${pageNumber}`, 'Metin', options)
    extracted.push(candidates)
    if (!candidates.length) pagesForOcr.push({ pageNumber, page })
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
        const offset = 40 + index * pageWeight
        progressWindow.offset = offset
        onProgress({ percent: Math.round(offset), label: `Taranmış sayfa okunuyor · ${pageNumber}/${pageCount}` })
        const canvas = await renderPdfPage(page)
        const result = await worker.recognize(canvas)
        extracted.push(extractCoordinatesFromText(result.data.text, `PDF s. ${pageNumber}`, 'OCR', options))
        canvas.width = 1
        canvas.height = 1
      }
    } finally {
      await worker.terminate()
    }
  }

  await loadingTask.destroy()
  return {
    pageCount: totalPages,
    usedOcr,
    candidates: mergeCandidates(...extracted),
    warning: totalPages > MAX_PDF_PAGES ? `İlk ${MAX_PDF_PAGES} sayfa tarandı; belge toplam ${totalPages} sayfa.` : undefined,
  }
}

async function scanImage(file: File, options: DocumentCoordinateOptions, onProgress: ProgressHandler) {
  const worker = await createOcrWorker(onProgress, { offset: 10, weight: 85 })
  try {
    const result = await worker.recognize(file)
    return {
      pageCount: 1,
      usedOcr: true,
      candidates: extractCoordinatesFromText(result.data.text, 'Görsel', 'OCR', options),
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
  return Array.from(xml.getElementsByTagName('w:p')).map((paragraph) => (
    Array.from(paragraph.getElementsByTagName('w:t')).map((node) => node.textContent ?? '').join(' ')
  )).join('\n')
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
    onProgress({ percent: 20, label: 'Belge metni okunuyor…' })
    const text = lowerName.endsWith('.docx') ? await textFromDocx(file) : await file.text()
    scan = {
      pageCount: 1,
      usedOcr: false,
      candidates: extractCoordinatesFromText(text, lowerName.endsWith('.docx') ? 'Word belgesi' : 'Belge', 'Metin', options),
    }
  }

  onProgress({ percent: 100, label: `${scan.candidates.length} koordinat bulundu` })
  return { fileName: file.name, ...scan }
}
