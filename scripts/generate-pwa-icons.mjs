import sharp from 'sharp'
import { fileURLToPath } from 'node:url'

const source = fileURLToPath(new URL('../public/icons/evren-jeofizik-logo.svg', import.meta.url))
const iconDir = fileURLToPath(new URL('../public/icons/', import.meta.url))
const white = { r: 255, g: 255, b: 255, alpha: 1 }

async function makeIcon(filename, size, safeScale = 1) {
  const inner = Math.round(size * safeScale)
  const inset = Math.floor((size - inner) / 2)
  const remainder = size - inner - inset

  let pipeline = sharp(source, { density: 300 })
    .resize(inner, inner, { fit: 'contain', background: white })

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
  makeIcon('evren-jeofizik-touch-v2.png', 180),
  makeIcon('evren-jeofizik-192-v2.png', 192),
  makeIcon('evren-jeofizik-512-v2.png', 512),
  makeIcon('evren-jeofizik-maskable-512-v2.png', 512, 0.8),
])

console.log('Evren Jeofizik PWA icons generated from evren-jeofizik-logo.svg')
