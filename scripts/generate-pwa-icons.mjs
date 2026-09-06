import sharp from 'sharp'
import { writeFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'

const SOURCE_URL = 'https://raw.githubusercontent.com/izzetsahin86-star/evren-jeofizik-teklif/8aa4bd2f263f80fec13d778b35474a92ffd6c33c/evren-logo.png'
const iconDir = fileURLToPath(new URL('../public/icons/', import.meta.url))
const white = { r: 255, g: 255, b: 255, alpha: 1 }

const response = await fetch(SOURCE_URL, {
  headers: { 'User-Agent': 'evren-jeofizik-gis-build' },
})

if (!response.ok) {
  throw new Error(`Teklif uygulamasındaki Evren logosu alınamadı: ${response.status}`)
}

const source = Buffer.from(await response.arrayBuffer())
const metadata = await sharp(source).metadata()
const width = metadata.width ?? 506
const height = metadata.height ?? 511

// Teklif uygulamasındaki PNG'yi birebir kaynak olarak sakla.
await writeFile(`${iconDir}evren-logo.png`, source)

// GIS'in mevcut header/PDF kodu SVG içindeki JPEG'i okuyabildiği için,
// aynı teklif logosunu beyaz zeminde JPEG olarak SVG içine gömüyoruz.
const jpeg = await sharp(source)
  .flatten({ background: white })
  .jpeg({ quality: 96, chromaSubsampling: '4:4:4' })
  .toBuffer()

const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${width} ${height}"><image width="${width}" height="${height}" href="data:image/jpeg;base64,${jpeg.toString('base64')}"/></svg>\n`
await writeFile(`${iconDir}evren-jeofizik-logo.svg`, svg)

async function makeIcon(filename, size, safeScale = 1) {
  const inner = Math.round(size * safeScale)
  const inset = Math.floor((size - inner) / 2)
  const remainder = size - inner - inset

  let pipeline = sharp(source)
    .resize(inner, inner, { fit: 'contain', background: white })
    .flatten({ background: white })

  if (safeScale < 1) {
    pipeline = pipeline.extend({
      top: inset,
      bottom: remainder,
      left: inset,
      right: remainder,
      background: white,
    })
  }

  await pipeline
    .png({ compressionLevel: 9, adaptiveFiltering: true })
    .toFile(`${iconDir}${filename}`)
}

await Promise.all([
  makeIcon('evren-jeofizik-touch-v3.png', 180),
  makeIcon('evren-jeofizik-192-v3.png', 192),
  makeIcon('evren-jeofizik-512-v3.png', 512),
  makeIcon('evren-jeofizik-maskable-512-v3.png', 512, 0.8),
])

console.log('GIS logo and PWA icons generated from teklif app evren-logo.png')
