import proj4 from 'proj4'
import { fromUtm } from './geo'
import type {
  DocumentCoordinateCandidate,
  DocumentCoordinateOptions,
  DocumentScanProgress,
  DocumentScanResult,
} from './documentCoordinates'

type ProgressHandler = (progress: DocumentScanProgress) => void
type ProjectionKind = 'UTM' | 'TM3' | 'GK3'

type SystemHint = {
  datum: string
  projection: ProjectionKind
  centralMeridian?: number
  gkZone?: number
  utmZone?: number
  epsg?: number
  evidence: string[]
}

const TURKEY = { south: 34.2, north: 43.5, west: 24.5, east: 46.5 }

function fold(value: string) {
  return value.toLocaleUpperCase('tr-TR')
    .replace(/İ/g, 'I').replace(/Ş/g, 'S').replace(/Ğ/g, 'G')
    .replace(/Ü/g, 'U').replace(/Ö/g, 'O').replace(/Ç/g, 'C')
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
}

function inTurkey(lat: number, lng: number) {
  return Number.isFinite(lat) && Number.isFinite(lng)
    && lat >= TURKEY.south && lat <= TURKEY.north
    && lng >= TURKEY.west && lng <= TURKEY.east
}

function datumFromText(value: string) {
  if (/\bE\s*D\s*[- ]?\s*50\b|EUROPEAN\s+DATUM\s+1950/.test(value)) return 'ED50'
  if (/\bT\s*U\s*R\s*E\s*F\b|TURKISH\s+NATIONAL\s+REFERENCE\s+FRAME|TURKIYE\s+ULUSAL\s+REFERANS/.test(value)) return 'TUREF'
  const itrf = value.match(/\bI\s*T\s*R\s*F\s*[- ]?\s*(\d{2,4})?\b/)
  if (itrf) return itrf[1] ? `ITRF${itrf[1]}` : 'ITRF'
  if (/\bW\s*G\s*S\s*[- ]?\s*84\b/.test(value)) return 'WGS84'
  return undefined
}

function epsgHint(value: string): SystemHint | null {
  const codes = Array.from(value.matchAll(/\bEPSG\s*[:=-]?\s*(\d{4,5})\b/g), (match) => Number(match[1]))
  for (const code of codes) {
    if (code >= 5253 && code <= 5259) {
      const centralMeridian = 27 + (code - 5253) * 3
      return { datum: 'TUREF', projection: 'TM3', centralMeridian, epsg: code, evidence: [`EPSG:${code} → TUREF / TM${centralMeridian}`] }
    }
    if (code >= 5269 && code <= 5275) {
      const gkZone = 9 + (code - 5269)
      return { datum: 'TUREF', projection: 'GK3', centralMeridian: gkZone * 3, gkZone, epsg: code, evidence: [`EPSG:${code} → TUREF / 3° Gauss-Krüger zone ${gkZone}`] }
    }
    if (code >= 2206 && code <= 2212) {
      const gkZone = 9 + (code - 2206)
      return { datum: 'ED50', projection: 'GK3', centralMeridian: gkZone * 3, gkZone, epsg: code, evidence: [`EPSG:${code} → ED50 / 3° Gauss-Krüger zone ${gkZone}`] }
    }
    if (code >= 23035 && code <= 23038) {
      const utmZone = code - 23000
      return { datum: 'ED50', projection: 'UTM', utmZone, epsg: code, evidence: [`EPSG:${code} → ED50 / UTM Zone ${utmZone}N`] }
    }
  }
  return null
}

function detectSystemHint(text: string, base: DocumentScanResult): SystemHint | null {
  const value = fold(text)
  const fromEpsg = epsgHint(value)
  if (fromEpsg) return fromEpsg

  const datum = datumFromText(value)
  if (!datum || datum === 'WGS84') return null

  const evidence: string[] = [`${datum} belge üzerinde açıkça algılandı`]
  const tmMatch = value.match(/\bTM\s*[- ]?\s*(27|30|33|36|39|42|45)\b/)
  const gkMatch = value.match(/(?:GAUSS\s*[- ]?\s*KRUGER|GAUSSKRUGER).{0,50}?(?:ZONE|ZON|DILIM)?\s*[:=-]?\s*(9|10|11|12|13|14|15)\b/)
  const meridianMatch = value.match(/(?:DILIM\s+ORTA\s+MERIDYENI|ORTA\s+MERIDYEN|MERKEZI\s+MERIDYEN|CENTRAL\s+MERIDIAN)\s*[:=-]?\s*(27|30|33|36|39|42|45)\b/)
  const threeDegree = /\b3\s*(?:°|DERECE|DEGREE)\b|3\s*[- ]?DEGREE|3\s*DERECELIK/.test(value)
  const mentionsGk = /GAUSS\s*[- ]?\s*KRUGER|GAUSSKRUGER/.test(value)
  const mentionsUtm = /\bUTM\b/.test(value)

  if (gkMatch) {
    const gkZone = Number(gkMatch[1])
    evidence.push(`3° Gauss-Krüger zone ${gkZone} belgeden algılandı`)
    return { datum, projection: 'GK3', centralMeridian: gkZone * 3, gkZone, evidence }
  }

  if (tmMatch) {
    const centralMeridian = Number(tmMatch[1])
    evidence.push(`TM${centralMeridian} merkezi meridyeni belgeden algılandı`)
    return { datum, projection: 'TM3', centralMeridian, evidence }
  }

  if (meridianMatch && (threeDegree || mentionsGk || !mentionsUtm)) {
    const centralMeridian = Number(meridianMatch[1])
    evidence.push(`Merkezi meridyen ${centralMeridian}° belgeden algılandı`)
    return { datum, projection: mentionsGk ? 'GK3' : 'TM3', centralMeridian, gkZone: mentionsGk ? centralMeridian / 3 : undefined, evidence }
  }

  const utmZoneMatch = value.match(/\bUTM\b.{0,28}?(?:ZONE|ZON|DILIM)?\s*[:=-]?\s*(3[5-8])\s*([NS])?\b/)
  const utmZone = utmZoneMatch ? Number(utmZoneMatch[1]) : base.detection.zone
  evidence.push(`${datum} datumlu UTM olarak değerlendirildi`)
  return { datum, projection: 'UTM', utmZone, evidence }
}

function parseMetric(value: string) {
  const compact = value.trim().replace(/\s+/g, '')
  const thousands = compact.match(/^(\d{1,3})(?:[.,](\d{3}))+$/)
  if (thousands) return Number(compact.replace(/[.,]/g, ''))
  return Number(compact.replace(',', '.'))
}

function pairFromCandidate(candidate: DocumentCoordinateCandidate) {
  const raw = candidate.raw
  const eastMatch = raw.match(/(?:SA[ĞG]A\s*\(?Y\)?|EASTING|DO[ĞG]U)\D{0,16}(\d{5,8}(?:[.,]\d{1,3})?)/i)
  const northMatch = raw.match(/(?:YUKARI\s*\(?X\)?|NORTHING|KUZEY)\D{0,16}(\d{6,8}(?:[.,]\d{1,3})?)/i)
  if (eastMatch && northMatch) {
    const easting = parseMetric(eastMatch[1])
    const northing = parseMetric(northMatch[1])
    if (Number.isFinite(easting) && Number.isFinite(northing)) return { easting, northing }
  }

  const tokens = Array.from(raw.matchAll(/\b\d{5,8}(?:[.,]\d{1,3})?\b/g), (match) => parseMetric(match[0]))
    .filter(Number.isFinite)
  const northing = tokens.find((number) => number >= 3_400_000 && number <= 5_500_000)
  const easting = tokens.find((number) => (number >= 100_000 && number <= 900_000) || (number >= 8_500_000 && number <= 16_500_000))
  if (easting !== undefined && northing !== undefined && easting !== northing) return { easting, northing }
  return null
}

function modernUtmDefinition(zone: number, hemisphere: 'N' | 'S') {
  return `+proj=utm +zone=${zone} ${hemisphere === 'S' ? '+south' : ''} +ellps=GRS80 +towgs84=0,0,0,0,0,0,0 +units=m +no_defs`
}

function tmDefinition(datum: string, centralMeridian: number, falseEasting: number) {
  const datumDefinition = datum === 'ED50'
    ? '+ellps=intl +towgs84=-87,-98,-121,0,0,0,0'
    : '+ellps=GRS80 +towgs84=0,0,0,0,0,0,0'
  return `+proj=tmerc +lat_0=0 +lon_0=${centralMeridian} +k=1 +x_0=${falseEasting} +y_0=0 ${datumDefinition} +units=m +no_defs`
}

function transformPair(
  pair: { easting: number; northing: number },
  candidate: DocumentCoordinateCandidate,
  hint: SystemHint,
  base: DocumentScanResult,
  options: DocumentCoordinateOptions,
) {
  try {
    if (hint.projection === 'UTM') {
      const zone = hint.utmZone ?? candidate.zone ?? base.detection.zone ?? options.zone
      const hemisphere = candidate.hemisphere ?? base.detection.hemisphere ?? options.hemisphere
      if (hint.datum === 'ED50') return fromUtm(pair.easting, pair.northing, zone, hemisphere, 'ED50')
      const [lng, lat] = proj4(modernUtmDefinition(zone, hemisphere), 'EPSG:4326', [pair.easting, pair.northing])
      return { lat, lng }
    }

    const centralMeridian = hint.centralMeridian
    if (!centralMeridian) return null
    const zonePrefix = hint.gkZone ?? centralMeridian / 3
    const falseEasting = pair.easting > 2_000_000 ? zonePrefix * 1_000_000 + 500_000 : 500_000
    const [lng, lat] = proj4(tmDefinition(hint.datum, centralMeridian, falseEasting), 'EPSG:4326', [pair.easting, pair.northing])
    return { lat, lng }
  } catch {
    return null
  }
}

function systemLabel(hint: SystemHint) {
  if (hint.projection === 'UTM') return `${hint.datum} / UTM${hint.utmZone ? ` Zone ${hint.utmZone}N` : ''}`
  if (hint.projection === 'GK3') return `${hint.datum} / 3° Gauss-Krüger${hint.gkZone ? ` zone ${hint.gkZone}` : ''}`
  return `${hint.datum} / TM${hint.centralMeridian ?? ''} (3° TM)`
}

async function textFromDocx(file: File) {
  const { default: JSZip } = await import('jszip')
  const archive = await JSZip.loadAsync(file)
  const xmlText = await archive.file('word/document.xml')?.async('string')
  if (!xmlText) return ''
  const xml = new DOMParser().parseFromString(xmlText, 'application/xml')
  return Array.from(xml.getElementsByTagName('w:t')).map((node) => node.textContent ?? '').join(' ')
}

async function textFromPdf(file: File) {
  const pdfjs = await import('pdfjs-dist')
  const loadingTask = pdfjs.getDocument({ data: new Uint8Array(await file.arrayBuffer()) })
  const pdf = await loadingTask.promise
  const pages: string[] = []
  try {
    const count = Math.min(pdf.numPages, 12)
    for (let pageNumber = 1; pageNumber <= count; pageNumber += 1) {
      const page = await pdf.getPage(pageNumber)
      const content = await page.getTextContent()
      pages.push(content.items.map((item) => 'str' in item ? item.str : '').join(' '))
    }
  } finally {
    await loadingTask.destroy()
  }
  return pages.join('\n')
}

async function textFromImage(file: File, onProgress: ProgressHandler) {
  const bitmap = await createImageBitmap(file)
  const longEdge = Math.max(bitmap.width, bitmap.height)
  const scale = Math.min(1.6, 2200 / Math.max(1, longEdge))
  const canvas = document.createElement('canvas')
  canvas.width = Math.max(1, Math.round(bitmap.width * scale))
  canvas.height = Math.max(1, Math.round(bitmap.height * scale))
  const context = canvas.getContext('2d')!
  context.fillStyle = '#fff'; context.fillRect(0, 0, canvas.width, canvas.height)
  context.drawImage(bitmap, 0, 0, canvas.width, canvas.height)
  bitmap.close()

  const { createWorker, PSM } = await import('tesseract.js')
  const worker = await createWorker('eng', 1)
  try {
    onProgress({ percent: 100, label: 'ED50 / ITRF / TUREF / 3° TM bilgisi kontrol ediliyor…' })
    await worker.setParameters({ tessedit_pageseg_mode: PSM.SPARSE_TEXT, preserve_interword_spaces: '1' })
    const result = await worker.recognize(canvas)
    return result.data.text ?? ''
  } finally {
    await worker.terminate()
    canvas.width = 1; canvas.height = 1
  }
}

function shouldInspectImage(base: DocumentScanResult) {
  const evidence = fold(base.detection.evidence.join(' '))
  return base.detection.datum === 'ED50'
    || /MODERN\s+DATUM|WGS84\/MODERN|ED50|ITRF|TUREF/.test(evidence)
}

async function readSystemText(file: File, base: DocumentScanResult, onProgress: ProgressHandler) {
  const lower = file.name.toLowerCase()
  if (file.type.startsWith('image/')) {
    if (!shouldInspectImage(base)) return ''
    return textFromImage(file, onProgress)
  }
  if (file.type === 'application/pdf' || lower.endsWith('.pdf')) return textFromPdf(file)
  if (lower.endsWith('.docx')) return textFromDocx(file)
  return file.text()
}

export async function applyExtendedCoordinateSystem(
  file: File,
  base: DocumentScanResult,
  options: DocumentCoordinateOptions,
  onProgress: ProgressHandler,
): Promise<DocumentScanResult | null> {
  const projected = base.candidates.filter((candidate) => candidate.format === 'UTM')
  if (!projected.length || projected.length !== base.candidates.length) return null

  const text = await readSystemText(file, base, onProgress)
  if (!text) return null
  const hint = detectSystemHint(text, base)
  if (!hint) return null

  const converted: DocumentCoordinateCandidate[] = []
  for (const candidate of projected) {
    const pair = pairFromCandidate(candidate)
    if (!pair) continue
    const point = transformPair(pair, candidate, hint, base, options)
    if (!point || !inTurkey(point.lat, point.lng)) continue
    converted.push({
      ...candidate,
      id: `doc-v12-${candidate.id}`,
      lat: point.lat,
      lng: point.lng,
      datum: hint.datum,
      reasons: [
        ...candidate.reasons,
        ...hint.evidence,
        `${systemLabel(hint)} dönüşümü V12 ayrı katmanında uygulandı`,
        'UTM V10 ve DD/DMS/DDM okuyucuları değiştirilmedi',
      ],
    })
  }

  const minimum = Math.max(1, Math.ceil(projected.length * 0.7))
  if (converted.length < minimum) return null

  const label = systemLabel(hint)
  const missing = projected.length - converted.length
  onProgress({ percent: 100, label: `${converted.length} koordinat ${label} olarak doğrulandı` })
  return {
    ...base,
    candidates: converted,
    detection: {
      ...base.detection,
      datum: hint.datum,
      evidence: [
        ...base.detection.evidence,
        ...hint.evidence,
        `Koordinat sistemi otomatik algılandı: ${label}`,
        hint.centralMeridian ? `Merkezi meridyen: ${hint.centralMeridian}°` : '',
        'V12 ek sistem katmanı; mevcut UTM/DD/DMS/DDM motorları değiştirilmedi',
      ].filter(Boolean),
    },
    stats: {
      ...base.stats,
      high: converted.filter((candidate) => candidate.confidenceLevel === 'high').length,
      medium: converted.filter((candidate) => candidate.confidenceLevel === 'medium').length,
      low: converted.filter((candidate) => candidate.confidenceLevel === 'low').length,
      tableRows: Math.max(base.stats.tableRows, converted.length),
    },
    warning: missing
      ? `${converted.length}/${projected.length} nokta ${label} ile güvenle dönüştürüldü; ${missing} nokta eklenmedi.`
      : base.warning,
  }
}
