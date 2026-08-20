import { scanCoordinateDocument, type DocumentCoordinateCandidate, type DocumentCoordinateFormat, type DocumentCoordinateOptions, type DocumentScanProgress, type DocumentScanResult } from './documentCoordinates'
import { scanCoordinateDocumentV10 } from './documentCoordinatesV10'

type ProgressHandler = (progress: DocumentScanProgress) => void

const GEO_FORMATS = new Set<DocumentCoordinateFormat>(['Lat/Lon', 'DMS', 'DDM'])

function isProtectedUtmResult(result: DocumentScanResult) {
  const utm = result.candidates.filter((candidate) => candidate.format === 'UTM')
  if (!utm.length) return false

  const hasV10Grid = result.detection.evidence.some((item) => /V10 ızgara onarımı/i.test(item))
  const hasRuhsatTable = result.stats.tableRows >= 3
    && utm.some((candidate) => /ruhsat|sağa\s*\(y\)|yukarı\s*\(x\)/i.test(`${candidate.source} ${candidate.raw}`))
  const hasStrongUtm = utm.some((candidate) => candidate.confidence >= 85)
  const onlyUtm = result.candidates.every((candidate) => candidate.format === 'UTM')

  // V10 ızgarası, ruhsat tablosu veya güçlü saf UTM sonucu varsa eski motorun çıktısı aynen korunur.
  return hasV10Grid || hasRuhsatTable || (onlyUtm && hasStrongUtm)
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

function geographicFrom(result: DocumentScanResult) {
  return result.candidates.filter((candidate) =>
    GEO_FORMATS.has(candidate.format) && candidate.confidence >= 65,
  )
}

function geographicResult(base: DocumentScanResult, candidatesInput: DocumentCoordinateCandidate[]) {
  const candidates = normalizeGeographicCandidates(candidatesInput)
  const label = formatLabel(candidates)
  return {
    ...base,
    candidates,
    detection: {
      ...base.detection,
      evidence: [
        ...base.detection.evidence,
        `Koordinat sistemi otomatik algılandı: ${label}`,
        'UTM V10 koruma katmanı değiştirilmeden bırakıldı',
      ],
    },
    stats: buildStats(candidates, base),
    warning: undefined,
  } satisfies DocumentScanResult
}

export async function scanCoordinateDocumentV11(
  file: File,
  options: DocumentCoordinateOptions,
  onProgress: ProgressHandler,
): Promise<DocumentScanResult> {
  // 1) Her zaman mevcut V10 çalışır. Güçlü UTM sonucu gelirse hiçbir alanı değiştirmeden döner.
  const v10 = await scanCoordinateDocumentV10(file, options, onProgress)
  if (isProtectedUtmResult(v10)) return v10

  // 2) V10 zinciri zaten güvenli DD/DMS/DDM adayı üretmişse ikinci OCR yapmadan onu kullan.
  const v10Geographic = geographicFrom(v10)
  if (v10Geographic.length) {
    const result = geographicResult(v10, v10Geographic)
    onProgress({ percent: 100, label: `${result.candidates.length} coğrafi koordinat doğrulandı` })
    return result
  }

  // 3) Düşük güvenli/şüpheli UTM sonucu varsa yalnız bu durumda temel DD/DMS/DDM okuyucusuna geç.
  onProgress({ percent: 4, label: 'DD / DMS / DDM koordinatları kontrol ediliyor…' })
  const generic = await scanCoordinateDocument(file, options, (progress) => {
    onProgress({
      percent: Math.max(5, Math.min(99, progress.percent)),
      label: progress.label,
    })
  })
  const geographic = geographicFrom(generic)

  // Yeni format bulunamazsa eski V10 çıktısını aynen koru.
  if (!geographic.length) return v10

  const result = geographicResult(generic, geographic)
  onProgress({ percent: 100, label: `${result.candidates.length} ${formatLabel(result.candidates)} koordinatı doğrulandı` })
  return result
}
