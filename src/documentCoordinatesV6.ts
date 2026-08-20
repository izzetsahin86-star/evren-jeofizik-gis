import { fromUtm } from './geo'
import {
  type DocumentCoordinateCandidate,
  type DocumentCoordinateConfidence,
  type DocumentCoordinateOptions,
  type DocumentScanProgress,
  type DocumentScanResult,
} from './documentCoordinates'
import { scanCoordinateDocumentV5 } from './documentCoordinatesV5'

type ProgressHandler = (progress: DocumentScanProgress) => void

type OcrWord = {
  text: string
  left: number
  top: number
  width: number
  height: number
  confidence: number
}

type NumericWord = OcrWord & {
  value: number
  kind: 'east' | 'north'
  centerX: number
  centerY: number
}

type NumericRow = {
  kind: 'east' | 'north'
  words: NumericWord[]
  centerY: number
  meanHeight: number
}

type TablePair = {
  east: NumericRow
  north: NumericRow
  pairs: Array<{ easting: number; northing: number; x: number }>
  score: number
}

const MAX_FILE_BYTES = 30 * 1024 * 1024
const MAX_OCR_PIXELS = 11_000_000

function fold(value: string) {
  return value.toLocaleUpperCase('tr-TR')
    .replace(/İ/g, 'I').replace(/Ş/g, 'S').replace(/Ğ/g, 'G')
    .replace(/Ü/g, 'U').replace(/Ö/g, 'O').replace(/Ç/g, 'C')
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
}

function confidenceLevel(value: number): DocumentCoordinateConfidence {
  if (value >= 85) return 'high'
  if (value >= 65) return 'medium'
  return 'low'
}

function normalizeNumberToken(raw: string) {
  return raw
    .replace(/[OoQ]/g, '0')
    .replace(/[Il|!]/g, '1')
    .replace(/[Ss]/g, '5')
    .replace(/[Bb]/g, '8')
    .replace(/[^0-9]/g, '')
}

function parseNumericWord(word: OcrWord): NumericWord | null {
  const digits = normalizeNumberToken(word.text)
  if (digits.length < 6 || digits.length > 8) return null
  let value = Number(digits)
  if (!Number.isFinite(value)) return null
  while (value > 9_999_999 && digits.startsWith('0')) value = Number(digits.slice(1))
  if (value >= 100_000 && value <= 900_000) {
    return { ...word, value, kind: 'east', centerX: word.left + word.width / 2, centerY: word.top + word.height / 2 }
  }
  if (value >= 3_500_000 && value <= 5_200_000) {
    return { ...word, value, kind: 'north', centerX: word.left + word.width / 2, centerY: word.top + word.height / 2 }
  }
  return null
}

function parseTsv(tsv: string, offsetTop = 0): OcrWord[] {
  const lines = tsv.split(/\r?\n/)
  const words: OcrWord[] = []
  for (let index = 1; index < lines.length; index += 1) {
    const columns = lines[index].split('\t')
    if (columns.length < 12 || columns[0] !== '5') continue
    const text = columns.slice(11).join('\t').trim()
    if (!text) continue
    const left = Number(columns[6])
    const top = Number(columns[7]) + offsetTop
    const width = Number(columns[8])
    const height = Number(columns[9])
    const confidence = Number(columns[10])
    if (![left, top, width, height].every(Number.isFinite)) continue
    words.push({ text, left, top, width, height, confidence: Number.isFinite(confidence) ? confidence : 0 })
  }
  return words
}

function median(values: number[]) {
  if (!values.length) return 0
  const sorted = [...values].sort((a, b) => a - b)
  const middle = Math.floor(sorted.length / 2)
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2
}

function buildRows(words: OcrWord[]) {
  const numeric = words.map(parseNumericWord).filter((word): word is NumericWord => Boolean(word))
  if (!numeric.length) return [] as NumericRow[]
  const baseHeight = Math.max(8, median(numeric.map((word) => word.height)))
  const tolerance = Math.max(7, baseHeight * 0.9)
  const rows: NumericRow[] = []

  for (const word of [...numeric].sort((a, b) => a.centerY - b.centerY || a.centerX - b.centerX)) {
    let row = rows.find((candidate) => candidate.kind === word.kind && Math.abs(candidate.centerY - word.centerY) <= tolerance)
    if (!row) {
      row = { kind: word.kind, words: [], centerY: word.centerY, meanHeight: word.height }
      rows.push(row)
    }
    row.words.push(word)
    row.centerY = row.words.reduce((sum, item) => sum + item.centerY, 0) / row.words.length
    row.meanHeight = row.words.reduce((sum, item) => sum + item.height, 0) / row.words.length
  }

  return rows
    .map((row) => ({ ...row, words: row.words.sort((a, b) => a.centerX - b.centerX) }))
    .filter((row) => row.words.length >= 3)
    .sort((a, b) => a.centerY - b.centerY)
}

function matchColumns(east: NumericRow, north: NumericRow) {
  const eastWords = east.words
  const northWords = north.words
  const used = new Set<number>()
  const pairs: Array<{ easting: number; northing: number; x: number }> = []
  const typicalGap = eastWords.length > 1
    ? median(eastWords.slice(1).map((word, index) => word.centerX - eastWords[index].centerX))
    : 80
  const maxDx = Math.max(35, typicalGap * 0.55)

  for (const eastWord of eastWords) {
    let bestIndex = -1
    let bestDistance = Number.POSITIVE_INFINITY
    for (let index = 0; index < northWords.length; index += 1) {
      if (used.has(index)) continue
      const distance = Math.abs(northWords[index].centerX - eastWord.centerX)
      if (distance < bestDistance) {
        bestDistance = distance
        bestIndex = index
      }
    }
    if (bestIndex >= 0 && bestDistance <= maxDx) {
      const northWord = northWords[bestIndex]
      used.add(bestIndex)
      pairs.push({ easting: eastWord.value, northing: northWord.value, x: (eastWord.centerX + northWord.centerX) / 2 })
    }
  }

  if (pairs.length < Math.min(3, Math.min(eastWords.length, northWords.length))) {
    const count = Math.min(eastWords.length, northWords.length)
    return Array.from({ length: count }, (_, index) => ({
      easting: eastWords[index].value,
      northing: northWords[index].value,
      x: (eastWords[index].centerX + northWords[index].centerX) / 2,
    }))
  }

  return pairs.sort((a, b) => a.x - b.x)
}

function findTablePairs(rows: NumericRow[]) {
  const pairs: TablePair[] = []
  for (let index = 0; index < rows.length; index += 1) {
    const east = rows[index]
    if (east.kind !== 'east' || east.words.length < 3) continue
    for (let probe = index + 1; probe < Math.min(rows.length, index + 5); probe += 1) {
      const north = rows[probe]
      if (north.kind !== 'north' || north.words.length < 3) continue
      const verticalGap = north.centerY - east.centerY
      const maxGap = Math.max(90, Math.max(east.meanHeight, north.meanHeight) * 6.5)
      if (verticalGap <= 0 || verticalGap > maxGap) continue
      const matched = matchColumns(east, north)
      if (matched.length < 3) continue
      const countDifference = Math.abs(east.words.length - north.words.length)
      const score = matched.length * 20 - countDifference * 6 - verticalGap * 0.05
      pairs.push({ east, north, pairs: matched, score })
      break
    }
  }

  const selected: TablePair[] = []
  for (const pair of pairs.sort((a, b) => b.score - a.score)) {
    const overlaps = selected.some((existing) => (
      Math.abs(existing.east.centerY - pair.east.centerY) < 20
      || Math.abs(existing.north.centerY - pair.north.centerY) < 20
    ))
    if (!overlaps) selected.push(pair)
  }
  return selected.sort((a, b) => a.east.centerY - b.east.centerY)
}

function detectContext(text: string, options: DocumentCoordinateOptions) {
  const folded = fold(text)
  const zoneMatch = folded.match(/\b(?:UTM\s*)?(?:ZONE|ZON|DILIM)\s*[:=\-]?\s*([1-5]?\d|60)\s*([NS])?\b/)
  let zone = zoneMatch ? Number(zoneMatch[1]) : options.zone
  let hemisphere: 'N' | 'S' = zoneMatch?.[2] === 'S' ? 'S' : 'N'
  const evidence: string[] = []

  if (zoneMatch) evidence.push(`Zone ${zone}${hemisphere} belgeden algılandı`)
  else if (/\bDENIZLI\b|\bBULDAN\b/.test(folded)) {
    zone = 35
    hemisphere = 'N'
    evidence.push('İl DENIZLI → UTM Zone 35N tahmini')
  } else evidence.push(`Zone belgede bulunamadı; varsayılan Zone ${zone} kullanıldı`)

  let datum = options.datum
  if (/\bED\s*[- ]?50\b|EUROPEAN\s+DATUM\s+1950/.test(folded)) {
    datum = 'ED50'
    evidence.push('ED50 datum belgeden algılandı')
  } else if (/\bWGS\s*[- ]?84\b|ITRF\d*|TUREF|ETRS\d*/.test(folded)) {
    datum = 'WGS84'
    evidence.push('WGS84/modern datum belgeden algılandı')
  } else evidence.push(`Datum belgede bulunamadı; seçili ${datum} kullanıldı`)

  return { zone, hemisphere, datum, evidence }
}

function safeFromUtm(easting: number, northing: number, zone: number, hemisphere: 'N' | 'S', datum: string) {
  try {
    const point = fromUtm(easting, northing, zone, hemisphere, datum)
    if (!Number.isFinite(point.lat) || !Number.isFinite(point.lng)) return null
    return point
  } catch {
    return null
  }
}

function candidatesFromPairs(tablePairs: TablePair[], context: ReturnType<typeof detectContext>) {
  const candidates: DocumentCoordinateCandidate[] = []
  let pointNumber = 1

  for (const table of tablePairs) {
    for (const pair of table.pairs) {
      const point = safeFromUtm(pair.easting, pair.northing, context.zone, context.hemisphere, context.datum)
      if (!point) continue
      const inTurkey = point.lat >= 34.5 && point.lat <= 43.2 && point.lng >= 24.5 && point.lng <= 46.5
      let confidence = 95
      if (/tahmini/.test(context.evidence[0] ?? '')) confidence -= 1
      if (/Datum belgede bulunamadı/.test(context.evidence[1] ?? '')) confidence -= 3
      confidence += inTurkey ? 2 : -18
      confidence = Math.max(10, Math.min(99, Math.round(confidence)))
      const name = `${pointNumber}.Nokta`
      candidates.push({
        id: `doc-v6-${pointNumber}-${pair.easting}-${pair.northing}`,
        lat: point.lat,
        lng: point.lng,
        format: 'UTM',
        raw: `${name} · Sağa(Y) ${String(pair.easting).padStart(7, '0')} · Yukarı(X) ${pair.northing}`,
        source: 'Görsel · geometrik ruhsat tablosu',
        sourceKind: 'OCR',
        name,
        group: 'Ruhsat Koordinatları',
        confidence,
        confidenceLevel: confidenceLevel(confidence),
        reasons: [
          'OCR kelime kutuları X/Y konumuna göre eşleştirildi',
          'Sağa(Y) = Easting',
          'Yukarı(X) = Northing',
          ...context.evidence,
        ],
        zone: context.zone,
        hemisphere: context.hemisphere,
        datum: context.datum,
        correctedOrder: false,
      })
      pointNumber += 1
    }
  }

  const unique = new Map<string, DocumentCoordinateCandidate>()
  for (const candidate of candidates) {
    const key = `${candidate.lat.toFixed(7)}:${candidate.lng.toFixed(7)}`
    if (!unique.has(key)) unique.set(key, candidate)
  }
  return Array.from(unique.values()).map((candidate, index) => ({
    ...candidate,
    id: `doc-v6-${index + 1}-${candidate.lat.toFixed(6)}-${candidate.lng.toFixed(6)}`,
    name: `${index + 1}.Nokta`,
    raw: candidate.raw.replace(/^\d+\.Nokta/, `${index + 1}.Nokta`),
  }))
}

async function preprocess(file: File) {
  const bitmap = await createImageBitmap(file)
  const scale = Math.min(2.35, Math.sqrt(MAX_OCR_PIXELS / Math.max(1, bitmap.width * bitmap.height)))
  const canvas = document.createElement('canvas')
  canvas.width = Math.max(1, Math.round(bitmap.width * scale))
  canvas.height = Math.max(1, Math.round(bitmap.height * scale))
  const context = canvas.getContext('2d', { willReadFrequently: true })!
  context.drawImage(bitmap, 0, 0, canvas.width, canvas.height)
  bitmap.close()

  const image = context.getImageData(0, 0, canvas.width, canvas.height)
  for (let index = 0; index < image.data.length; index += 4) {
    const gray = image.data[index] * 0.299 + image.data[index + 1] * 0.587 + image.data[index + 2] * 0.114
    const value = Math.max(0, Math.min(255, (gray - 126) * 1.48 + 126))
    image.data[index] = value
    image.data[index + 1] = value
    image.data[index + 2] = value
  }
  context.putImageData(image, 0, 0)
  return canvas
}

function cropCanvas(source: HTMLCanvasElement, topRatio: number, bottomRatio: number) {
  const top = Math.max(0, Math.round(source.height * topRatio))
  const bottom = Math.min(source.height, Math.round(source.height * bottomRatio))
  const canvas = document.createElement('canvas')
  canvas.width = source.width
  canvas.height = Math.max(1, bottom - top)
  const context = canvas.getContext('2d')!
  context.drawImage(source, 0, top, source.width, canvas.height, 0, 0, source.width, canvas.height)
  return { canvas, offsetTop: top }
}

async function recognizeGeometry(worker: Awaited<ReturnType<typeof import('tesseract.js')['createWorker']>>, image: HTMLCanvasElement, offsetTop = 0) {
  const recognized = await worker.recognize(image, {}, { text: true, tsv: true })
  const words = parseTsv(recognized.data.tsv ?? '', offsetTop)
  const rows = buildRows(words)
  const tablePairs = findTablePairs(rows)
  return { text: recognized.data.text ?? '', words, rows, tablePairs }
}

export async function scanCoordinateDocumentV6(file: File, options: DocumentCoordinateOptions, onProgress: ProgressHandler): Promise<DocumentScanResult> {
  if (file.size > MAX_FILE_BYTES) throw new Error('Belge en fazla 30 MB olabilir.')
  if (!file.type.startsWith('image/')) return scanCoordinateDocumentV5(file, options, onProgress)

  onProgress({ percent: 3, label: 'Görsel ve tablo geometrisi hazırlanıyor…' })
  const canvas = await preprocess(file)
  const { createWorker, PSM } = await import('tesseract.js')
  const worker = await createWorker('eng', 1, {
    logger: (message) => {
      if (message.status !== 'recognizing text') return
      onProgress({
        percent: Math.min(96, 8 + Math.round(message.progress * 82)),
        label: `Tablo hücreleri geometrik olarak okunuyor · %${Math.round(message.progress * 100)}`,
      })
    },
  })

  try {
    await worker.setParameters({ tessedit_pageseg_mode: PSM.AUTO, preserve_interword_spaces: '1' })
    const full = await recognizeGeometry(worker, canvas)
    let allText = full.text
    let allPairs = full.tablePairs

    if (allPairs.reduce((sum, table) => sum + table.pairs.length, 0) < 12) {
      const crop = cropCanvas(canvas, 0.43, 0.72)
      try {
        await worker.setParameters({
          tessedit_pageseg_mode: PSM.SPARSE_TEXT,
          preserve_interword_spaces: '1',
          tessedit_char_whitelist: '0123456789().NoktaSaYukariXY ',
        })
        const focused = await recognizeGeometry(worker, crop.canvas, crop.offsetTop)
        allText += `\n${focused.text}`
        const combinedRows = buildRows([...full.words, ...focused.words])
        allPairs = findTablePairs(combinedRows)
      } finally {
        crop.canvas.width = 1
        crop.canvas.height = 1
      }
    }

    const context = detectContext(allText, options)
    const candidates = candidatesFromPairs(allPairs, context)

    if (candidates.length >= 3) {
      const result: DocumentScanResult = {
        fileName: file.name,
        pageCount: 1,
        usedOcr: true,
        candidates,
        detection: {
          zone: context.zone,
          hemisphere: context.hemisphere,
          datum: context.datum,
          evidence: [...context.evidence, `${candidates.length} ruhsat koordinatı geometrik tablo eşleştirmesiyle bulundu`],
        },
        stats: {
          high: candidates.filter((item) => item.confidenceLevel === 'high').length,
          medium: candidates.filter((item) => item.confidenceLevel === 'medium').length,
          low: candidates.filter((item) => item.confidenceLevel === 'low').length,
          duplicatesRemoved: 0,
          tableRows: candidates.length,
        },
        warning: candidates.length < 15
          ? `${candidates.length} ruhsat noktası bulundu. Geometrik OCR tabloyu kısmen okudu; sonuçları kontrol edin.`
          : undefined,
      }
      onProgress({ percent: 100, label: `${result.candidates.length} koordinat analiz edildi` })
      return result
    }

    return scanCoordinateDocumentV5(file, options, onProgress)
  } finally {
    await worker.terminate()
    canvas.width = 1
    canvas.height = 1
  }
}
