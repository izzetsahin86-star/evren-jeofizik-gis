import { scanCoordinateDocument, type DocumentCoordinateCandidate, type DocumentCoordinateOptions, type DocumentScanProgress, type DocumentScanResult } from './documentCoordinates'

type ProgressHandler = (progress: DocumentScanProgress) => void

type SupportedCandidate = {
  candidate: DocumentCoordinateCandidate
  support: number
  firstSeen: number
}

const MAX_OCR_PIXELS = 5_000_000
const GEO_FORMATS = new Set(['Lat/Lon', 'DMS', 'DDM'])

function normalizeOcrText(text: string) {
  return text
    .replace(/[−–—]/g, '-')
    .replace(/[º˚]/g, '°')
    .replace(/[′’]/g, "'")
    .replace(/[″“”]/g, '"')
    .replace(/(?<=\d)[OoQ](?=\d)/g, '0')
    .replace(/(?<=\d)[Il|](?=\d)/g, '1')
    .replace(/(\d)\s*([.,])\s*(\d)/g, '$1$2$3')
    .replace(/[ \t]+/g, ' ')
}

function isGeographic(candidate: DocumentCoordinateCandidate) {
  return GEO_FORMATS.has(candidate.format) && candidate.confidence >= 60
}

function geographicCandidates(result: DocumentScanResult) {
  return result.candidates.filter(isGeographic)
}

function geographicCandidateCount(result: DocumentScanResult) {
  return geographicCandidates(result).length
}

function candidateKey(candidate: DocumentCoordinateCandidate) {
  return `${candidate.format}:${candidate.lat.toFixed(6)}:${candidate.lng.toFixed(6)}`
}

function sameCoordinate(a: number, b: number) {
  return Math.abs(a - b) <= 0.000001
}

function mergeGeographicPasses(results: DocumentScanResult[], originalName: string): DocumentScanResult {
  const supportMap = new Map<string, SupportedCandidate>()
  let seenOrder = 0

  results.forEach((result) => {
    const seenThisPass = new Set<string>()
    geographicCandidates(result).forEach((candidate) => {
      const key = candidateKey(candidate)
      if (seenThisPass.has(key)) return
      seenThisPass.add(key)

      const current = supportMap.get(key)
      if (current) {
        current.support += 1
        if (candidate.confidence > current.candidate.confidence) current.candidate = candidate
        return
      }

      supportMap.set(key, { candidate, support: 1, firstSeen: seenOrder++ })
    })
  })

  const entries = Array.from(supportMap.values())
  const filtered = entries.filter((entry) => {
    const candidate = entry.candidate
    if (candidate.format !== 'Lat/Lon' || entry.support > 1) return true

    // OCR geçişleri bazen bir satırın ilk değerini başka bir satırın ilk değeriyle
    // yanlış çift yapabiliyor. Örn. 40.982910, 41.008238. Aynı enlemin doğru
    // alternatifi mevcutsa ve şüpheli boylam başka bir noktanın enlemine eşitse ele.
    const sameLatAlternative = entries.some((other) =>
      other !== entry
      && other.candidate.format === 'Lat/Lon'
      && sameCoordinate(other.candidate.lat, candidate.lat)
      && !sameCoordinate(other.candidate.lng, candidate.lng)
      && other.support >= entry.support,
    )
    const longitudeMatchesAnotherLatitude = entries.some((other) =>
      other !== entry
      && other.candidate.format === 'Lat/Lon'
      && sameCoordinate(other.candidate.lat, candidate.lng),
    )

    return !(sameLatAlternative && longitudeMatchesAnotherLatitude)
  })

  filtered.sort((a, b) => a.firstSeen - b.firstSeen)
  const candidates = filtered.map((entry, index) => ({
    ...entry.candidate,
    id: `doc-geo-image-${index + 1}-${entry.candidate.lat.toFixed(6)}-${entry.candidate.lng.toFixed(6)}`,
    reasons: [
      ...entry.candidate.reasons,
      entry.support > 1 ? `${entry.support} ayrı OCR geçişinde doğrulandı` : 'Tek OCR geçişinden güvenli satır çifti',
    ],
  }))

  const base = [...results].sort((a, b) => geographicCandidateCount(b) - geographicCandidateCount(a))[0]
  return {
    ...base,
    fileName: originalName,
    usedOcr: true,
    candidates,
    detection: {
      ...base.detection,
      evidence: [
        ...base.detection.evidence,
        `${results.length} OCR geçişi ayrı ayrı çözümlendi; metinler birbirine eklenmedi`,
        'OCR geçişleri arası çapraz sahte koordinat çiftleri elendi',
      ],
    },
    stats: {
      high: candidates.filter((candidate) => candidate.confidenceLevel === 'high').length,
      medium: candidates.filter((candidate) => candidate.confidenceLevel === 'medium').length,
      low: candidates.filter((candidate) => candidate.confidenceLevel === 'low').length,
      duplicatesRemoved: Math.max(0, entries.length - candidates.length),
      tableRows: candidates.length,
    },
    warning: undefined,
  }
}

async function parseRecognizedText(text: string, originalName: string, options: DocumentCoordinateOptions) {
  const normalized = normalizeOcrText(text)
  const virtualFile = new File([normalized], `${originalName}.coordinates.txt`, { type: 'text/plain' })
  const parsed = await scanCoordinateDocument(virtualFile, options, () => undefined)
  return {
    ...parsed,
    fileName: originalName,
    usedOcr: true,
    detection: {
      ...parsed.detection,
      evidence: [...parsed.detection.evidence, 'DD/DMS/DDM için özel görsel OCR uygulandı'],
    },
  } satisfies DocumentScanResult
}

async function prepareCanvas(file: File) {
  const bitmap = await createImageBitmap(file)
  const sourcePixels = Math.max(1, bitmap.width * bitmap.height)
  const scale = Math.max(1, Math.min(3, Math.sqrt(MAX_OCR_PIXELS / sourcePixels)))
  const canvas = document.createElement('canvas')
  canvas.width = Math.max(1, Math.round(bitmap.width * scale))
  canvas.height = Math.max(1, Math.round(bitmap.height * scale))
  const context = canvas.getContext('2d', { willReadFrequently: true })!
  context.fillStyle = '#fff'
  context.fillRect(0, 0, canvas.width, canvas.height)
  context.drawImage(bitmap, 0, 0, canvas.width, canvas.height)
  bitmap.close()

  // İnce nokta ve virgülleri silmeden metni belirginleştir.
  const image = context.getImageData(0, 0, canvas.width, canvas.height)
  for (let index = 0; index < image.data.length; index += 4) {
    const gray = image.data[index] * .299 + image.data[index + 1] * .587 + image.data[index + 2] * .114
    const value = Math.max(0, Math.min(255, (gray - 128) * 1.28 + 128))
    image.data[index] = value
    image.data[index + 1] = value
    image.data[index + 2] = value
  }
  context.putImageData(image, 0, 0)
  return canvas
}

export async function scanGeographicCoordinateImage(
  file: File,
  options: DocumentCoordinateOptions,
  onProgress: ProgressHandler,
): Promise<DocumentScanResult | null> {
  if (!file.type.startsWith('image/')) return null

  onProgress({ percent: 4, label: 'DD / DMS / DDM görseli hazırlanıyor…' })
  const canvas = await prepareCanvas(file)
  const { createWorker, PSM } = await import('tesseract.js')
  const worker = await createWorker('eng', 1, {
    logger: (message) => {
      if (message.status !== 'recognizing text') return
      onProgress({
        percent: Math.min(94, 10 + Math.round(message.progress * 80)),
        label: `DD / DMS / DDM karakterleri okunuyor · %${Math.round(message.progress * 100)}`,
      })
    },
  })

  try {
    const common = {
      tessedit_char_whitelist: `0123456789.,+-°º˚'\"′″NSEWnsew `,
      preserve_interword_spaces: '1',
    }

    // 1) Dağınık metin ve ekran görüntüleri için ilk geçiş.
    await worker.setParameters({ ...common, tessedit_pageseg_mode: PSM.SPARSE_TEXT })
    const sparse = await worker.recognize(canvas)
    const sparseParsed = await parseRecognizedText(sparse.data.text ?? '', file.name, options)
    if (geographicCandidateCount(sparseParsed) >= 8) {
      onProgress({ percent: 100, label: `${sparseParsed.candidates.length} coğrafi koordinat adayı okundu` })
      return sparseParsed
    }

    // 2) Satır düzenini koruyan genel sayfa geçişi. Metinler birleştirilmez;
    // her OCR geçişi ayrı parse edilir ve koordinatlar sonradan güvenli biçimde birleştirilir.
    await worker.setParameters({ ...common, tessedit_pageseg_mode: PSM.AUTO })
    const automatic = await worker.recognize(canvas)
    const automaticParsed = await parseRecognizedText(automatic.data.text ?? '', file.name, options)
    let merged = mergeGeographicPasses([sparseParsed, automaticParsed], file.name)
    if (geographicCandidateCount(merged) >= 8) {
      onProgress({ percent: 100, label: `${merged.candidates.length} coğrafi koordinat adayı okundu` })
      return merged
    }

    // 3) Kısa koordinat listelerinde son satır kontrolü.
    await worker.setParameters({ ...common, tessedit_pageseg_mode: PSM.SINGLE_BLOCK })
    const block = await worker.recognize(canvas)
    const blockParsed = await parseRecognizedText(block.data.text ?? '', file.name, options)
    merged = mergeGeographicPasses([sparseParsed, automaticParsed, blockParsed], file.name)
    merged.detection.evidence = [
      ...merged.detection.evidence,
      'Kısa koordinat listeleri için son satır kontrolü uygulandı',
    ]

    onProgress({ percent: 100, label: `${merged.candidates.length} coğrafi koordinat adayı okundu` })
    return merged
  } finally {
    await worker.terminate()
    canvas.width = 1
    canvas.height = 1
  }
}
