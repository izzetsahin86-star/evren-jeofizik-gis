import { fromUtm } from './geo'
import type {
  DocumentCoordinateCandidate,
  DocumentCoordinateConfidence,
  DocumentCoordinateOptions,
  DocumentScanProgress,
  DocumentScanResult,
} from './documentCoordinates'
import { scanCoordinateDocumentV6 } from './documentCoordinatesV6'

type ProgressHandler = (progress: DocumentScanProgress) => void

type LineBand = { top: number; bottom: number; center: number; strength: number }
type ParsedRow = { top: number; bottom: number; kind: 'east' | 'north'; values: number[]; text: string; score: number }

const MAX_FILE_BYTES = 30 * 1024 * 1024
const MAX_ANALYSIS_PIXELS = 5_000_000

function confidenceLevel(value: number): DocumentCoordinateConfidence {
  if (value >= 85) return 'high'
  if (value >= 65) return 'medium'
  return 'low'
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

async function imageCanvas(file: File) {
  const bitmap = await createImageBitmap(file)
  const scale = Math.min(1, Math.sqrt(MAX_ANALYSIS_PIXELS / Math.max(1, bitmap.width * bitmap.height)))
  const canvas = document.createElement('canvas')
  canvas.width = Math.max(1, Math.round(bitmap.width * scale))
  canvas.height = Math.max(1, Math.round(bitmap.height * scale))
  const context = canvas.getContext('2d', { willReadFrequently: true })!
  context.drawImage(bitmap, 0, 0, canvas.width, canvas.height)
  bitmap.close()
  return canvas
}

function detectHorizontalLines(canvas: HTMLCanvasElement) {
  const context = canvas.getContext('2d', { willReadFrequently: true })!
  const image = context.getImageData(0, 0, canvas.width, canvas.height)
  const { data } = image
  const width = canvas.width
  const height = canvas.height
  const x0 = Math.round(width * 0.08)
  const x1 = Math.round(width * 0.92)
  const y0 = Math.round(height * 0.25)
  const y1 = Math.round(height * 0.84)
  const stepX = Math.max(1, Math.round(width / 900))
  const candidates: Array<{ y: number; ratio: number }> = []

  for (let y = y0; y < y1; y += 1) {
    let dark = 0
    let total = 0
    for (let x = x0; x < x1; x += stepX) {
      const offset = (y * width + x) * 4
      const gray = data[offset] * 0.299 + data[offset + 1] * 0.587 + data[offset + 2] * 0.114
      if (gray < 125) dark += 1
      total += 1
    }
    const ratio = total ? dark / total : 0
    if (ratio >= 0.42) candidates.push({ y, ratio })
  }

  const bands: LineBand[] = []
  for (const candidate of candidates) {
    const current = bands.at(-1)
    if (!current || candidate.y > current.bottom + 2) {
      bands.push({ top: candidate.y, bottom: candidate.y, center: candidate.y, strength: candidate.ratio })
    } else {
      current.bottom = candidate.y
      current.center = (current.top + current.bottom) / 2
      current.strength = Math.max(current.strength, candidate.ratio)
    }
  }

  return bands.filter((band) => band.bottom - band.top <= Math.max(14, height * 0.012))
}

function cropRow(source: HTMLCanvasElement, top: number, bottom: number) {
  const marginY = Math.max(2, Math.round((bottom - top) * 0.09))
  const sourceTop = Math.max(0, Math.round(top + marginY))
  const sourceBottom = Math.min(source.height, Math.round(bottom - marginY))
  const sourceLeft = Math.round(source.width * 0.145)
  const sourceRight = Math.round(source.width * 0.925)
  const sourceWidth = Math.max(1, sourceRight - sourceLeft)
  const sourceHeight = Math.max(1, sourceBottom - sourceTop)
  const scale = Math.max(2.4, Math.min(3.4, 72 / sourceHeight))

  const canvas = document.createElement('canvas')
  canvas.width = Math.max(1, Math.round(sourceWidth * scale))
  canvas.height = Math.max(1, Math.round(sourceHeight * scale))
  const context = canvas.getContext('2d', { willReadFrequently: true })!
  context.fillStyle = '#fff'
  context.fillRect(0, 0, canvas.width, canvas.height)
  context.imageSmoothingEnabled = false
  context.drawImage(source, sourceLeft, sourceTop, sourceWidth, sourceHeight, 0, 0, canvas.width, canvas.height)

  const image = context.getImageData(0, 0, canvas.width, canvas.height)
  const { data } = image
  const width = canvas.width
  const height = canvas.height

  // Hücrelerin dikey çizgilerini temizle; Tesseract bunları bazen "1" olarak okuyor.
  const vertical: number[] = []
  for (let x = 0; x < width; x += 1) {
    let dark = 0
    for (let y = 0; y < height; y += 1) {
      const offset = (y * width + x) * 4
      const gray = data[offset] * 0.299 + data[offset + 1] * 0.587 + data[offset + 2] * 0.114
      if (gray < 110) dark += 1
    }
    if (dark / height > 0.68) vertical.push(x)
  }
  for (const x of vertical) {
    for (let dx = -2; dx <= 2; dx += 1) {
      const px = x + dx
      if (px < 0 || px >= width) continue
      for (let y = 0; y < height; y += 1) {
        const offset = (y * width + px) * 4
        data[offset] = 255
        data[offset + 1] = 255
        data[offset + 2] = 255
      }
    }
  }

  // Yüksek kontrastlı siyah/beyaz şerit rakam OCR'ını belirgin biçimde iyileştirir.
  for (let offset = 0; offset < data.length; offset += 4) {
    const gray = data[offset] * 0.299 + data[offset + 1] * 0.587 + data[offset + 2] * 0.114
    const value = gray < 175 ? 0 : 255
    data[offset] = value
    data[offset + 1] = value
    data[offset + 2] = value
    data[offset + 3] = 255
  }
  context.putImageData(image, 0, 0)
  return canvas
}

function validValue(value: number, kind: 'east' | 'north') {
  return kind === 'east'
    ? value >= 100_000 && value <= 900_000
    : value >= 3_500_000 && value <= 5_200_000
}

function segmentDigits(digits: string, kind: 'east' | 'north') {
  let best: { values: number[]; score: number } = { values: [], score: -Infinity }
  const maxNoise = Math.min(8, digits.length)
  const sizes = kind === 'east' ? [7, 6] : [7]

  for (const size of sizes) {
    for (let start = 0; start < maxNoise; start += 1) {
      const values: number[] = []
      let invalid = 0
      for (let cursor = start; cursor + size <= digits.length; cursor += size) {
        const chunk = digits.slice(cursor, cursor + size)
        const value = Number(chunk)
        if (validValue(value, kind)) values.push(value)
        else invalid += 1
      }
      const remainder = Math.max(0, (digits.length - start) % size)
      const score = values.length * 20 - invalid * 12 - start * 1.5 - remainder * 2
      if (values.length >= 3 && score > best.score) best = { values, score }
    }
  }
  return best
}

function parseDigitRow(text: string, top: number, bottom: number): ParsedRow | null {
  const digits = text.replace(/\D/g, '')
  if (digits.length < 18) return null
  const east = segmentDigits(digits, 'east')
  const north = segmentDigits(digits, 'north')
  const winner = east.score >= north.score ? { kind: 'east' as const, ...east } : { kind: 'north' as const, ...north }
  if (winner.values.length < 3) return null
  return { top, bottom, kind: winner.kind, values: winner.values, text, score: winner.score }
}

function pairRows(rows: ParsedRow[]) {
  const sorted = [...rows].sort((a, b) => a.top - b.top)
  const blocks: Array<{ east: ParsedRow; north: ParsedRow }> = []
  const used = new Set<number>()

  for (let index = 0; index < sorted.length; index += 1) {
    if (used.has(index) || sorted[index].kind !== 'east') continue
    let bestIndex = -1
    let bestScore = -Infinity
    for (let probe = index + 1; probe < Math.min(sorted.length, index + 4); probe += 1) {
      if (used.has(probe) || sorted[probe].kind !== 'north') continue
      const countDiff = Math.abs(sorted[index].values.length - sorted[probe].values.length)
      if (countDiff > 2) continue
      const gap = sorted[probe].top - sorted[index].bottom
      const score = Math.min(sorted[index].values.length, sorted[probe].values.length) * 30 - countDiff * 8 - Math.max(0, gap) * 0.08
      if (score > bestScore) {
        bestScore = score
        bestIndex = probe
      }
    }
    if (bestIndex >= 0) {
      blocks.push({ east: sorted[index], north: sorted[bestIndex] })
      used.add(index)
      used.add(bestIndex)
    }
  }
  return blocks
}

function buildRecoveredResult(base: DocumentScanResult, blocks: Array<{ east: ParsedRow; north: ParsedRow }>) {
  const zone = base.detection.zone ?? 36
  const hemisphere = base.detection.hemisphere ?? 'N'
  const datum = base.detection.datum ?? 'WGS84'
  const candidates: DocumentCoordinateCandidate[] = []
  let pointNumber = 1

  for (const block of blocks) {
    const count = Math.min(block.east.values.length, block.north.values.length)
    for (let index = 0; index < count; index += 1) {
      const easting = block.east.values[index]
      const northing = block.north.values[index]
      const point = safeFromUtm(easting, northing, zone, hemisphere, datum)
      if (!point) continue
      const inTurkey = point.lat >= 34.5 && point.lat <= 43.2 && point.lng >= 24.5 && point.lng <= 46.5
      let confidence = 96
      if (base.detection.evidence.some((item) => /tahmini/i.test(item))) confidence -= 1
      if (base.detection.evidence.some((item) => /Datum belgede bulunamadı/i.test(item))) confidence -= 3
      if (!inTurkey) confidence -= 18
      const name = `${pointNumber}.Nokta`
      candidates.push({
        id: `doc-v7-${pointNumber}-${easting}-${northing}`,
        lat: point.lat,
        lng: point.lng,
        format: 'UTM',
        raw: `${name} · Sağa(Y) ${String(easting).padStart(7, '0')} · Yukarı(X) ${northing}`,
        source: 'Görsel · tablo satırı kurtarma',
        sourceKind: 'OCR',
        name,
        group: 'Ruhsat Koordinatları',
        confidence,
        confidenceLevel: confidenceLevel(confidence),
        reasons: [
          'Tablo yatay çizgileri görüntüden algılandı',
          'Koordinat satırı bağımsız rakam OCR ile okundu',
          'Sağa(Y) = Easting',
          'Yukarı(X) = Northing',
          ...base.detection.evidence,
        ],
        zone,
        hemisphere,
        datum,
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
  const finalCandidates = Array.from(unique.values()).map((candidate, index) => ({
    ...candidate,
    id: `doc-v7-${index + 1}-${candidate.lat.toFixed(6)}-${candidate.lng.toFixed(6)}`,
    name: `${index + 1}.Nokta`,
    raw: candidate.raw.replace(/^\d+\.Nokta/, `${index + 1}.Nokta`),
  }))

  return {
    ...base,
    candidates: finalCandidates,
    detection: {
      ...base.detection,
      evidence: Array.from(new Set([...base.detection.evidence, `${finalCandidates.length} ruhsat koordinatı tablo satırlarından bağımsız OCR ile eşleştirildi`])),
    },
    stats: {
      high: finalCandidates.filter((item) => item.confidenceLevel === 'high').length,
      medium: finalCandidates.filter((item) => item.confidenceLevel === 'medium').length,
      low: finalCandidates.filter((item) => item.confidenceLevel === 'low').length,
      duplicatesRemoved: 0,
      tableRows: finalCandidates.length,
    },
    warning: finalCandidates.length >= 3 && finalCandidates.length < 15
      ? `${finalCandidates.length} ruhsat noktası tablo satırlarından okundu; belge üzerindeki tüm tablo blokları algılanamamış olabilir.`
      : undefined,
  } satisfies DocumentScanResult
}

async function recoverGridRows(file: File, base: DocumentScanResult, onProgress: ProgressHandler) {
  const canvas = await imageCanvas(file)
  const lines = detectHorizontalLines(canvas)
  const minGap = Math.max(12, canvas.height * 0.009)
  const maxGap = Math.max(70, canvas.height * 0.045)
  const intervals: Array<{ top: number; bottom: number }> = []

  for (let index = 0; index < lines.length - 1; index += 1) {
    const top = lines[index].center
    const bottom = lines[index + 1].center
    const gap = bottom - top
    if (gap >= minGap && gap <= maxGap) intervals.push({ top, bottom })
  }

  if (!intervals.length) {
    canvas.width = 1
    canvas.height = 1
    return base
  }

  const { createWorker, PSM } = await import('tesseract.js')
  const worker = await createWorker('eng', 1, {
    logger: (message) => {
      if (message.status !== 'recognizing text') return
      onProgress({ percent: Math.min(97, 68 + Math.round(message.progress * 28)), label: `Tablo satırları ayrı ayrı okunuyor · %${Math.round(message.progress * 100)}` })
    },
  })

  try {
    await worker.setParameters({
      tessedit_pageseg_mode: PSM.SINGLE_LINE,
      tessedit_char_whitelist: '0123456789 ',
      preserve_interword_spaces: '1',
    })

    const parsed: ParsedRow[] = []
    // En fazla 14 küçük satır OCR'ı; tablo çizgisi olmayan sayfalarda maliyeti sınırlı tut.
    for (const interval of intervals.slice(0, 14)) {
      const rowCanvas = cropRow(canvas, interval.top, interval.bottom)
      try {
        const recognized = await worker.recognize(rowCanvas)
        const row = parseDigitRow(recognized.data.text ?? '', interval.top, interval.bottom)
        if (row) parsed.push(row)
      } finally {
        rowCanvas.width = 1
        rowCanvas.height = 1
      }
    }

    const blocks = pairRows(parsed)
    const recovered = buildRecoveredResult(base, blocks)
    return recovered.stats.tableRows > base.stats.tableRows ? recovered : base
  } finally {
    await worker.terminate()
    canvas.width = 1
    canvas.height = 1
  }
}

export async function scanCoordinateDocumentV7(file: File, options: DocumentCoordinateOptions, onProgress: ProgressHandler): Promise<DocumentScanResult> {
  if (file.size > MAX_FILE_BYTES) throw new Error('Belge en fazla 30 MB olabilir.')
  const base = await scanCoordinateDocumentV6(file, options, onProgress)
  if (!file.type.startsWith('image/') || base.stats.tableRows >= 12) return base

  onProgress({ percent: 66, label: 'Eksik tablo blokları görüntü çizgilerinden aranıyor…' })
  const recovered = await recoverGridRows(file, base, onProgress)
  onProgress({ percent: 100, label: `${recovered.candidates.length} koordinat analiz edildi` })
  return recovered
}
