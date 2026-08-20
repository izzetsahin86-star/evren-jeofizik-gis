import { scanCoordinateDocumentV10 } from './documentCoordinatesV10'
import type {
  DocumentCoordinateCandidate,
  DocumentCoordinateFormat,
  DocumentCoordinateOptions,
  DocumentScanProgress,
  DocumentScanResult,
} from './documentCoordinates'

type ProgressHandler = (progress: DocumentScanProgress) => void

const GEO_FORMATS = new Set<DocumentCoordinateFormat>(['Lat/Lon', 'DMS', 'DDM'])

function isProtectedUtmResult(result: DocumentScanResult) {
  const utm = result.candidates.filter((candidate) => candidate.format === 'UTM')
  const geographic = result.candidates.filter((candidate) => GEO_FORMATS.has(candidate.format))
  const hasV10Grid = result.detection.evidence.some((item) => /V10 ızgara onarımı/i.test(item))
  const hasRuhsatTable = result.stats.tableRows >= 3
    && utm.some((candidate) => /ruhsat|sağa\s*\(y\)|yukarı\s*\(x\)/i.test(`${candidate.source} ${candidate.raw}`))

  // Çalışan UTM motoru için koruma kilidi:
  // UTM tek format ise veya V10/ruhsat tablosu tarafından doğrulanmışsa sonuç aynen döner.
  return utm.length > 0 && (geographic.length === 0 || hasV10Grid || hasRuhsatTable)
}

function compactGeographicRaw(candidate: DocumentCoordinateCandidate, pointNumber: number) {
  const name = candidate.name?.trim() || `${pointNumber}.Nokta`
  if (candidate.format === 'Lat/Lon') {
    return `${name} · Enlem ${candidate.lat.toFixed(6)} · Boylam ${candidate.lng.toFixed(6)}`
  }
  return `${name} · ${candidate.raw.trim()}`
}

function normalizeGeographicCandidates(candidates: DocumentCoordinateCandidate[]) {
  return candidates.map((candidate, index) => {
    const pointNumber = index + 1
    const name = candidate.name?.trim() || `${pointNumber}.Nokta`
    return {
      ...candidate,
      name,
      raw: compactGeographicRaw({ ...candidate, name }, pointNumber),
      group: candidate.group || 'Coğrafi Koordinatlar',
      reasons: [
        ...candidate.reasons,
        candidate.format === 'Lat/Lon'
          ? 'Decimal Degrees (DD) koordinat sistemi'
          : candidate.format === 'DMS'
            ? 'Derece Dakika Saniye (DMS) koordinat sistemi'
            : 'Derece Ondalık Dakika (DDM) koordinat sistemi',
      ],
    }
  })
}

function buildStats(candidates: DocumentCoordinateCandidate[], original: DocumentScanResult) {
  return {
    high: candidates.filter((candidate) => candidate.confidenceLevel === 'high').length,
    medium: candidates.filter((candidate) => candidate.confidenceLevel === 'medium').length,
    low: candidates.filter((candidate) => candidate.confidenceLevel === 'low').length,
    duplicatesRemoved: original.stats.duplicatesRemoved,
    tableRows: candidates.length,
  }
}

function formatLabel(candidates: DocumentCoordinateCandidate[]) {
  const formats = Array.from(new Set(candidates.map((candidate) => candidate.format)))
  return formats.map((format) => format === 'Lat/Lon' ? 'DD' : format).join(' + ')
}

export async function scanCoordinateDocumentV11(
  file: File,
  options: DocumentCoordinateOptions,
  onProgress: ProgressHandler,
): Promise<DocumentScanResult> {
  // V10 önce çalışır. Böylece mevcut UTM davranışı ve tüm V10/V9 kurtarma katmanları korunur.
  const result = await scanCoordinateDocumentV10(file, options, onProgress)

  if (isProtectedUtmResult(result)) {
    return result
  }

  const geographic = result.candidates.filter((candidate) =>
    GEO_FORMATS.has(candidate.format) && candidate.confidence >= 65,
  )

  if (!geographic.length) {
    // Yeni format bulunamazsa da eski V10 sonucu değiştirilmez.
    return result
  }

  const candidates = normalizeGeographicCandidates(geographic)
  const label = formatLabel(candidates)

  onProgress({ percent: 100, label: `${candidates.length} ${label} koordinatı doğrulandı` })

  return {
    ...result,
    candidates,
    detection: {
      ...result.detection,
      evidence: [
        ...result.detection.evidence,
        `Koordinat sistemi otomatik algılandı: ${label}`,
        'UTM V10 koruma katmanı değiştirilmeden bırakıldı',
      ],
    },
    stats: buildStats(candidates, result),
    warning: undefined,
  }
}
