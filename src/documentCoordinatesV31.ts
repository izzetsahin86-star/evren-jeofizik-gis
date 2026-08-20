import { fromUtm } from './geo'
import {
  extractCoordinatesFromText,
  type DocumentCoordinateCandidate,
  type DocumentCoordinateConfidence,
  type DocumentCoordinateOptions,
  type DocumentScanProgress,
  type DocumentScanResult,
} from './documentCoordinates'
import { scanCoordinateDocumentV3 } from './documentCoordinatesV3'

type ProgressHandler = (progress: DocumentScanProgress) => void

const MAX_OCR_PIXELS = 9_000_000
const METRIC_TOKEN = /\b0?\d{6,7}\b/g

const ZONE35 = ['EDIRNE','KIRKLARELI','TEKIRDAG','ISTANBUL','CANAKKALE','BALIKESIR','BURSA','YALOVA','BILECIK','KUTAHYA','USAK','IZMIR','MANISA','AYDIN','MUGLA','DENIZLI']
const ZONE36 = ['DUZCE','BOLU','ZONGULDAK','BARTIN','KARABUK','KASTAMONU','SINOP','CANKIRI','ANKARA','ESKISEHIR','AFYONKARAHISAR','ISPARTA','BURDUR','ANTALYA','KONYA','KARAMAN','MERSIN','ADANA','NIGDE','AKSARAY','KIRIKKALE','KIRSEHIR','NEVSEHIR','YOZGAT','KAYSERI','CORUM','AMASYA']
const ZONE37 = ['SAMSUN','TOKAT','ORDU','GIRESUN','TRABZON','RIZE','ARTVIN','GUMUSHANE','BAYBURT','SIVAS','ERZINCAN','ERZURUM','MALATYA','ELAZIG','TUNCELI','BINGOL','MUS','DIYARBAKIR','MARDIN','SANLIURFA','GAZIANTEP','KILIS','HATAY','KAHRAMANMARAS','OSMANIYE','ADIYAMAN','BATMAN','SIIRT']
const ZONE38 = ['SIRNAK','HAKKARI','VAN','BITLIS','AGRI','IGDIR','KARS','ARDAHAN']

function fold(value: string) {
  return value.toLocaleUpperCase('tr-TR')
    .replace(/İ/g, 'I').replace(/Ş/g, 'S').replace(/Ğ/g, 'G').replace(/Ü/g, 'U').replace(/Ö/g, 'O').replace(/Ç/g, 'C')
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
}

function confidenceLevel(value: number): DocumentCoordinateConfidence {
  if (value >= 85) return 'high'
  if (value >= 65) return 'medium'
  return 'low'
}

function zoneFromText(text: string, fallback: number) {
  const folded = fold(text)
  const explicit = folded.match(/\b(?:UTM\s*)?(?:ZONE|ZON|DILIM)\s*[:=\-]?\s*([1-5]?\d|60)\b/)
  if (explicit) return { zone: Number(explicit[1]), evidence: `Zone ${explicit[1]} belgeden algılandı`, inferred: false }

  const beforeOwnerAddress = folded.split(/RUHSAT\s+SAHIBININ\s+ADRESI|RUHSAT\s+SAHIBI\s+ADRESI/)[0]
  const groups: Array<[number, string[]]> = [[35, ZONE35], [36, ZONE36], [37, ZONE37], [38, ZONE38]]
  for (const [zone, provinces] of groups) {
    for (const province of provinces) {
      if (new RegExp(`\\b${province}\\b`).test(beforeOwnerAddress)) return { zone, evidence: `İl ${province} → UTM Zone ${zone}N tahmini`, inferred: true }
    }
  }
  return { zone: fallback, evidence: `Zone belgede bulunamadı; varsayılan Zone ${fallback} kullanıldı`, inferred: false }
}

function datumFromText(text: string, fallback: string) {
  const folded = fold(text)
  if (/\bED\s*[- ]?50\b|EUROPEAN\s+DATUM\s+1950/.test(folded)) return { datum: 'ED50', evidence: 'ED50 datum belgeden algılandı', explicit: true }
  if (/\bWGS\s*[- ]?84\b|ITRF\d*|TUREF|ETRS\d*/.test(folded)) return { datum: 'WGS84', evidence: 'WGS84/modern datum belgeden algılandı', explicit: true }
  return { datum: fallback, evidence: `Datum belgede bulunamadı; seçili ${fallback} kullanıldı`, explicit: false }
}

function axisY(line: string) {
  const folded = fold(line)
  return /\(\s*Y\s*\)/.test(folded) || /\bSAGA\b/.test(folded) || /\bEASTING\b/.test(folded) || /\bDOGU\b/.test(folded)
}

function axisX(line: string) {
  const folded = fold(line)
  return /\(\s*X\s*\)/.test(folded) || /\bYUKARI\b/.test(folded) || /\bNORTHING\b/.test(folded) || /\bKUZEY\b/.test(folded)
}

function metricValues(line: string) {
  return Array.from(line.matchAll(METRIC_TOKEN), (match) => Number(match[0]))
}

function namesAbove(lines: string[], index: number, count: number, fallbackStart: number) {
  for (let offset = 1; offset <= 4; offset += 1) {
    const line = lines[index - offset]
    if (!line) continue
    const names = Array.from(line.matchAll(/\b(\d{1,3})\s*[.]?\s*(?:NOKTA|POINT)\b/gi), (match) => `${Number(match[1])}.Nokta`)
    if (names.length >= 2) return names.slice(0, count)
  }
  return Array.from({ length: count }, (_, i) => `${fallbackStart + i}.Nokta`)
}

function safeUtm(easting: number, northing: number, zone: number, datum: string) {
  if (easting < 100_000 || easting > 900_000 || northing < 1_000_000 || northing > 10_000_000) return null
  try {
    const point = fromUtm(easting, northing, zone, 'N', datum)
    if (!Number.isFinite(point.lat) || !Number.isFinite(point.lng)) return null
    return point
  } catch {
    return null
  }
}

function parseRuhsatTable(text: string, options: DocumentCoordinateOptions) {
  const normalized = text.replace(/\r/g, '').replace(/[ \t]+/g, ' ')
  const lines = normalized.split('\n').map((line) => line.trim()).filter(Boolean)
  const zoneInfo = zoneFromText(normalized, options.zone)
  const datumInfo = datumFromText(normalized, options.datum)
  const candidates: DocumentCoordinateCandidate[] = []
  let nextPoint = 1

  for (let i = 0; i < lines.length; i += 1) {
    if (!axisY(lines[i])) continue
    const yValues = metricValues(lines[i])
    if (yValues.length < 2) continue

    let xIndex = -1
    let xValues: number[] = []
    for (let j = i + 1; j <= Math.min(i + 4, lines.length - 1); j += 1) {
      if (!axisX(lines[j])) continue
      const values = metricValues(lines[j])
      if (values.length >= 2) {
        xIndex = j
        xValues = values
        break
      }
    }
    if (xIndex < 0) continue

    const count = Math.min(yValues.length, xValues.length)
    const names = namesAbove(lines, i, count, nextPoint)
    for (let column = 0; column < count; column += 1) {
      const easting = yValues[column]
      const northing = xValues[column]
      const point = safeUtm(easting, northing, zoneInfo.zone, datumInfo.datum)
      if (!point) continue
      let confidence = 96
      if (zoneInfo.inferred) confidence -= 1
      if (!datumInfo.explicit) confidence -= 3
      if (!(point.lat >= 34.5 && point.lat <= 43.2 && point.lng >= 24.5 && point.lng <= 46.5)) confidence -= 15
      const name = names[column] ?? `${nextPoint + column}.Nokta`
      candidates.push({
        id: `ruhsat-${nextPoint + column}-${easting}-${northing}`,
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
          'Sütun bazında ruhsat tablosu eşleştirildi',
          'Sağa (Y) = Easting',
          'Yukarı (X) = Northing',
          zoneInfo.evidence,
          datumInfo.evidence,
        ],
        zone: zoneInfo.zone,
        hemisphere: 'N',
        datum: datumInfo.datum,
        correctedOrder: false,
      })
    }
    nextPoint += count
    i = xIndex
  }

  return {
    candidates,
    zone: zoneInfo.zone,
    datum: datumInfo.datum,
    evidence: [zoneInfo.evidence, datumInfo.evidence],
  }
}

async function prepareImage(file: File) {
  const bitmap = await createImageBitmap(file)
  const scale = Math.min(1.8, Math.sqrt(MAX_OCR_PIXELS / Math.max(1, bitmap.width * bitmap.height)))
  const canvas = document.createElement('canvas')
  canvas.width = Math.round(bitmap.width * scale)
  canvas.height = Math.round(bitmap.height * scale)
  const context = canvas.getContext('2d', { willReadFrequently: true })
  if (!context) return file
  context.drawImage(bitmap, 0, 0, canvas.width, canvas.height)
  bitmap.close()
  const data = context.getImageData(0, 0, canvas.width, canvas.height)
  for (let i = 0; i < data.data.length; i += 4) {
    const gray = data.data[i] * .299 + data.data[i + 1] * .587 + data.data[i + 2] * .114
    const value = Math.max(0, Math.min(255, (gray - 126) * 1.55 + 126))
    data.data[i] = value
    data.data[i + 1] = value
    data.data[i + 2] = value
  }
  context.putImageData(data, 0, 0)
  return canvas
}

async function scanImage(file: File, options: DocumentCoordinateOptions, onProgress: ProgressHandler): Promise<DocumentScanResult> {
  const { createWorker, PSM } = await import('tesseract.js')
  const worker = await createWorker('eng', 1, {
    logger: (message) => {
      if (message.status !== 'recognizing text') return
      onProgress({ percent: Math.min(97, Math.round(8 + message.progress * 88)), label: `Ruhsat tablosu okunuyor · %${Math.round(message.progress * 100)}` })
    },
  })
  await worker.setParameters({ tessedit_pageseg_mode: PSM.AUTO, preserve_interword_spaces: '1' })
  const image = await prepareImage(file)
  try {
    const result = await worker.recognize(image)
    const text = result.data.text
    const table = parseRuhsatTable(text, options)
    if (table.candidates.length >= 3) {
      const high = table.candidates.filter((candidate) => candidate.confidenceLevel === 'high').length
      const medium = table.candidates.filter((candidate) => candidate.confidenceLevel === 'medium').length
      const low = table.candidates.filter((candidate) => candidate.confidenceLevel === 'low').length
      return {
        fileName: file.name,
        pageCount: 1,
        usedOcr: true,
        candidates: table.candidates,
        detection: { zone: table.zone, hemisphere: 'N', datum: table.datum, evidence: table.evidence },
        stats: { high, medium, low, duplicatesRemoved: 0, tableRows: table.candidates.length },
        warning: `${table.candidates.length} koordinat Sağa(Y)/Yukarı(X) ruhsat tablosundan sütun bazında eşleştirildi.`,
      }
    }

    const generic = extractCoordinatesFromText(text, 'Görsel', 'OCR', options)
    if (generic.length) {
      const high = generic.filter((candidate) => candidate.confidenceLevel === 'high').length
      const medium = generic.filter((candidate) => candidate.confidenceLevel === 'medium').length
      const low = generic.filter((candidate) => candidate.confidenceLevel === 'low').length
      return {
        fileName: file.name,
        pageCount: 1,
        usedOcr: true,
        candidates: generic,
        detection: { zone: options.zone, hemisphere: options.hemisphere, datum: options.datum, evidence: [] },
        stats: { high, medium, low, duplicatesRemoved: 0, tableRows: 0 },
        warning: 'Ruhsat tablosu tam eşleşmedi; genel koordinat analizi kullanıldı.',
      }
    }
  } finally {
    await worker.terminate()
    if (image instanceof HTMLCanvasElement) { image.width = 1; image.height = 1 }
  }

  return scanCoordinateDocumentV3(file, options, onProgress)
}

export async function scanCoordinateDocumentV31(file: File, options: DocumentCoordinateOptions, onProgress: ProgressHandler) {
  if (file.type.startsWith('image/')) {
    const result = await scanImage(file, options, onProgress)
    onProgress({ percent: 100, label: `${result.candidates.length} koordinat analiz edildi` })
    return result
  }
  return scanCoordinateDocumentV3(file, options, onProgress)
}
