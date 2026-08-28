const CACHE_VERSION = 'evren-gis-v36'
const SHELL_CACHE = `${CACHE_VERSION}-shell`
const TILE_CACHE = `${CACHE_VERSION}-tiles`
const SHELL_FILES = ['/', '/index.html', '/offline.html', '/manifest.webmanifest', '/icons/evren-gis.svg', '/icons/evren-jeofizik-logo.svg', '/fonts/EvrenSans.ttf', '/fonts/EvrenSans-Bold.ttf']
const TILE_HOSTS = ['basemaps.cartocdn.com', 'arcgisonline.com', 'tile.opentopomap.org']

async function trimCache(cacheName, maximum) {
  const cache = await caches.open(cacheName)
  const keys = await cache.keys()
  if (keys.length <= maximum) return
  await Promise.all(keys.slice(0, keys.length - maximum).map((key) => cache.delete(key)))
}

self.addEventListener('install', (event) => {
  event.waitUntil((async () => {
    const cache = await caches.open(SHELL_CACHE)
    await cache.addAll(SHELL_FILES)
    try {
      const response = await fetch('/index.html', { cache: 'no-store' })
      const html = await response.text()
      const assets = Array.from(html.matchAll(/(?:src|href)="([^"]+)"/g), (match) => match[1]).filter((path) => path.startsWith('/assets/'))
      await Promise.allSettled(assets.map((asset) => cache.add(asset)))
    } catch { /* Runtime caching fills missing assets on first load. */ }
    await self.skipWaiting()
  })())
})

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    const keys = await caches.keys()
    await Promise.all(keys.filter((key) => !key.startsWith(CACHE_VERSION)).map((key) => caches.delete(key)))
    await self.clients.claim()
  })())
})

self.addEventListener('fetch', (event) => {
  const request = event.request
  if (request.method !== 'GET') return
  const url = new URL(request.url)
  const isTile = TILE_HOSTS.some((host) => url.hostname.endsWith(host))

  if (isTile) {
    event.respondWith((async () => {
      const cache = await caches.open(TILE_CACHE)
      const cached = await cache.match(request)
      if (cached) return cached
      try {
        const response = await fetch(request)
        if (response.ok || response.type === 'opaque') {
          await cache.put(request, response.clone())
          trimCache(TILE_CACHE, 350)
        }
        return response
      } catch {
        return new Response('', { status: 504, statusText: 'Offline tile unavailable' })
      }
    })())
    return
  }

  if (request.mode === 'navigate') {
    event.respondWith((async () => {
      try {
        const response = await fetch(request)
        const cache = await caches.open(SHELL_CACHE)
        await cache.put('/index.html', response.clone())
        return response
      } catch {
        return (await caches.match('/index.html')) || (await caches.match('/offline.html'))
      }
    })())
    return
  }

  if (url.origin === self.location.origin && !url.pathname.endsWith('/sw.js')) {
    event.respondWith((async () => {
      const cached = await caches.match(request)
      const network = fetch(request).then(async (response) => {
        if (response.ok) {
          const cache = await caches.open(SHELL_CACHE)
          await cache.put(request, response.clone())
        }
        return response
      }).catch(() => cached)
      return cached || network
    })())
  }
})
