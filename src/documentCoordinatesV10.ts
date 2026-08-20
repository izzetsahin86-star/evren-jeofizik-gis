import { scanCoordinateDocumentV9 } from './documentCoordinatesV9'
import type { DocumentCoordinateOptions, DocumentScanProgress, DocumentScanResult } from './documentCoordinates'

type ProgressHandler = (progress: DocumentScanProgress) => void
type HLine = { y: number; start: number; end: number }
type Grid = { ys: [number, number, number, number]; xs: number[] }

const MAX_FILE_BYTES = 30 * 1024 * 1024
const DARK = 185

function gray(data: Uint8ClampedArray, width: number, x: number, y: number) {
  const i = (y * width + x) * 4
  return data[i] * .299 + data[i + 1] * .587 + data[i + 2] * .114
}

function median(values: number[]) {
  if (!values.length) return 0
  const sorted = [...values].sort((a, b) => a - b)
  const m = Math.floor(sorted.length / 2)
  return sorted.length % 2 ? sorted[m] : (sorted[m - 1] + sorted[m]) / 2
}

function cluster(values: number[], maxGap = 2) {
  const groups: number[][] = []
  for (const value of values) {
    const last = groups.at(-1)
    if (!last || value - last.at(-1)! > maxGap) groups.push([value])
    else last.push(value)
  }
  return groups.map((group) => Math.round(group.reduce((sum, value) => sum + value, 0) / group.length))
}

function longestDarkRow(image: ImageData, y: number, x0: number, x1: number) {
  let best = 0, run = 0, runStart = x0, bestStart = x0, bestEnd = x0
  for (let x = x0; x <= x1; x += 1) {
    if (gray(image.data, image.width, x, y) < DARK) {
      if (!run) runStart = x
      run += 1
      if (run > best) { best = run; bestStart = runStart; bestEnd = x }
    } else run = 0
  }
  return { length: best, start: bestStart, end: bestEnd }
}

function horizontalLines(image: ImageData) {
  const x0 = Math.round(image.width * .07)
  const x1 = Math.round(image.width * .93)
  const y0 = Math.round(image.height * .28)
  const y1 = Math.round(image.height * .84)
  const raw: HLine[] = []
  for (let y = y0; y <= y1; y += 1) {
    const run = longestDarkRow(image, y, x0, x1)
    if (run.length >= image.width * .42) raw.push({ y, start: run.start, end: run.end })
  }
  const groups: HLine[][] = []
  for (const line of raw) {
    const last = groups.at(-1)
    if (!last || line.y - last.at(-1)!.y > 2) groups.push([line])
    else last.push(line)
  }
  return groups.map((group) => ({
    y: Math.round(median(group.map((line) => line.y))),
    start: Math.round(median(group.map((line) => line.start))),
    end: Math.round(median(group.map((line) => line.end))),
  }))
}

function longestDarkColumn(image: ImageData, x: number, y0: number, y1: number) {
  let best = 0, run = 0
  for (let y = y0; y <= y1; y += 1) {
    if (gray(image.data, image.width, x, y) < DARK) {
      run += 1
      if (run > best) best = run
    } else run = 0
  }
  return best
}

function bestRegularSequence(candidates: number[]) {
  if (candidates.length < 5) return candidates
  let best: { score: number; values: number[] } | null = null

  for (let start = 0; start < candidates.length - 4; start += 1) {
    for (let end = start + 4; end < candidates.length; end += 1) {
      const values = candidates.slice(start, end + 1)
      const gaps = values.slice(1).map((value, index) => value - values[index])
      const plausible = gaps.filter((gap) => gap >= 24 && gap <= 260)
      if (plausible.length < 4) continue
      const typical = median(plausible.sort((a, b) => a - b).slice(0, Math.max(3, Math.ceil(plausible.length * .75))))
      if (typical < 24) continue

      let intervals = 0
      let error = 0
      let valid = true
      for (const gap of gaps) {
        const pieces = Math.max(1, Math.min(3, Math.round(gap / typical)))
        const step = gap / pieces
        const relative = Math.abs(step - typical) / typical
        if (relative > .24) { valid = false; break }
        intervals += pieces
        error += relative
      }
      if (!valid || intervals < 5 || intervals > 13) continue

      const span = values.at(-1)! - values[0]
      const centerPenalty = Math.abs((values[0] + values.at(-1)!) / 2 - 750) / 750
      const score = intervals * 100 + span * .03 - error * 90 - centerPenalty * 4
      if (!best || score > best.score) best = { score, values }
    }
  }
  return best?.values ?? candidates
}

function repairSequence(values: number[]) {
  if (values.length < 4) return values
  const gaps = values.slice(1).map((value, index) => value - values[index])
  const typical = median(gaps.filter((gap) => gap >= 24 && gap <= 220))
  if (!typical) return values
  const repaired = [values[0]]
  for (let i = 1; i < values.length; i += 1) {
    const previous = repaired.at(-1)!
    const current = values[i]
    const gap = current - previous
    const pieces = Math.max(1, Math.min(3, Math.round(gap / typical)))
    if (pieces > 1 && Math.abs(gap / pieces - typical) <= typical * .24) {
      for (let part = 1; part < pieces; part += 1) repaired.push(Math.round(previous + gap * part / pieces))
    }
    repaired.push(current)
  }
  return repaired
}

function verticalGrid(image: ImageData, ys: [number, number, number, number]) {
  const [top, , , bottom] = ys
  const height = Math.max(1, bottom - top)
  const raw: number[] = []
  const x0 = Math.round(image.width * .07)
  const x1 = Math.round(image.width * .93)
  for (let x = x0; x <= x1; x += 1) {
    if (longestDarkColumn(image, x, top, bottom) >= height * .70) raw.push(x)
  }
  const clustered = cluster(raw, 2)
  const cleaned: number[] = []
  for (const x of clustered) {
    if (!cleaned.length || x - cleaned.at(-1)! >= Math.max(18, image.width * .011)) cleaned.push(x)
  }
  return repairSequence(bestRegularSequence(cleaned))
}

function detectGrids(image: ImageData) {
  const lines = horizontalLines(image)
  const grids: Grid[] = []
  for (let i = 0; i <= lines.length - 4; i += 1) {
    const group = lines.slice(i, i + 4)
    const gaps = [group[1].y - group[0].y, group[2].y - group[1].y, group[3].y - group[2].y]
    if (gaps.some((gap) => gap < 8 || gap > Math.max(80, image.height * .055))) continue
    if (Math.max(...gaps) / Math.max(1, Math.min(...gaps)) > 2.5) continue
    const ys: [number, number, number, number] = [group[0].y, group[1].y, group[2].y, group[3].y]
    const xs = verticalGrid(image, ys)
    // Bir başlık sütunu + en az 3 koordinat sütunu.
    if (xs.length >= 5 && xs.length <= 16) {
      grids.push({ ys, xs })
      i += 3
    }
  }
  return grids
}

async function canvasFromFile(file: File) {
  const bitmap = await createImageBitmap(file)
  const canvas = document.createElement('canvas')
  canvas.width = bitmap.width
  canvas.height = bitmap.height
  const context = canvas.getContext('2d', { willReadFrequently: true })!
  context.fillStyle = '#fff'
  context.fillRect(0, 0, canvas.width, canvas.height)
  context.drawImage(bitmap, 0, 0)
  bitmap.close()
  return canvas
}

async function stabilizedFile(file: File, onProgress: ProgressHandler) {
  const canvas = await canvasFromFile(file)
  const context = canvas.getContext('2d', { willReadFrequently: true })!
  const image = context.getImageData(0, 0, canvas.width, canvas.height)
  const grids = detectGrids(image)
  if (!grids.length) { canvas.width = 1; canvas.height = 1; return { file, grids: [] as Grid[] } }

  context.save()
  context.strokeStyle = '#000'
  context.lineWidth = Math.max(2, Math.round(canvas.width / 900))
  context.lineCap = 'butt'
  for (const grid of grids) {
    const left = grid.xs[0]
    const right = grid.xs.at(-1)!
    for (const y of grid.ys) {
      context.beginPath(); context.moveTo(left, y); context.lineTo(right, y); context.stroke()
    }
    for (const x of grid.xs) {
      context.beginPath(); context.moveTo(x, grid.ys[0]); context.lineTo(x, grid.ys[3]); context.stroke()
    }
  }
  context.restore()

  onProgress({ percent: 3, label: `${grids.length} tablo ızgarası geometrik olarak sabitlendi` })
  const blob = await new Promise<Blob>((resolve, reject) => canvas.toBlob((value) => value ? resolve(value) : reject(new Error('Görsel hazırlanamadı.')), 'image/png'))
  canvas.width = 1; canvas.height = 1
  return { file: new File([blob], file.name.replace(/\.[^.]+$/, '') + '-grid.png', { type: 'image/png' }), grids }
}

export async function scanCoordinateDocumentV10(file: File, options: DocumentCoordinateOptions, onProgress: ProgressHandler): Promise<DocumentScanResult> {
  if (file.size > MAX_FILE_BYTES) throw new Error('Belge en fazla 30 MB olabilir.')
  if (!file.type.startsWith('image/')) return scanCoordinateDocumentV9(file, options, onProgress)

  const stabilized = await stabilizedFile(file, onProgress)
  const result = await scanCoordinateDocumentV9(stabilized.file, options, onProgress)
  result.fileName = file.name
  if (stabilized.grids.length) {
    const columns = stabilized.grids.map((grid) => Math.max(0, grid.xs.length - 2))
    result.detection.evidence = [
      ...result.detection.evidence,
      `V10 ızgara onarımı: tablo sütunları ${columns.join(' + ')} olarak sabitlendi`,
    ]
  }
  return result
}
