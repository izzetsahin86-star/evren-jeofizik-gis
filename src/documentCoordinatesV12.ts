import type { DocumentCoordinateOptions, DocumentScanProgress, DocumentScanResult } from './documentCoordinates'
import { applyExtendedCoordinateSystem } from './documentCoordinatesExtendedSystems'
import { scanCoordinateDocumentV11 } from './documentCoordinatesV11'

type ProgressHandler = (progress: DocumentScanProgress) => void

export async function scanCoordinateDocumentV12(
  file: File,
  options: DocumentCoordinateOptions,
  onProgress: ProgressHandler,
): Promise<DocumentScanResult> {
  const base = await scanCoordinateDocumentV11(file, options, onProgress)
  const extended = await applyExtendedCoordinateSystem(file, base, options, onProgress)
  return extended ?? base
}
