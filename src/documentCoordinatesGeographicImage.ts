import { scanCoordinateDocument, type DocumentCoordinateOptions, type DocumentScanProgress, type DocumentScanResult } from './documentCoordinates'

type ProgressHandler = (progress: DocumentScanProgress) => void

const MAX_OCR_PIXELS = 5_000_000

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

function hasGeographicCandidates(result: DocumentScanResult) {
  return result.candidates.some((candidate) =>
    (candidate.format === 'Lat/Lon' || candidate.format === 'DMS' || candidate.format === 'DDM')
    && candidate.confidence >= 60,
  )
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

    await worker.setParameters({ ...common, tessedit_pageseg_mode: PSM.SPARSE_TEXT })
    const sparse = await worker.recognize(canvas)
    let parsed = await parseRecognizedText(sparse.data.text ?? '', file.name, options)
    if (hasGeographicCandidates(parsed)) {
      onProgress({ percent: 100, label: `${parsed.candidates.length} coğrafi koordinat adayı okundu` })
      return parsed
    }

    // Bazı ekran görüntülerinde satır düzeni SPARSE_TEXT ile bölünebilir; AUTO ikinci güvenli denemedir.
    await worker.setParameters({ ...common, tessedit_pageseg_mode: PSM.AUTO })
    const automatic = await worker.recognize(canvas)
    parsed = await parseRecognizedText(`${sparse.data.text ?? ''}\n${automatic.data.text ?? ''}`, file.name, options)
    onProgress({ percent: 100, label: `${parsed.candidates.length} coğrafi koordinat adayı okundu` })
    return parsed
  } finally {
    await worker.terminate()
    canvas.width = 1
    canvas.height = 1
  }
}
