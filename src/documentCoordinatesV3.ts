import type { PDFPageProxy } from 'pdfjs-dist'
import { fromUtm } from './geo'
import {
  extractCoordinatesFromText,
  scanCoordinateDocument as scanCoordinateDocumentV2,
  type DocumentCoordinateCandidate,
  type DocumentCoordinateConfidence,
  type DocumentCoordinateOptions,
  type DocumentDetectionSummary,
  type DocumentScanProgress,
  type DocumentScanResult,
} from './documentCoordinates'

type ProgressHandler = (progress: DocumentScanProgress) => void

type TableCandidate = DocumentCoordinateCandidate & { tableOrder: number }

type TableAnalysis = {
  candidates: TableCandidate[]
  detection: DocumentDetectionSummary
  evidence: string[]
  tableRows: number
}

const MAX_FILE_BYTES = 30 * 1024 * 1024
const MAX_PDF_PAGES = 50
const MAX_OCR_PIXELS = 9_000_000
const METRIC_TOKEN = /\b0?\d{6,7}\b/g

const PROVINCE_ZONE: Record<string, number> = {
  ADANA: 36, ADIYAMAN: 37, AFYONKARAHISAR: 36, AGRI: 38, AKSARAY: 36, AMASYA: 36,
  ANKARA: 36, ANTALYA: 36, ARDAHAN: 38, ARTVIN: 37, AYDIN: 35, BALIKESIR: 35,
  BARTIN: 36, BATMAN: 37, BAYBURT: 37, BILECIK: 35, BINGOL: 37, BITLIS: 38,
  BOLU: 36, BURDUR: 36, BURSA: 35, CANAKKALE: 35, CANKIRI: 36, CORUM: 36,
  DENIZLI: 35, DIYARBAKIR: 37, DUZCE: 36, EDIRNE: 35, ELAZIG: 37, ERZINCAN: 37,
  ERZURUM: 37, ESKISEHIR: 36, GAZIANTEP: 37, GIRESUN: 37, GUMUSHANE: 37, HAKKARI: 38,
  HATAY: 37, IGDIR: 38, ISPARTA: 36, ISTANBUL: 35, IZMIR: 35, KAHRAMANMARAS: 37,
  KARABUK: 36, KARAMAN: 36, KARS: 38, KASTAMONU: 36, KAYSERI: 36, KILIS: 37,
  KIRIKKALE: 36, KIRKLARELI: 35, KIRSEHIR: 36, KOCAELI: 36, KONYA: 36, KUTAHYA: 35,
  MALATYA: 37, MANISA: 35, MARDIN: 37, MERSIN: 36, MUGLA: 35, MUS: 37,
  NEVSEHIR: 36, NIGDE: 36, ORDU: 37, OSMANIYE: 37, RIZE: 37, SAKARYA: 36,
  SAMSUN: 37, SANLIURFA: 37, SIIRT: 37, SINOP: 36, SIRNAK: 38, SIVAS: 37,
  TEKIRDAG: 35, TOKAT: 37, TRABZON: 37, TUNCELI: 37, USAK: 35, VAN: 38,
  YALOVA: 35, YOZGAT: 36, ZONGULDAK: 36,
}

function fold(value: string) {
  return value
    .toLocaleUpperCase('tr-TR')
    .replace(/İ/g, 'I')
    .replace(/Ş/g, 'S')
    .replace(/Ğ/g, 'G')
    .replace(/Ü/g, 'U')
    .replace(/Ö/g, 'O')
    .replace(/Ç/g, 'C')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
}

function normalizeOcrText(text: string) {
  return text
    .replace(/\u00a0/g, ' ')
    .replace(/[−–—]/g, '-')
    .replace(/(?<=\d)[OoQ](?=\d)/g, '0')
    .replace(/(?<=\d)[Il|](?=\d)/g, '1')
    .replace(/(?<=\d)S(?=\d)/g, '5')
    .replace(/[ \t]+/g, ' ')
    .replace(/\r/g, '')
}

function confidenceLevel(value: number): DocumentCoordinateConfidence {
  if (value >= 85) return 'high'
  if (value >= 65) return 'medium'
  return 'low'
}

function isTurkeyPoint(lat: number, lng: number) {
  return lat >= 34.5 && lat <= 43.2 && lng >= 24.5 && lng <= 46.5
}

function parseMetricTokens(line: string) {
  return Array.from(line.matchAll(METRIC_TOKEN), (match) => Number(match[0]))
    .filter((value) => value >= 100_000 && value <= 9_999_999)
}

function explicitZone(text: string) {
  const match = text.match(/\b(?:UTM\s*)?(?:ZONE|ZON|D[İI]L[İI]M)\s*[:=\-]?\s*([1-5]?\d|60)\s*([NS])?\b/i)
  if (!match) return null
  const zone = Number(match[1])
  if (zone < 1 || zone > 60) return null
  return { zone, hemisphere: match[2]?.toUpperCase() === 'S' ? 'S' as const : 'N' as const }
}

function explicitDatum(text: string) {
  if (/\b(?:ED\s*[- ]?50|EUROPEAN\s+DATUM\s+1950)\b/i.test(text)) return 'ED50'
  if (/\b(?:WGS\s*[- ]?84|ITRF\d*|TUREF|ETRS\d*)\b/i.test(text)) return 'WGS84'
  return undefined
}

function provinceFromDocument(text: string) {
  const normalized = fold(text)
  const fieldMatch = normalized.match(/(?:^|\n)\s*(?:ILI|IL)\s*[:.\-]?\s*([A-Z]{3,20})/m)
  if (fieldMatch && PROVINCE_ZONE[fieldMatch[1]]) return fieldMatch[1]

  const licensePart = normalized.split(/RUHSAT\s+SAHIBININ\s+ADRESI|RUHSAT\s+SAHIBI\s+ADRESI/)[0]
  for (const province of Object.keys(PROVINCE_ZONE)) {
    if (new RegExp(`\\b${province}\\b`).test(licensePart)) return province
  }
  return undefined
}

function detectTableContext(text: string, options: DocumentCoordinateOptions) {
  const evidence: string[] = []
  const zoneInfo = explicitZone(text)
  const province = provinceFromDocument(text)
  let zone = zoneInfo?.zone
  let hemisphere: 'N' | 'S' = zoneInfo?.hemisphere ?? options.hemisphere

  if (zoneInfo) evidence.push(`Zone ${zoneInfo.zone}${zoneInfo.hemisphere} belgeden algılandı`)
  if (!zone && province) {
    zone = PROVINCE_ZONE[province]
    hemisphere = 'N'
    evidence.push(`İl ${province} → UTM Zone ${zone}N tahmini`)
  }
  if (!zone) zone = options.zone

  const detectedDatum = explicitDatum(text)
  const datum = detectedDatum ?? options.datum
  if (detectedDatum) evidence.push(`${detectedDatum} datum belgeden algılandı`)
  else evidence.push(`Datum belgede bulunamadı; seçili ${options.datum} kullanıldı`)

  return { zone, hemisphere, datum, province, evidence, zoneWasInferred: !zoneInfo && Boolean(province), zoneWasExplicit: Boolean(zoneInfo), datumWasExplicit: Boolean(detectedDatum) }
}

function isRightAxisLine(line: string) {
  const value = fold(line)
  return /\bSAGA\b/.test(value) || /\bEASTING\b/.test(value) || /\bDOGU\b/.test(value)
}

function isUpAxisLine(line: string) {
  const value = fold(line)
  return /\bYUKARI\b/.test(value) || /\bNORTHING\b/.test(value) || /\bKUZEY\b/.test(value)
}

function pointNamesFromHeader(lines: string[], axisIndex: number, count: number, fallbackStart: number) {
  for (let offset = 1; offset <= 4; offset += 1) {
    const line = lines[axisIndex - offset]
    if (!line) continue
    const names = Array.from(line.matchAll(/\b(\d{1,3})\s*[.]?\s*(?:NOKTA|POINT)\b/gi), (match) => `${Number(match[1])}.Nokta`)
    if (names.length >= Math.min(2, count)) return names.slice(0, count)
  }
  return Array.from({ length: count }, (_, index) => `${fallbackStart + index}.Nokta`)
}

function safeFromUtm(easting: number, northing: number, zone: number, hemisphere: 'N' | 'S', datum: string) {
  if (easting < 100_000 || easting > 900_000 || northing < 1_000_000 || northing > 10_000_000) return null
  try {
    const point = fromUtm(easting, northing, zone, hemisphere, datum)
    if (!Number.isFinite(point.lat) || !Number.isFinite(point.lng)) return null
    return point
  } catch {
    return null
  }
}

function findAxisRow(lines: string[], start: number, predicate: (line: string) => boolean) {
  for (let index = start; index < Math.min(lines.length, start + 5); index += 1) {
    if (!predicate(lines[index])) continue
    let values = parseMetricTokens(lines[index])
    let endIndex = index
    // OCR bazen uzun tablo satırını iki satıra böler; eksikse bir sonraki satırdaki yalnız sayıları da ekle.
    while (values.length < 2 && endIndex + 1 < lines.length && endIndex - index < 2) {
      const next = lines[endIndex + 1]
      if (isRightAxisLine(next) || isUpAxisLine(next)) break
      const extra = parseMetricTokens(next)
      if (!extra.length) break
      values = [...values, ...extra]
      endIndex += 1
    }
    return { index, endIndex, values }
  }
  return null
}

function extractHorizontalLicenseTables(rawText: string, source: string, sourceKind: 'Metin' | 'OCR', options: DocumentCoordinateOptions): TableAnalysis {
  const text = normalizeOcrText(rawText)
  const lines = text.split('\n').map((line) => line.trim()).filter(Boolean)
  const context = detectTableContext(text, options)
  const candidates: TableCandidate[] = []
  let nextPoint = 1

  for (let index = 0; index < lines.length; index += 1) {
    if (!isRightAxisLine(lines[index])) continue
    const right = findAxisRow(lines, index, isRightAxisLine)
    if (!right || right.values.length < 2) continue
    const up = findAxisRow(lines, right.endIndex + 1, isUpAxisLine)
    if (!up || up.values.length < 2) continue

    const count = Math.min(right.values.length, up.values.length)
    if (count < 2) continue
    const names = pointNamesFromHeader(lines, right.index, count, nextPoint)

    for (let column = 0; column < count; column += 1) {
      // Türkiye ruhsat/kadastro gösterimi: Sağa(Y) doğu/easting, Yukarı(X) kuzey/northing değeridir.
      const easting = right.values[column]
      const northing = up.values[column]
      const point = safeFromUtm(easting, northing, context.zone, context.hemisphere, context.datum)
      if (!point) continue

      let confidence = 94
      const reasons = [
        'Ruhsat tablo sütunu eşleştirildi',
        'Sağa (Y) = Easting',
        'Yukarı (X) = Northing',
      ]
      if (context.zoneWasExplicit) {
        confidence += 3
        reasons.push(`Zone ${context.zone} belge üzerinde bulundu`)
      } else if (context.zoneWasInferred) {
        confidence += 1
        reasons.push(`${context.province} ilinden Zone ${context.zone}N tahmin edildi`)
      } else {
        confidence -= 13
        reasons.push(`Zone belgede bulunamadı; varsayılan ${context.zone} kullanıldı`)
      }
      if (!context.datumWasExplicit) confidence -= 3
      if (sourceKind === 'OCR') confidence -= 3
      if (isTurkeyPoint(point.lat, point.lng)) confidence += 3
      else confidence -= 12
      confidence = Math.max(10, Math.min(99, Math.round(confidence)))

      candidates.push({
        id: `table-${source}-${right.index}-${column}-${easting}-${northing}`,
        lat: point.lat,
        lng: point.lng,
        format: 'UTM',
        raw: `${names[column] ?? `${nextPoint + column}.Nokta`} · Sağa(Y) ${String(easting).padStart(7, '0')} · Yukarı(X) ${northing}`,
        source: `${source} · ruhsat tablosu`,
        sourceKind,
        name: names[column] ?? `${nextPoint + column}.Nokta`,
        group: 'Ruhsat Koordinatları',
        confidence,
        confidenceLevel: confidenceLevel(confidence),
        reasons,
        zone: context.zone,
        hemisphere: context.hemisphere,
        datum: context.datum,
        correctedOrder: false,
        tableOrder: nextPoint + column,
      })
    }

    nextPoint += count
    index = up.endIndex
  }

  return {
    candidates,
    detection: {
      zone: context.zone,
      hemisphere: context.hemisphere,
      datum: context.datum,
      evidence: context.evidence,
    },
    evidence: context.evidence,
    tableRows: candidates.length,
  }
}

function mergeCandidates(generic: DocumentCoordinateCandidate[], table: TableCandidate[]) {
  // Paralel Sağa/Yukarı satırlarından yanlışlıkla aynı satır içi iki sayı eşleştiren eski düşük güvenli UTM adaylarını at.
  const filteredGeneric = table.length >= 3
    ? generic.filter((candidate) => {
      if (candidate.format !== 'UTM') return true
      if (candidate.confidence >= 85) return true
      const raw = fold(candidate.raw)
      return !(/\bSAGA\b|\bYUKARI\b|\bEASTING\b|\bNORTHING\b/.test(raw))
    })
    : generic

  const map = new Map<string, DocumentCoordinateCandidate & { order?: number }>()
  for (const candidate of filteredGeneric) {
    const key = `${candidate.lat.toFixed(7)}:${candidate.lng.toFixed(7)}`
    map.set(key, candidate)
  }
  for (const candidate of table) {
    const key = `${candidate.lat.toFixed(7)}:${candidate.lng.toFixed(7)}`
    const { tableOrder, ...clean } = candidate
    map.set(key, { ...clean, order: tableOrder })
  }
  return Array.from(map.values())
    .sort((a, b) => (a.order ?? 99999) - (b.order ?? 99999))
    .map(({ order: _order, ...candidate }, index) => ({ ...candidate, id: `doc-v3-${index}-${candidate.lat.toFixed(6)}-${candidate.lng.toFixed(6)}` }))
}

function buildResult(fileName: string, pageCount: number, usedOcr: boolean, generic: DocumentCoordinateCandidate[], table: TableAnalysis, fallbackDetection?: DocumentDetectionSummary, fallbackWarning?: string): DocumentScanResult {
  const candidates = mergeCandidates(generic, table.candidates)
  const high = candidates.filter((candidate) => candidate.confidenceLevel === 'high').length
  const medium = candidates.filter((candidate) => candidate.confidenceLevel === 'medium').length
  const low = candidates.filter((candidate) => candidate.confidenceLevel === 'low').length
  const warningParts: string[] = []
  if (fallbackWarning) warningParts.push(fallbackWarning)
  if (table.tableRows >= 3) warningParts.push(`${table.tableRows} koordinat Sağa(Y)/Yukarı(X) ruhsat tablosundan sütun bazında eşleştirildi.`)
  if (table.candidates.some((candidate) => !candidate.reasons.some((reason) => reason.includes('Zone') && !reason.includes('varsayılan')))) {
    // Bilgilendirme evidence içinde zaten gösterilir; burada gereksiz alarm üretme.
  }

  return {
    fileName,
    pageCount,
    usedOcr,
    candidates,
    detection: table.tableRows ? table.detection : (fallbackDetection ?? table.detection),
    stats: {
      high,
      medium,
      low,
      duplicatesRemoved: Math.max(0, generic.length + table.candidates.length - candidates.length),
      tableRows: table.tableRows,
    },
    warning: warningParts.length ? warningParts.join(' ') : undefined,
  }
}

async function createOcrWorker(onProgress: ProgressHandler, offset = 8, weight = 86) {
  const { createWorker, PSM } = await import('tesseract.js')
  const worker = await createWorker('eng', 1, {
    logger: (message) => {
      if (message.status !== 'recognizing text') return
      onProgress({
        percent: Math.min(97, Math.round(offset + message.progress * weight)),
        label: `Ruhsat tablosu OCR ile okunuyor · %${Math.round(message.progress * 100)}`,
      })
    },
  })
  await worker.setParameters({ tessedit_pageseg_mode: PSM.AUTO, preserve_interword_spaces: '1' })
  return worker
}

async function preprocessImage(file: File) {
  const bitmap = await createImageBitmap(file)
  const scale = Math.min(1.8, Math.sqrt(MAX_OCR_PIXELS / Math.max(1, bitmap.width * bitmap.height)))
  const canvas = document.createElement('canvas')
  canvas.width = Math.max(1, Math.round(bitmap.width * scale))
  canvas.height = Math.max(1, Math.round(bitmap.height * scale))
  const context = canvas.getContext('2d', { willReadFrequently: true })
  if (!context) return file
  context.drawImage(bitmap, 0, 0, canvas.width, canvas.height)
  bitmap.close()
  const image = context.getImageData(0, 0, canvas.width, canvas.height)
  for (let index = 0; index < image.data.length; index += 4) {
    const gray = image.data[index] * 0.299 + image.data[index + 1] * 0.587 + image.data[index + 2] * 0.114
    const contrasted = Math.max(0, Math.min(255, (gray - 126) * 1.65 + 126))
    image.data[index] = contrasted
    image.data[index + 1] = contrasted
    image.data[index + 2] = contrasted
  }
  context.putImageData(image, 0, 0)
  return canvas
}

async function scanImageV3(file: File, options: DocumentCoordinateOptions, onProgress: ProgressHandler) {
  onProgress({ percent: 4, label: 'Görsel ruhsat için hazırlanıyor…' })
  const image = await preprocessImage(file)
  const worker = await createOcrWorker(onProgress)
  try {
    const result = await worker.recognize(image)
    const text = result.data.text
    const generic = extractCoordinatesFromText(text, 'Görsel', 'OCR', options)
    const table = extractHorizontalLicenseTables(text, 'Görsel', 'OCR', options)
    return buildResult(file.name, 1, true, generic, table)
  } finally {
    await worker.terminate()
    if (image instanceof HTMLCanvasElement) {
      image.width = 1
      image.height = 1
    }
  }
}

async function textFromDocx(file: File) {
  const { default: JSZip } = await import('jszip')
  const archive = await JSZip.loadAsync(file)
  const xmlText = await archive.file('word/document.xml')?.async('string')
  if (!xmlText) throw new Error('DOCX içeriği bulunamadı.')
  const xml = new DOMParser().parseFromString(xmlText, 'application/xml')
  return Array.from(xml.getElementsByTagName('w:p')).map((paragraph) => (
    Array.from(paragraph.getElementsByTagName('w:t')).map((node) => node.textContent ?? '').join(' ')
  )).join('\n')
}

async function renderPdfPage(page: PDFPageProxy) {
  const natural = page.getViewport({ scale: 1 })
  const scale = Math.min(2.5, Math.sqrt(MAX_OCR_PIXELS / Math.max(1, natural.width * natural.height)))
  const viewport = page.getViewport({ scale })
  const canvas = document.createElement('canvas')
  canvas.width = Math.ceil(viewport.width)
  canvas.height = Math.ceil(viewport.height)
  await page.render({ canvas, viewport, background: '#ffffff' }).promise
  return canvas
}

async function scanPdfTableSupplement(file: File, options: DocumentCoordinateOptions, onProgress: ProgressHandler) {
  const [{ getDocument, GlobalWorkerOptions }, workerModule] = await Promise.all([
    import('pdfjs-dist'),
    import('pdfjs-dist/build/pdf.worker.min.mjs?url'),
  ])
  GlobalWorkerOptions.workerSrc = workerModule.default
  const loadingTask = getDocument({ data: new Uint8Array(await file.arrayBuffer()) })
  const pdf = await loadingTask.promise
  const pageCount = Math.min(pdf.numPages, MAX_PDF_PAGES)
  const generic: DocumentCoordinateCandidate[] = []
  const tableCandidates: TableCandidate[] = []
  let bestDetection: DocumentDetectionSummary = { zone: options.zone, hemisphere: options.hemisphere, datum: options.datum, evidence: [] }
  let usedOcr = false

  try {
    for (let pageNumber = 1; pageNumber <= pageCount; pageNumber += 1) {
      onProgress({ percent: 12 + Math.round((pageNumber / pageCount) * 32), label: `PDF tablo yapısı okunuyor · ${pageNumber}/${pageCount}` })
      const page = await pdf.getPage(pageNumber)
      const content = await page.getTextContent()
      const text = content.items.map((item) => ('str' in item ? `${item.str}${item.hasEOL ? '\n' : ' '}` : '')).join('')
      const pageGeneric = extractCoordinatesFromText(text, `PDF s. ${pageNumber}`, 'Metin', options)
      const pageTable = extractHorizontalLicenseTables(text, `PDF s. ${pageNumber}`, 'Metin', options)
      generic.push(...pageGeneric)
      tableCandidates.push(...pageTable.candidates)
      if (pageTable.tableRows) bestDetection = pageTable.detection

      if (!pageTable.tableRows && pageGeneric.length < 3) {
        usedOcr = true
        const canvas = await renderPdfPage(page)
        const worker = await createOcrWorker(onProgress, 45 + Math.round(((pageNumber - 1) / pageCount) * 45), 45 / pageCount)
        try {
          const result = await worker.recognize(canvas)
          const ocrText = result.data.text
          generic.push(...extractCoordinatesFromText(ocrText, `PDF s. ${pageNumber}`, 'OCR', options))
          const ocrTable = extractHorizontalLicenseTables(ocrText, `PDF s. ${pageNumber}`, 'OCR', options)
          tableCandidates.push(...ocrTable.candidates)
          if (ocrTable.tableRows) bestDetection = ocrTable.detection
        } finally {
          await worker.terminate()
          canvas.width = 1
          canvas.height = 1
        }
      }
    }
  } finally {
    await loadingTask.destroy()
  }

  return buildResult(file.name, pdf.numPages, usedOcr, generic, {
    candidates: tableCandidates,
    detection: bestDetection,
    evidence: bestDetection.evidence,
    tableRows: tableCandidates.length,
  })
}

export async function scanCoordinateDocumentV3(file: File, options: DocumentCoordinateOptions, onProgress: ProgressHandler): Promise<DocumentScanResult> {
  if (file.size > MAX_FILE_BYTES) throw new Error('Belge en fazla 30 MB olabilir.')
  const lowerName = file.name.toLowerCase()

  if (file.type.startsWith('image/')) {
    const result = await scanImageV3(file, options, onProgress)
    onProgress({ percent: 100, label: `${result.candidates.length} koordinat analiz edildi` })
    return result
  }

  if (file.type === 'application/pdf' || lowerName.endsWith('.pdf')) {
    // Önce yeni tablo okuma; başarısız olursa 2.0 sonucu yedek olarak birleştir.
    const tableResult = await scanPdfTableSupplement(file, options, onProgress)
    if (tableResult.stats.tableRows >= 3) {
      onProgress({ percent: 100, label: `${tableResult.candidates.length} koordinat analiz edildi` })
      return tableResult
    }
    const fallback = await scanCoordinateDocumentV2(file, options, onProgress)
    onProgress({ percent: 100, label: `${fallback.candidates.length} koordinat analiz edildi` })
    return fallback
  }

  if (lowerName.endsWith('.docx') || /\.(?:txt|csv|tsv)$/i.test(lowerName) || file.type.startsWith('text/')) {
    onProgress({ percent: 18, label: 'Belge metni ve tablo satırları okunuyor…' })
    const text = lowerName.endsWith('.docx') ? await textFromDocx(file) : await file.text()
    const generic = extractCoordinatesFromText(text, lowerName.endsWith('.docx') ? 'Word belgesi' : 'Belge', 'Metin', options)
    const table = extractHorizontalLicenseTables(text, lowerName.endsWith('.docx') ? 'Word belgesi' : 'Belge', 'Metin', options)
    const result = buildResult(file.name, 1, false, generic, table)
    onProgress({ percent: 100, label: `${result.candidates.length} koordinat analiz edildi` })
    return result
  }

  return scanCoordinateDocumentV2(file, options, onProgress)
}
