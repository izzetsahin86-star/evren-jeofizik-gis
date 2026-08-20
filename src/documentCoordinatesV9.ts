import { fromUtm } from './geo'
import {
  type DocumentCoordinateCandidate,
  type DocumentCoordinateConfidence,
  type DocumentCoordinateOptions,
  type DocumentScanProgress,
  type DocumentScanResult,
} from './documentCoordinates'
import { scanCoordinateDocumentV8 } from './documentCoordinatesV8'

type ProgressHandler = (progress: DocumentScanProgress) => void
type Line = { y: number; start: number; end: number }
type TableGrid = { lines: [number, number, number, number]; separators: number[] }
type Context = { zone: number; hemisphere: 'N' | 'S'; datum: string; evidence: string[] }
type Kind = 'east' | 'north'
type VoteMap = Map<number, number>
type CellRead = { votes: VoteMap; texts: string[] }
type CellPair = { point: number; table: number; column: number; east: CellRead; north: CellRead }

const MAX_FILE_BYTES = 30 * 1024 * 1024
const DARK = 182

function fold(value: string) {
  return value.toLocaleUpperCase('tr-TR')
    .replace(/İ/g, 'I').replace(/Ş/g, 'S').replace(/Ğ/g, 'G')
    .replace(/Ü/g, 'U').replace(/Ö/g, 'O').replace(/Ç/g, 'C')
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
}

function level(value: number): DocumentCoordinateConfidence {
  if (value >= 85) return 'high'
  if (value >= 65) return 'medium'
  return 'low'
}

function median(values: number[]) {
  if (!values.length) return 0
  const sorted = [...values].sort((a, b) => a - b)
  const i = Math.floor(sorted.length / 2)
  return sorted.length % 2 ? sorted[i] : (sorted[i - 1] + sorted[i]) / 2
}

function grayAt(data: Uint8ClampedArray, width: number, x: number, y: number) {
  const i = (y * width + x) * 4
  return data[i] * .299 + data[i + 1] * .587 + data[i + 2] * .114
}

function longestDarkRow(data: Uint8ClampedArray, width: number, y: number, x0: number, x1: number) {
  let best = 0, bestStart = x0, bestEnd = x0, run = 0, runStart = x0
  for (let x = x0; x <= x1; x += 1) {
    if (grayAt(data, width, x, y) < DARK) {
      if (!run) runStart = x
      run += 1
      if (run > best) { best = run; bestStart = runStart; bestEnd = x }
    } else run = 0
  }
  return { length: best, start: bestStart, end: bestEnd }
}

function clusterNumbers(values: number[], maxGap = 2) {
  const groups: number[][] = []
  for (const value of values) {
    const last = groups.at(-1)
    if (!last || value - last.at(-1)! > maxGap) groups.push([value])
    else last.push(value)
  }
  return groups.map((group) => Math.round(group.reduce((sum, value) => sum + value, 0) / group.length))
}

function detectHorizontalLines(image: ImageData) {
  const { data, width, height } = image
  const x0 = Math.round(width * .07)
  const x1 = Math.round(width * .93)
  const y0 = Math.round(height * .28)
  const y1 = Math.round(height * .84)
  const rows: Line[] = []
  for (let y = y0; y <= y1; y += 1) {
    const run = longestDarkRow(data, width, y, x0, x1)
    if (run.length >= width * .44) rows.push({ y, start: run.start, end: run.end })
  }
  const clusters: Line[][] = []
  for (const row of rows) {
    const last = clusters.at(-1)
    if (!last || row.y - last.at(-1)!.y > 2) clusters.push([row])
    else last.push(row)
  }
  return clusters.map((cluster) => ({
    y: Math.round(median(cluster.map((row) => row.y))),
    start: Math.round(median(cluster.map((row) => row.start))),
    end: Math.round(median(cluster.map((row) => row.end))),
  }))
}

function longestDarkColumn(image: ImageData, x: number, y0: number, y1: number) {
  let best = 0, run = 0
  for (let y = y0; y <= y1; y += 1) {
    if (grayAt(image.data, image.width, x, y) < DARK) {
      run += 1
      if (run > best) best = run
    } else run = 0
  }
  return best
}

function repairRegularGrid(raw: number[]) {
  if (raw.length < 4) return raw
  const sorted = [...raw].sort((a, b) => a - b)
  const gaps = sorted.slice(1).map((value, index) => value - sorted[index])
  // İlk hücre başlık sütunudur ve genellikle daha geniştir; veri sütunu adımı sonraki aralıklardan bulunur.
  const dataGaps = gaps.slice(1).filter((gap) => gap >= 24)
  const typical = median(dataGaps.length ? dataGaps : gaps)
  if (!typical) return sorted

  const repaired = [sorted[0]]
  for (let i = 1; i < sorted.length; i += 1) {
    const previous = repaired.at(-1)!
    const current = sorted[i]
    const gap = current - previous
    if (i >= 2 && gap > typical * 1.65) {
      const pieces = Math.max(2, Math.round(gap / typical))
      if (pieces <= 4 && Math.abs(gap / pieces - typical) <= typical * .28) {
        for (let part = 1; part < pieces; part += 1) repaired.push(Math.round(previous + gap * (part / pieces)))
      }
    }
    repaired.push(current)
  }
  return repaired
}

function separatorsFor(image: ImageData, lines: Line[]) {
  const first = lines[0], last = lines[3]
  const x0 = Math.max(0, Math.round(median(lines.map((line) => line.start))) - 4)
  const x1 = Math.min(image.width - 1, Math.round(median(lines.map((line) => line.end))) + 4)
  const height = Math.max(1, last.y - first.y)
  const xs: number[] = []
  for (let x = x0; x <= x1; x += 1) {
    // Metin dikey çizgilerini ayıklamak için çizginin tablo yüksekliğinin çoğunda kesintisiz olması gerekir.
    if (longestDarkColumn(image, x, first.y, last.y) >= height * .72) xs.push(x)
  }
  const clustered = clusterNumbers(xs, 2)
  const cleaned: number[] = []
  for (const x of clustered) {
    if (!cleaned.length || x - cleaned.at(-1)! >= Math.max(20, image.width * .013)) cleaned.push(x)
  }
  return repairRegularGrid(cleaned)
}

function detectTables(image: ImageData) {
  const horizontal = detectHorizontalLines(image)
  const tables: TableGrid[] = []
  for (let i = 0; i <= horizontal.length - 4; i += 1) {
    const group = horizontal.slice(i, i + 4)
    const gaps = [group[1].y - group[0].y, group[2].y - group[1].y, group[3].y - group[2].y]
    const minGap = Math.max(7, image.height * .006)
    const maxGap = Math.max(72, image.height * .052)
    if (gaps.some((gap) => gap < minGap || gap > maxGap)) continue
    if (Math.max(...gaps) / Math.max(1, Math.min(...gaps)) > 2.7) continue
    const separators = separatorsFor(image, group)
    if (separators.length < 5 || separators.length > 30) continue
    const dataColumns = separators.length - 2
    if (dataColumns < 3 || dataColumns > 25) continue
    tables.push({ lines: [group[0].y, group[1].y, group[2].y, group[3].y], separators })
    i += 3
  }
  return tables.sort((a, b) => a.lines[0] - b.lines[0])
}

function detectContext(text: string, options: DocumentCoordinateOptions): Context {
  const value = fold(text)
  const zoneMatch = value.match(/\b(?:UTM\s*)?(?:ZONE|ZON|DILIM)\s*[:=\-]?\s*([1-5]?\d|60)\s*([NS])?\b/)
  let zone = zoneMatch ? Number(zoneMatch[1]) : options.zone
  let hemisphere: 'N' | 'S' = zoneMatch?.[2] === 'S' ? 'S' : 'N'
  const evidence: string[] = []
  if (zoneMatch) evidence.push(`Zone ${zone}${hemisphere} belgeden algılandı`)
  else if (/\bDENIZLI\b|\bBULDAN\b/.test(value)) {
    zone = 35; hemisphere = 'N'; evidence.push('İl DENIZLI → UTM Zone 35N tahmini')
  } else evidence.push(`Zone belgede bulunamadı; varsayılan Zone ${zone} kullanıldı`)

  let datum = options.datum
  if (/\bED\s*[- ]?50\b|EUROPEAN\s+DATUM\s+1950/.test(value)) {
    datum = 'ED50'; evidence.push('ED50 datum belgeden algılandı')
  } else if (/\bWGS\s*[- ]?84\b|ITRF\d*|TUREF|ETRS\d*/.test(value)) {
    datum = 'WGS84'; evidence.push('WGS84/modern datum belgeden algılandı')
  } else evidence.push(`Datum belgede bulunamadı; seçili ${datum} kullanıldı`)
  return { zone, hemisphere, datum, evidence }
}

async function sourceCanvas(file: File) {
  const bitmap = await createImageBitmap(file)
  // Tam ruhsatta tablo küçülmesin: 4200 px'e kadar kaynak çözünürlüğünü koru/yükselt.
  const targetLongEdge = Math.min(4200, Math.max(3000, Math.max(bitmap.width, bitmap.height)))
  const scale = Math.min(2.1, targetLongEdge / Math.max(bitmap.width, bitmap.height))
  const canvas = document.createElement('canvas')
  canvas.width = Math.max(1, Math.round(bitmap.width * scale))
  canvas.height = Math.max(1, Math.round(bitmap.height * scale))
  const context = canvas.getContext('2d', { willReadFrequently: true })!
  context.fillStyle = '#fff'; context.fillRect(0, 0, canvas.width, canvas.height)
  context.imageSmoothingEnabled = true
  context.drawImage(bitmap, 0, 0, canvas.width, canvas.height)
  bitmap.close()
  return canvas
}

function cellCanvas(source: HTMLCanvasElement, x0: number, x1: number, y0: number, y1: number, threshold: number | null, insetScale: number) {
  const insetX = Math.max(2, Math.round((x1 - x0) * insetScale))
  const insetY = Math.max(2, Math.round((y1 - y0) * .08))
  const sx = Math.max(0, x0 + insetX)
  const sy = Math.max(0, y0 + insetY)
  const sw = Math.max(2, x1 - x0 - insetX * 2)
  const sh = Math.max(2, y1 - y0 - insetY * 2)
  const scale = Math.max(5, Math.min(9, 760 / sw))
  const canvas = document.createElement('canvas')
  canvas.width = Math.max(1, Math.round(sw * scale))
  canvas.height = Math.max(1, Math.round(sh * scale))
  const context = canvas.getContext('2d', { willReadFrequently: true })!
  context.fillStyle = '#fff'; context.fillRect(0, 0, canvas.width, canvas.height)
  context.imageSmoothingEnabled = true
  context.drawImage(source, sx, sy, sw, sh, 0, 0, canvas.width, canvas.height)
  if (threshold !== null) {
    const image = context.getImageData(0, 0, canvas.width, canvas.height)
    for (let i = 0; i < image.data.length; i += 4) {
      const gray = image.data[i] * .299 + image.data[i + 1] * .587 + image.data[i + 2] * .114
      const value = gray < threshold ? 0 : 255
      image.data[i] = value; image.data[i + 1] = value; image.data[i + 2] = value; image.data[i + 3] = 255
    }
    context.putImageData(image, 0, 0)
  }
  return canvas
}

function numericAlternatives(text: string, kind: Kind) {
  const digits = text.replace(/[OoQ]/g, '0').replace(/[Il|!]/g, '1').replace(/[Ss]/g, '5').replace(/[Bb]/g, '8').replace(/[^0-9]/g, '')
  const result = new Set<number>()
  const add = (token: string) => {
    if (!token) return
    const value = Number(token)
    if (kind === 'east' && value >= 100_000 && value <= 900_000) result.add(value)
    if (kind === 'north' && value >= 3_500_000 && value <= 5_200_000) result.add(value)
  }
  add(digits)
  const lengths = kind === 'east' ? [6, 7] : [7]
  for (const length of lengths) {
    for (let start = 0; start + length <= digits.length; start += 1) add(digits.slice(start, start + length))
  }
  return [...result]
}

function addVotes(map: VoteMap, values: number[]) {
  for (const value of values) map.set(value, (map.get(value) ?? 0) + 1)
}

async function readCellVotes(
  worker: Awaited<ReturnType<typeof import('tesseract.js')['createWorker']>>,
  source: HTMLCanvasElement,
  x0: number, x1: number, y0: number, y1: number,
  kind: Kind,
) {
  const votes: VoteMap = new Map()
  const texts: string[] = []
  const variants = [
    { threshold: null as number | null, inset: .025 },
    { threshold: 175, inset: .025 },
    { threshold: 195, inset: .035 },
    { threshold: 215, inset: .045 },
    { threshold: 230, inset: .025 },
  ]
  for (const variant of variants) {
    const crop = cellCanvas(source, x0, x1, y0, y1, variant.threshold, variant.inset)
    try {
      const result = await worker.recognize(crop)
      const text = result.data.text ?? ''
      texts.push(text.trim())
      addVotes(votes, numericAlternatives(text, kind))
      const bestVotes = Math.max(0, ...votes.values())
      if (bestVotes >= 3) break
    } finally { crop.width = 1; crop.height = 1 }
  }
  return { votes, texts }
}

function topCandidate(read: CellRead) {
  return [...read.votes.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? null
}

function robustCenter(values: number[]) {
  if (!values.length) return 0
  return median(values)
}

function chooseConsistent(read: CellRead, kind: Kind, center: number) {
  const entries = [...read.votes.entries()]
  if (!entries.length) return null
  const limit = kind === 'east' ? 90_000 : 180_000
  const scored = entries.map(([value, votes]) => ({ value, votes, distance: center ? Math.abs(value - center) : 0 }))
  const inliers = center ? scored.filter((item) => item.distance <= limit) : scored
  const pool = inliers.length ? inliers : scored
  pool.sort((a, b) => b.votes - a.votes || a.distance - b.distance)
  return pool[0]?.value ?? null
}

function safeUtm(easting: number, northing: number, context: Context) {
  try {
    const point = fromUtm(easting, northing, context.zone, context.hemisphere, context.datum)
    if (!Number.isFinite(point.lat) || !Number.isFinite(point.lng)) return null
    return point
  } catch { return null }
}

export async function scanCoordinateDocumentV9(file: File, options: DocumentCoordinateOptions, onProgress: ProgressHandler): Promise<DocumentScanResult> {
  if (file.size > MAX_FILE_BYTES) throw new Error('Belge en fazla 30 MB olabilir.')
  if (!file.type.startsWith('image/')) return scanCoordinateDocumentV8(file, options, onProgress)

  onProgress({ percent: 2, label: 'Ruhsat ızgarası ve eksik sütunlar analiz ediliyor…' })
  const canvas = await sourceCanvas(file)
  const image = canvas.getContext('2d', { willReadFrequently: true })!.getImageData(0, 0, canvas.width, canvas.height)
  const tables = detectTables(image)
  if (!tables.length) { canvas.width = 1; canvas.height = 1; return scanCoordinateDocumentV8(file, options, onProgress) }

  const expected = tables.reduce((sum, table) => sum + Math.max(0, table.separators.length - 2), 0)
  onProgress({ percent: 5, label: `${tables.length} tablo · ${expected} gerçek koordinat sütunu bulundu` })

  const { createWorker, PSM } = await import('tesseract.js')
  const worker = await createWorker('eng', 1)
  try {
    await worker.setParameters({ tessedit_pageseg_mode: PSM.SPARSE_TEXT, preserve_interword_spaces: '1' })
    const page = await worker.recognize(canvas)
    const context = detectContext(page.data.text ?? '', options)

    await worker.setParameters({
      tessedit_pageseg_mode: PSM.SINGLE_LINE,
      tessedit_char_whitelist: '0123456789',
      classify_bln_numeric_mode: '1',
      preserve_interword_spaces: '0',
    })

    const reads: CellPair[] = []
    let pointBase = 0
    let processed = 0
    const totalCells = Math.max(1, expected * 2)

    for (let tableIndex = 0; tableIndex < tables.length; tableIndex += 1) {
      const table = tables[tableIndex]
      const [, headerBottom, eastBottom, northBottom] = table.lines
      const separators = table.separators
      const columns = Math.max(0, separators.length - 2)
      for (let column = 1; column <= columns; column += 1) {
        const x0 = separators[column]
        const x1 = separators[column + 1]
        const east = await readCellVotes(worker, canvas, x0, x1, headerBottom, eastBottom, 'east')
        processed += 1
        onProgress({ percent: 8 + Math.round(processed / totalCells * 78), label: `Hücreler çoklu OCR ile okunuyor · ${processed}/${totalCells}` })
        const north = await readCellVotes(worker, canvas, x0, x1, eastBottom, northBottom, 'north')
        processed += 1
        onProgress({ percent: 8 + Math.round(processed / totalCells * 78), label: `Hücreler çoklu OCR ile okunuyor · ${processed}/${totalCells}` })
        reads.push({ point: pointBase + column, table: tableIndex, column, east, north })
      }
      pointBase += columns
    }

    const initialEast = reads.map((item) => topCandidate(item.east)).filter((value): value is number => value !== null)
    const initialNorth = reads.map((item) => topCandidate(item.north)).filter((value): value is number => value !== null)
    const eastCenter = robustCenter(initialEast)
    const northCenter = robustCenter(initialNorth)

    const candidates: DocumentCoordinateCandidate[] = []
    const unresolved: number[] = []
    for (const item of reads) {
      const easting = chooseConsistent(item.east, 'east', eastCenter)
      const northing = chooseConsistent(item.north, 'north', northCenter)
      if (easting === null || northing === null) { unresolved.push(item.point); continue }

      const eastOutlier = eastCenter > 0 && Math.abs(easting - eastCenter) > 90_000
      const northOutlier = northCenter > 0 && Math.abs(northing - northCenter) > 180_000
      if (eastOutlier || northOutlier) { unresolved.push(item.point); continue }

      const point = safeUtm(easting, northing, context)
      if (!point) { unresolved.push(item.point); continue }
      const inTurkey = point.lat >= 34.5 && point.lat <= 43.2 && point.lng >= 24.5 && point.lng <= 46.5
      const eastVotes = item.east.votes.get(easting) ?? 0
      const northVotes = item.north.votes.get(northing) ?? 0
      let confidence = 82 + Math.min(10, eastVotes * 2 + northVotes * 2)
      if (/tahmini/.test(context.evidence[0] ?? '')) confidence -= 1
      if (/Datum belgede bulunamadı/.test(context.evidence[1] ?? '')) confidence -= 3
      if (!inTurkey) confidence -= 20
      confidence = Math.max(10, Math.min(99, Math.round(confidence)))
      const name = `${item.point}.Nokta`
      candidates.push({
        id: `doc-v9-${item.point}-${easting}-${northing}`,
        lat: point.lat,
        lng: point.lng,
        format: 'UTM',
        raw: `${name} · Sağa(Y) ${String(easting).padStart(7, '0')} · Yukarı(X) ${northing}`,
        source: 'Görsel · çoklu OCR doğrulamalı ruhsat tablosu',
        sourceKind: 'OCR',
        name,
        group: 'Ruhsat Koordinatları',
        confidence,
        confidenceLevel: level(confidence),
        reasons: [
          'Nokta numarası gerçek tablo sütunundan korundu',
          'Hücre birden fazla görüntü yöntemiyle OCR edildi',
          'Aday değerler tablo içi koordinat kümesiyle doğrulandı',
          'Sağa(Y) = Easting', 'Yukarı(X) = Northing', ...context.evidence,
        ],
        zone: context.zone,
        hemisphere: context.hemisphere,
        datum: context.datum,
        correctedOrder: false,
      })
    }

    candidates.sort((a, b) => Number(a.name?.split('.')[0] ?? 0) - Number(b.name?.split('.')[0] ?? 0))
    if (candidates.length < 3) return scanCoordinateDocumentV8(file, options, onProgress)

    const evidence = [
      ...context.evidence,
      `${tables.length} tablo ve ${expected} koordinat sütunu düzenli ızgaradan algılandı`,
      `${candidates.length}/${expected} nokta çoklu OCR + mekânsal tutarlılıkla doğrulandı`,
    ]
    if (unresolved.length) evidence.push(`Kontrol gereken sütunlar: ${unresolved.map((value) => `${value}.Nokta`).join(', ')}`)

    const result: DocumentScanResult = {
      fileName: file.name,
      pageCount: 1,
      usedOcr: true,
      candidates,
      detection: { zone: context.zone, hemisphere: context.hemisphere, datum: context.datum, evidence },
      stats: {
        high: candidates.filter((item) => item.confidenceLevel === 'high').length,
        medium: candidates.filter((item) => item.confidenceLevel === 'medium').length,
        low: candidates.filter((item) => item.confidenceLevel === 'low').length,
        duplicatesRemoved: 0,
        tableRows: candidates.length,
      },
      warning: unresolved.length
        ? `${expected} sütunun ${candidates.length} tanesi güvenle doğrulandı. ${unresolved.map((value) => `${value}.Nokta`).join(', ')} OCR doğrulaması tamamlanamadı; yanlış koordinat eklenmedi.`
        : undefined,
    }
    onProgress({ percent: 100, label: `${candidates.length}/${expected} koordinat doğrulandı` })
    return result
  } finally {
    await worker.terminate()
    canvas.width = 1; canvas.height = 1
  }
}
