import { fromUtm } from './geo'
import {
  type DocumentCoordinateCandidate,
  type DocumentCoordinateConfidence,
  type DocumentCoordinateOptions,
  type DocumentScanProgress,
  type DocumentScanResult,
} from './documentCoordinates'
import { scanCoordinateDocumentV4 } from './documentCoordinatesV4'

type ProgressHandler = (progress: DocumentScanProgress) => void
type NumericToken = { value: number; index: number; kind: 'east' | 'north' }
type Run = { kind: 'east' | 'north'; tokens: NumericToken[] }

const MAX_FILE_BYTES = 30 * 1024 * 1024
const MAX_OCR_PIXELS = 10_000_000
const METRIC_TOKEN = /\b0?\d{6,7}\b/g

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

function detectContext(text: string, options: DocumentCoordinateOptions) {
  const folded = fold(text)
  const zoneMatch = folded.match(/\b(?:UTM\s*)?(?:ZONE|ZON|DILIM)\s*[:=-]?\s*([1-5]?\d|60)\s*([NS])?\b/)
  let zone = zoneMatch ? Number(zoneMatch[1]) : options.zone
  let hemisphere: 'N' | 'S' = zoneMatch?.[2] === 'S' ? 'S' : 'N'
  const evidence: string[] = []

  if (zoneMatch) {
    evidence.push(`Zone ${zone}${hemisphere} belgeden algılandı`)
  } else if (/\bDENIZLI\b|\bBULDAN\b/.test(folded)) {
    zone = 35
    hemisphere = 'N'
    evidence.push('İl DENIZLI → UTM Zone 35N tahmini')
  } else {
    evidence.push(`Zone belgede bulunamadı; varsayılan Zone ${zone} kullanıldı`)
  }

  let datum = options.datum
  if (/\bED\s*[- ]?50\b|EUROPEAN\s+DATUM\s+1950/.test(folded)) {
    datum = 'ED50'
    evidence.push('ED50 datum belgeden algılandı')
  } else if (/\bWGS\s*[- ]?84\b|ITRF\d*|TUREF|ETRS\d*/.test(folded)) {
    datum = 'WGS84'
    evidence.push('WGS84/modern datum belgeden algılandı')
  } else {
    evidence.push(`Datum belgede bulunamadı; seçili ${datum} kullanıldı`)
  }

  return { zone, hemisphere, datum, evidence }
}

function numericTokens(text: string): NumericToken[] {
  const tokens: NumericToken[] = []
  for (const match of text.matchAll(METRIC_TOKEN)) {
    const value = Number(match[0])
    const index = match.index ?? 0
    if (value >= 100_000 && value <= 900_000) tokens.push({ value, index, kind: 'east' })
    else if (value >= 1_000_000 && value <= 9_999_999) tokens.push({ value, index, kind: 'north' })
  }
  return tokens
}

function buildRuns(tokens: NumericToken[]): Run[] {
  const runs: Run[] = []
  for (const token of tokens) {
    const current = runs.at(-1)
    if (!current || current.kind !== token.kind || token.index - current.tokens.at(-1)!.index > 420) {
      runs.push({ kind: token.kind, tokens: [token] })
    } else {
      current.tokens.push(token)
    }
  }
  return runs
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

function parseGlobalRuhsatTable(text: string, options: DocumentCoordinateOptions) {
  const context = detectContext(text, options)
  const runs = buildRuns(numericTokens(text))
  const candidates: DocumentCoordinateCandidate[] = []
  let pointNumber = 1

  for (let runIndex = 0; runIndex < runs.length; runIndex += 1) {
    const eastRun = runs[runIndex]
    if (eastRun.kind !== 'east' || eastRun.tokens.length < 4) continue

    let northRun: Run | undefined
    for (let probe = runIndex + 1; probe < Math.min(runs.length, runIndex + 3); probe += 1) {
      if (runs[probe].kind === 'north' && runs[probe].tokens.length >= 4) {
        northRun = runs[probe]
        break
      }
    }
    if (!northRun) continue

    const count = Math.min(eastRun.tokens.length, northRun.tokens.length)
    if (count < 4) continue

    for (let column = 0; column < count; column += 1) {
      const easting = eastRun.tokens[column].value
      const northing = northRun.tokens[column].value
      const point = safeFromUtm(easting, northing, context.zone, context.hemisphere, context.datum)
      if (!point) continue

      const inTurkey = point.lat >= 34.5 && point.lat <= 43.2 && point.lng >= 24.5 && point.lng <= 46.5
      let confidence = 91
      if (/tahmini/.test(context.evidence[0] ?? '')) confidence -= 1
      if (/Datum belgede bulunamadı/.test(context.evidence[1] ?? '')) confidence -= 3
      confidence += inTurkey ? 2 : -15
      confidence = Math.max(10, Math.min(99, confidence))
      const name = `${pointNumber}.Nokta`

      candidates.push({
        id: `doc-v5-${pointNumber}-${easting}-${northing}`,
        lat: point.lat,
        lng: point.lng,
        format: 'UTM',
        raw: `${name} · Sağa(Y) ${String(easting).padStart(7, '0')} · Yukarı(X) ${northing}`,
        source: 'Görsel · ruhsat tablosu',
        sourceKind: 'OCR',
        name,
        group: 'Ruhsat Koordinatları',
        confidence,
        confidenceLevel: confidenceLevel(confidence),
        reasons: [
          'Ruhsat koordinat bölümü sayı kümelerinden eşleştirildi',
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

    runIndex = runs.indexOf(northRun)
  }

  const unique = new Map<string, DocumentCoordinateCandidate>()
  for (const candidate of candidates) {
    const key = `${candidate.lat.toFixed(7)}:${candidate.lng.toFixed(7)}`
    if (!unique.has(key)) unique.set(key, candidate)
  }
  const result = Array.from(unique.values()).map((candidate, index) => ({
    ...candidate,
    id: `doc-v5-${index + 1}-${candidate.lat.toFixed(6)}-${candidate.lng.toFixed(6)}`,
    name: `${index + 1}.Nokta`,
    raw: candidate.raw.replace(/^\d+\.Nokta/, `${index + 1}.Nokta`),
  }))

  return { candidates: result, context }
}

async function preprocess(file: File) {
  const bitmap = await createImageBitmap(file)
  const scale = Math.min(2.15, Math.sqrt(MAX_OCR_PIXELS / Math.max(1, bitmap.width * bitmap.height)))
  const canvas = document.createElement('canvas')
  canvas.width = Math.max(1, Math.round(bitmap.width * scale))
  canvas.height = Math.max(1, Math.round(bitmap.height * scale))
  const context = canvas.getContext('2d', { willReadFrequently: true })!
  context.drawImage(bitmap, 0, 0, canvas.width, canvas.height)
  bitmap.close()

  const image = context.getImageData(0, 0, canvas.width, canvas.height)
  for (let index = 0; index < image.data.length; index += 4) {
    const gray = image.data[index] * 0.299 + image.data[index + 1] * 0.587 + image.data[index + 2] * 0.114
    const value = Math.max(0, Math.min(255, (gray - 124) * 1.62 + 124))
    image.data[index] = value
    image.data[index + 1] = value
    image.data[index + 2] = value
  }
  context.putImageData(image, 0, 0)
  return canvas
}

async function scanImage(file: File, options: DocumentCoordinateOptions, onProgress: ProgressHandler): Promise<DocumentScanResult> {
  const canvas = await preprocess(file)
  const { createWorker, PSM } = await import('tesseract.js')
  const worker = await createWorker('eng', 1, {
    logger: (message) => {
      if (message.status !== 'recognizing text') return
      onProgress({
        percent: Math.min(96, 8 + Math.round(message.progress * 84)),
        label: `Ruhsat koordinat kümeleri okunuyor · %${Math.round(message.progress * 100)}`,
      })
    },
  })

  try {
    const attempts = [PSM.AUTO, PSM.SPARSE_TEXT]
    let bestText = ''
    let best = parseGlobalRuhsatTable('', options)

    for (const mode of attempts) {
      await worker.setParameters({ tessedit_pageseg_mode: mode, preserve_interword_spaces: '1' })
      const recognized = await worker.recognize(canvas)
      const parsed = parseGlobalRuhsatTable(recognized.data.text, options)
      if (parsed.candidates.length > best.candidates.length) {
        best = parsed
        bestText = recognized.data.text
      }
      if (best.candidates.length >= 15) break
    }

    if (best.candidates.length >= 3) {
      const candidates = best.candidates
      return {
        fileName: file.name,
        pageCount: 1,
        usedOcr: true,
        candidates,
        detection: {
          zone: best.context.zone,
          hemisphere: best.context.hemisphere,
          datum: best.context.datum,
          evidence: [...best.context.evidence, `${candidates.length} ruhsat koordinatı sayı kümelerinden eşleştirildi`],
        },
        stats: {
          high: candidates.filter((item) => item.confidenceLevel === 'high').length,
          medium: candidates.filter((item) => item.confidenceLevel === 'medium').length,
          low: candidates.filter((item) => item.confidenceLevel === 'low').length,
          duplicatesRemoved: 0,
          tableRows: candidates.length,
        },
        warning: candidates.length < 15
          ? `${candidates.length} ruhsat noktası bulundu; tablo beklenen tüm sütunları vermemiş olabilir.`
          : undefined,
      }
    }

    void bestText
    return scanCoordinateDocumentV4(file, options, onProgress)
  } finally {
    await worker.terminate()
    canvas.width = 1
    canvas.height = 1
  }
}

export async function scanCoordinateDocumentV5(file: File, options: DocumentCoordinateOptions, onProgress: ProgressHandler): Promise<DocumentScanResult> {
  if (file.size > MAX_FILE_BYTES) throw new Error('Belge en fazla 30 MB olabilir.')
  if (!file.type.startsWith('image/')) return scanCoordinateDocumentV4(file, options, onProgress)
  onProgress({ percent: 4, label: 'Görsel ruhsat hazırlanıyor…' })
  const result = await scanImage(file, options, onProgress)
  onProgress({ percent: 100, label: `${result.candidates.length} koordinat analiz edildi` })
  return result
}
