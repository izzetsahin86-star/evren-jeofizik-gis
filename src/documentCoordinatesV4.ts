import { fromUtm } from './geo'
import { extractCoordinatesFromText, type DocumentCoordinateCandidate, type DocumentCoordinateConfidence, type DocumentCoordinateOptions, type DocumentScanProgress, type DocumentScanResult } from './documentCoordinates'
import { scanCoordinateDocumentV3 } from './documentCoordinatesV3'

type ProgressHandler = (progress: DocumentScanProgress) => void
type Axis = 'east' | 'north'
type TableCandidate = DocumentCoordinateCandidate & { order: number }

const MAX_FILE_BYTES = 30 * 1024 * 1024
const MAX_OCR_PIXELS = 10_000_000
const METRIC = /\b0?\d{6,7}\b/g

function fold(value: string) {
  return value.toLocaleUpperCase('tr-TR').replace(/İ/g, 'I').replace(/Ş/g, 'S').replace(/Ğ/g, 'G').replace(/Ü/g, 'U').replace(/Ö/g, 'O').replace(/Ç/g, 'C').normalize('NFD').replace(/[\u0300-\u036f]/g, '')
}

function normalize(text: string) {
  return text.replace(/\u00a0/g, ' ').replace(/[−–—]/g, '-').replace(/(?<=\d)[OoQ](?=\d)/g, '0').replace(/(?<=\d)[Il|](?=\d)/g, '1').replace(/(?<=\d)S(?=\d)/g, '5').replace(/[ \t]+/g, ' ').replace(/\r/g, '')
}

function level(value: number): DocumentCoordinateConfidence {
  if (value >= 85) return 'high'
  if (value >= 65) return 'medium'
  return 'low'
}

function metrics(line: string) {
  return Array.from(line.matchAll(METRIC), (match) => Number(match[0])).filter((value) => value >= 100_000 && value <= 9_999_999)
}

function eastValues(line: string) {
  return metrics(line).filter((value) => value >= 100_000 && value <= 900_000)
}

function northValues(line: string) {
  return metrics(line).filter((value) => value >= 1_000_000 && value <= 9_999_999)
}

function axisOf(line: string): Axis | null {
  const text = fold(line)
  if (/\b(?:SAGA|EASTING|DOGU)\b/.test(text)) return 'east'
  if (/\b(?:YUKARI|NORTHING|KUZEY)\b/.test(text)) return 'north'
  if (/\(\s*Y\s*\)/i.test(line) && metrics(line).length) return 'east'
  if (/\(\s*X\s*\)/i.test(line) && metrics(line).length) return 'north'
  return null
}

function detectContext(text: string, options: DocumentCoordinateOptions) {
  const folded = fold(text)
  const zoneMatch = text.match(/\b(?:UTM\s*)?(?:ZONE|ZON|D[İI]L[İI]M)\s*[:=-]?\s*([1-5]?\d|60)\s*([NS])?\b/i)
  const explicitZone = zoneMatch ? Number(zoneMatch[1]) : undefined
  const province = /\bDENIZLI\b/.test(folded) || /\bBULDAN\b/.test(folded) ? 'DENIZLI' : undefined
  const zone = explicitZone ?? (province ? 35 : options.zone)
  const hemisphere: 'N' | 'S' = zoneMatch?.[2]?.toUpperCase() === 'S' ? 'S' : 'N'
  const datum = /\bED\s*[- ]?50\b/i.test(text) ? 'ED50' : /\bWGS\s*[- ]?84\b/i.test(text) ? 'WGS84' : options.datum
  const evidence: string[] = []
  if (explicitZone) evidence.push(`Zone ${zone}${hemisphere} belgeden algılandı`)
  else if (province) evidence.push(`İl DENIZLI → UTM Zone 35N tahmini`)
  else evidence.push(`Zone belgede bulunamadı; varsayılan Zone ${zone} kullanıldı`)
  if (/\b(?:ED\s*[- ]?50|WGS\s*[- ]?84)\b/i.test(text)) evidence.push(`${datum} datum belgeden algılandı`)
  else evidence.push(`Datum belgede bulunamadı; seçili ${datum} kullanıldı`)
  return { zone, hemisphere, datum, province, evidence }
}

function safeUtm(easting: number, northing: number, zone: number, hemisphere: 'N' | 'S', datum: string) {
  try {
    const point = fromUtm(easting, northing, zone, hemisphere, datum)
    if (!Number.isFinite(point.lat) || !Number.isFinite(point.lng)) return null
    return point
  } catch { return null }
}

function collect(lines: string[], start: number, axis: Axis) {
  const values: number[] = []
  let end = start
  for (let index = start; index < Math.min(lines.length, start + 4); index += 1) {
    if (index > start && axisOf(lines[index])) break
    const part = axis === 'east' ? eastValues(lines[index]) : northValues(lines[index])
    if (!part.length && index > start) break
    values.push(...part)
    end = index
  }
  return { values, end }
}

function namesBefore(lines: string[], row: number, count: number, first: number) {
  for (let offset = 1; offset <= 6; offset += 1) {
    const line = lines[row - offset]
    if (!line) continue
    const found = Array.from(line.matchAll(/\b(\d{1,3})\s*[.]?\s*(?:NOKTA|POINT)\b/gi), (match) => `${Number(match[1])}.Nokta`)
    if (found.length >= 2) return Array.from({ length: count }, (_, index) => found[index] ?? `${first + index}.Nokta`)
  }
  return Array.from({ length: count }, (_, index) => `${first + index}.Nokta`)
}

function tableFromText(rawText: string, source: string, options: DocumentCoordinateOptions) {
  const text = normalize(rawText)
  const lines = text.split('\n').map((line) => line.trim()).filter(Boolean)
  const context = detectContext(text, options)
  const result: TableCandidate[] = []
  const signatures = new Set<string>()
  let next = 1

  const addPair = (east: number[], north: number[], row: number, inferred: boolean) => {
    const count = Math.min(east.length, north.length)
    if (count < 2) return
    const signature = `${east.slice(0, count).join(',')}|${north.slice(0, count).join(',')}`
    if (signatures.has(signature)) return
    signatures.add(signature)
    const names = namesBefore(lines, row, count, next)
    for (let index = 0; index < count; index += 1) {
      const point = safeUtm(east[index], north[index], context.zone, context.hemisphere, context.datum)
      if (!point) continue
      let confidence = inferred ? 86 : 95
      if (!context.province && !/Zone \d+/.test(context.evidence[0] ?? '')) confidence -= 12
      confidence -= /belgede bulunamadı/.test(context.evidence[1] ?? '') ? 3 : 0
      const inTurkey = point.lat >= 34.5 && point.lat <= 43.2 && point.lng >= 24.5 && point.lng <= 46.5
      confidence += inTurkey ? 3 : -14
      confidence = Math.max(10, Math.min(99, confidence))
      const name = names[index] ?? `${next + index}.Nokta`
      result.push({ id: `v4-${next + index}-${east[index]}-${north[index]}`, lat: point.lat, lng: point.lng, format: 'UTM', raw: `${name} · Sağa(Y) ${String(east[index]).padStart(7, '0')} · Yukarı(X) ${north[index]}`, source: `${source} · ruhsat tablosu`, sourceKind: 'OCR', name, group: 'Ruhsat Koordinatları', confidence, confidenceLevel: level(confidence), reasons: [inferred ? 'Tablo sayı yapısından eşleştirildi' : 'Sağa(Y)/Yukarı(X) sütunu eşleştirildi', 'Sağa(Y) = Easting', 'Yukarı(X) = Northing'], zone: context.zone, hemisphere: context.hemisphere, datum: context.datum, correctedOrder: false, order: next + index })
    }
    next += count
  }

  for (let row = 0; row < lines.length; row += 1) {
    if (axisOf(lines[row]) !== 'east') continue
    const east = collect(lines, row, 'east')
    if (east.values.length < 2) continue
    let northRow = -1
    for (let probe = east.end + 1; probe < Math.min(lines.length, east.end + 9); probe += 1) {
      if (axisOf(lines[probe]) === 'north') { northRow = probe; break }
    }
    if (northRow < 0) continue
    const north = collect(lines, northRow, 'north')
    addPair(east.values, north.values, row, false)
    row = north.end
  }

  for (let row = 0; row < lines.length - 1; row += 1) {
    const east = eastValues(lines[row])
    if (east.length < 4) continue
    for (let probe = row + 1; probe < Math.min(lines.length, row + 4); probe += 1) {
      const north = northValues(lines[probe])
      if (north.length < 4) continue
      if (Math.abs(east.length - north.length) > 2) continue
      addPair(east, north, row, true)
      break
    }
  }

  const unique = new Map<string, TableCandidate>()
  for (const candidate of result) {
    const key = `${candidate.lat.toFixed(7)}:${candidate.lng.toFixed(7)}`
    const old = unique.get(key)
    if (!old || candidate.confidence > old.confidence) unique.set(key, candidate)
  }
  const candidates = Array.from(unique.values()).sort((a, b) => a.order - b.order)
  if (candidates.length >= 3) context.evidence.push(`${candidates.length} ruhsat koordinatı sütun bazında eşleştirildi`)
  return { candidates, detection: { zone: context.zone, hemisphere: context.hemisphere, datum: context.datum, evidence: Array.from(new Set(context.evidence)) } }
}

function merge(generic: DocumentCoordinateCandidate[], table: TableCandidate[]) {
  const filtered = table.length >= 3 ? generic.filter((candidate) => candidate.format !== 'UTM' || metrics(candidate.raw).length < 3) : generic
  const map = new Map<string, DocumentCoordinateCandidate & { order?: number }>()
  filtered.forEach((candidate) => map.set(`${candidate.lat.toFixed(7)}:${candidate.lng.toFixed(7)}`, candidate))
  table.forEach(({ order, ...candidate }) => map.set(`${candidate.lat.toFixed(7)}:${candidate.lng.toFixed(7)}`, { ...candidate, order }))
  return Array.from(map.values()).sort((a, b) => (a.order ?? 99999) - (b.order ?? 99999)).map(({ order, ...candidate }, index) => {
    void order
    return { ...candidate, id: `doc-v4-${index}-${candidate.lat.toFixed(6)}-${candidate.lng.toFixed(6)}` }
  })
}

async function preprocess(file: File) {
  const bitmap = await createImageBitmap(file)
  const scale = Math.min(2.1, Math.sqrt(MAX_OCR_PIXELS / Math.max(1, bitmap.width * bitmap.height)))
  const canvas = document.createElement('canvas')
  canvas.width = Math.round(bitmap.width * scale)
  canvas.height = Math.round(bitmap.height * scale)
  const context = canvas.getContext('2d', { willReadFrequently: true })!
  context.drawImage(bitmap, 0, 0, canvas.width, canvas.height)
  bitmap.close()
  const image = context.getImageData(0, 0, canvas.width, canvas.height)
  for (let index = 0; index < image.data.length; index += 4) {
    const gray = image.data[index] * .299 + image.data[index + 1] * .587 + image.data[index + 2] * .114
    const value = Math.max(0, Math.min(255, (gray - 124) * 1.72 + 124))
    image.data[index] = value; image.data[index + 1] = value; image.data[index + 2] = value
  }
  context.putImageData(image, 0, 0)
  return canvas
}

export async function scanCoordinateDocumentV4(file: File, options: DocumentCoordinateOptions, onProgress: ProgressHandler): Promise<DocumentScanResult> {
  if (file.size > MAX_FILE_BYTES) throw new Error('Belge en fazla 30 MB olabilir.')
  if (!file.type.startsWith('image/')) return scanCoordinateDocumentV3(file, options, onProgress)

  onProgress({ percent: 4, label: 'Görsel ruhsat hazırlanıyor…' })
  const canvas = await preprocess(file)
  const { createWorker, PSM } = await import('tesseract.js')
  const worker = await createWorker('eng', 1, { logger: (message) => { if (message.status === 'recognizing text') onProgress({ percent: Math.min(96, 10 + Math.round(message.progress * 82)), label: `Ruhsat tablosu okunuyor · %${Math.round(message.progress * 100)}` }) } })
  try {
    await worker.setParameters({ tessedit_pageseg_mode: PSM.AUTO, preserve_interword_spaces: '1' })
    const first = await worker.recognize(canvas)
    let text = first.data.text
    let table = tableFromText(text, 'Görsel', options)
    if (table.candidates.length < 3) {
      await worker.setParameters({ tessedit_pageseg_mode: PSM.SPARSE_TEXT, preserve_interword_spaces: '1' })
      const second = await worker.recognize(canvas)
      const alternative = tableFromText(second.data.text, 'Görsel', options)
      if (alternative.candidates.length > table.candidates.length) { text = second.data.text; table = alternative }
    }
    const generic = extractCoordinatesFromText(text, 'Görsel', 'OCR', options)
    const candidates = merge(generic, table.candidates)
    const result: DocumentScanResult = { fileName: file.name, pageCount: 1, usedOcr: true, candidates, detection: table.candidates.length >= 3 ? table.detection : { zone: options.zone, hemisphere: options.hemisphere, datum: options.datum, evidence: [] }, stats: { high: candidates.filter((item) => item.confidenceLevel === 'high').length, medium: candidates.filter((item) => item.confidenceLevel === 'medium').length, low: candidates.filter((item) => item.confidenceLevel === 'low').length, duplicatesRemoved: Math.max(0, generic.length + table.candidates.length - candidates.length), tableRows: table.candidates.length }, warning: table.candidates.length >= 3 ? undefined : 'Ruhsat tablosu tam eşleşmedi; genel koordinat analizi kullanıldı.' }
    onProgress({ percent: 100, label: `${result.candidates.length} koordinat analiz edildi` })
    return result
  } finally {
    await worker.terminate(); canvas.width = 1; canvas.height = 1
  }
}
