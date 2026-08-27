import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import L, { type Map as LeafletMap, type Marker as LeafletMarker } from 'leaflet'
import { MapPin, Search, X } from 'lucide-react'

const MAP_READY_EVENT = 'evren-map-address-search-v2-ready'
const AUTOCOMPLETE_DELAY = 350
const MAX_RESULTS = 8

type PhotonProperties = {
  osm_id?: number
  osm_type?: string
  name?: string
  type?: string
  country?: string
  state?: string
  county?: string
  city?: string
  district?: string
  locality?: string
  street?: string
  housenumber?: string
  postcode?: string
}

type PhotonFeature = {
  geometry?: { coordinates?: number[] }
  properties?: PhotonProperties
}

type SearchResult = {
  id: string
  lat: number
  lng: number
  name: string
  detail: string
  kind: string
  inView: boolean
}

let capturedMap: LeafletMap | null = null
let hookInstalled = false

function installMapHook() {
  if (hookInstalled) return
  hookInstalled = true
  L.Map.addInitHook(function captureMap(this: LeafletMap) {
    // Leaflet init hooks intentionally expose the map instance through `this`.
    // eslint-disable-next-line @typescript-eslint/no-this-alias
    capturedMap = this
    window.dispatchEvent(new CustomEvent(MAP_READY_EVENT))
    this.once('unload', () => {
      if (capturedMap === this) capturedMap = null
    })
  })
}

installMapHook()

function parseCoordinate(value: string) {
  const match = value.trim().match(/^\s*([-+]?\d{1,3}(?:[.,]\d+)?)\s*[,;\s]\s*([-+]?\d{1,3}(?:[.,]\d+)?)\s*$/)
  if (!match) return null
  const lat = Number(match[1].replace(',', '.'))
  const lng = Number(match[2].replace(',', '.'))
  if (!Number.isFinite(lat) || !Number.isFinite(lng) || Math.abs(lat) > 90 || Math.abs(lng) > 180) return null
  return { lat, lng }
}

function kindLabel(type?: string) {
  const labels: Record<string, string> = {
    country: 'Ülke', state: 'İl', county: 'İlçe', city: 'Şehir', district: 'İlçe',
    locality: 'Mahalle', street: 'Sokak', house: 'Adres', other: 'Yer',
  }
  return labels[(type || '').toLowerCase()] || 'Yer'
}

function zoomFor(kind: string) {
  if (kind === 'Ülke') return 6
  if (kind === 'İl') return 9
  if (kind === 'İlçe') return 11
  if (kind === 'Şehir') return 13
  if (kind === 'Mahalle') return 15
  if (kind === 'Sokak') return 16
  return 17
}

function featureName(properties: PhotonProperties) {
  return properties.name || properties.street || properties.locality || properties.district || properties.city || properties.county || properties.state || properties.country || 'Sonuç'
}

function featureDetail(properties: PhotonProperties) {
  const street = [properties.street, properties.housenumber].filter(Boolean).join(' ')
  const parts = [street, properties.locality, properties.district, properties.city, properties.county, properties.state, properties.postcode, properties.country]
    .filter((value, index, array): value is string => Boolean(value) && array.indexOf(value) === index)
  return parts.join(', ') || featureName(properties)
}

function hideLegacyAddressCard() {
  document.querySelectorAll<HTMLElement>('.panel-card').forEach((card) => {
    if (card.querySelector('h2')?.textContent?.trim() === 'Adres Ara') card.style.display = 'none'
  })
}

export default function MapAddressSearchFeatureV2() {
  const [host, setHost] = useState<HTMLElement | null>(null)
  const [map, setMap] = useState<LeafletMap | null>(() => capturedMap)
  const [open, setOpen] = useState(false)
  const [query, setQuery] = useState('')
  const [results, setResults] = useState<SearchResult[]>([])
  const [expanded, setExpanded] = useState(false)
  const [searching, setSearching] = useState(false)
  const [message, setMessage] = useState('')
  const [anchor, setAnchor] = useState({ left: 16, top: 64 })
  const rootRef = useRef<HTMLDivElement | null>(null)
  const inputRef = useRef<HTMLInputElement | null>(null)
  const markerRef = useRef<LeafletMarker | null>(null)
  const abortRef = useRef<AbortController | null>(null)
  const cacheRef = useRef<Map<string, SearchResult[]>>(new Map())

  useEffect(() => {
    const discover = () => {
      setHost(document.querySelector<HTMLElement>('.map-shell'))
      if (capturedMap) setMap(capturedMap)
      hideLegacyAddressCard()
    }
    discover()
    window.addEventListener(MAP_READY_EVENT, discover)
    const observer = new MutationObserver(discover)
    observer.observe(document.body, { childList: true, subtree: true })
    return () => {
      window.removeEventListener(MAP_READY_EVENT, discover)
      observer.disconnect()
    }
  }, [])

  useEffect(() => {
    if (!host) return
    const coordinateStack = host.querySelector<HTMLElement>('.coordinate-stack')
    if (!coordinateStack) return
    let frame = 0

    const updateAnchor = () => {
      window.cancelAnimationFrame(frame)
      frame = window.requestAnimationFrame(() => {
        const hostRect = host.getBoundingClientRect()
        const stackRect = coordinateStack.getBoundingClientRect()
        const next = {
          left: Math.max(8, Math.round(stackRect.left - hostRect.left)),
          top: Math.max(8, Math.round(stackRect.bottom - hostRect.top + 6)),
        }
        setAnchor((current) => current.left === next.left && current.top === next.top ? current : next)
      })
    }

    updateAnchor()
    const resizeObserver = new ResizeObserver(updateAnchor)
    resizeObserver.observe(host)
    resizeObserver.observe(coordinateStack)
    const mutationObserver = new MutationObserver(updateAnchor)
    mutationObserver.observe(coordinateStack, { childList: true, subtree: true, attributes: true })
    mutationObserver.observe(host, { attributes: true, attributeFilter: ['style', 'class'] })
    window.addEventListener('resize', updateAnchor)

    return () => {
      window.cancelAnimationFrame(frame)
      resizeObserver.disconnect()
      mutationObserver.disconnect()
      window.removeEventListener('resize', updateAnchor)
    }
  }, [host])

  useEffect(() => {
    if (!open) return
    const timer = window.setTimeout(() => inputRef.current?.focus(), 30)
    return () => window.clearTimeout(timer)
  }, [open])

  useEffect(() => {
    const closeOutside = (event: PointerEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) {
        setOpen(false)
        setExpanded(false)
      }
    }
    document.addEventListener('pointerdown', closeOutside)
    return () => document.removeEventListener('pointerdown', closeOutside)
  }, [])

  useEffect(() => () => {
    abortRef.current?.abort()
    markerRef.current?.remove()
  }, [])

  const grouped = useMemo(() => ({
    main: results.filter((result) => result.inView),
    other: results.filter((result) => !result.inView),
  }), [results])

  const showTarget = (lat: number, lng: number, title: string) => {
    if (!map) return
    markerRef.current?.remove()
    markerRef.current = L.marker([lat, lng], {
      title,
      icon: L.divIcon({
        className: 'address-search-marker-wrap',
        html: '<span class="address-search-marker">⌖</span>',
        iconSize: [34, 38],
        iconAnchor: [17, 34],
      }),
    }).addTo(map).bindTooltip(title, { direction: 'top', offset: [0, -26] }).openTooltip()
  }

  const chooseResult = (result: SearchResult) => {
    if (!map) return
    map.flyTo([result.lat, result.lng], Math.max(map.getZoom(), zoomFor(result.kind)), { duration: 0.8 })
    showTarget(result.lat, result.lng, result.name)
    setQuery(result.name)
    setOpen(false)
    setExpanded(false)
    setMessage('')
  }

  const fetchSuggestions = useCallback(async (value: string, immediate = false) => {
    if (!map || value.trim().length < 3) return
    const center = map.getCenter()
    const key = `${value.trim().toLocaleLowerCase('tr-TR')}|${center.lat.toFixed(2)},${center.lng.toFixed(2)}|${Math.round(map.getZoom())}`
    const cached = cacheRef.current.get(key)
    if (cached) {
      setResults(cached)
      setExpanded(true)
      setMessage(cached.length ? '' : 'Sonuç bulunamadı.')
      return
    }

    abortRef.current?.abort()
    const controller = new AbortController()
    abortRef.current = controller
    setSearching(true)
    setMessage('')

    try {
      const params = new URLSearchParams({
        q: value.trim(),
        limit: String(MAX_RESULTS),
        lat: String(center.lat),
        lon: String(center.lng),
        zoom: String(Math.round(map.getZoom())),
      })
      const response = await fetch(`/api/address-search?${params.toString()}`, { signal: controller.signal })
      if (!response.ok) throw new Error('Arama hizmeti yanıt vermedi.')
      const payload = await response.json() as { features?: PhotonFeature[] }
      const bounds = map.getBounds()
      const normalized = (payload.features || []).flatMap((feature, index) => {
        const coordinates = feature.geometry?.coordinates
        const properties = feature.properties || {}
        const lng = Number(coordinates?.[0])
        const lat = Number(coordinates?.[1])
        if (!Number.isFinite(lat) || !Number.isFinite(lng)) return []
        return [{
          id: `${properties.osm_type || 'osm'}-${properties.osm_id || index}-${lat}-${lng}`,
          lat,
          lng,
          name: featureName(properties),
          detail: featureDetail(properties),
          kind: kindLabel(properties.type),
          inView: bounds.contains([lat, lng]),
        }]
      }).sort((a, b) => Number(b.inView) - Number(a.inView))

      cacheRef.current.set(key, normalized)
      setResults(normalized)
      setExpanded(true)
      setMessage(normalized.length ? '' : 'Sonuç bulunamadı.')
    } catch (error) {
      if (error instanceof DOMException && error.name === 'AbortError') return
      setResults([])
      setExpanded(true)
      setMessage('Öneri hizmetine ulaşılamadı. Tekrar deneyin.')
    } finally {
      if (!controller.signal.aborted) setSearching(false)
    }

    if (immediate) inputRef.current?.focus()
  }, [map])

  useEffect(() => {
    if (!open || !map) return
    const value = query.trim()
    if (parseCoordinate(value)) {
      setResults([])
      setExpanded(false)
      setMessage('')
      return
    }
    if (value.length < 3) {
      abortRef.current?.abort()
      setResults([])
      setExpanded(false)
      setSearching(false)
      setMessage('')
      return
    }

    const timer = window.setTimeout(() => void fetchSuggestions(value), AUTOCOMPLETE_DELAY)
    return () => window.clearTimeout(timer)
  }, [query, open, map, fetchSuggestions])

  const runSearch = async () => {
    if (!map) return
    const value = query.trim()
    if (!value) return
    const coordinate = parseCoordinate(value)
    if (coordinate) {
      map.flyTo([coordinate.lat, coordinate.lng], 17, { duration: 0.8 })
      showTarget(coordinate.lat, coordinate.lng, `${coordinate.lat.toFixed(6)}, ${coordinate.lng.toFixed(6)}`)
      setOpen(false)
      setExpanded(false)
      return
    }
    if (value.length < 3) {
      setMessage('Öneriler için en az 3 harf yazın.')
      setExpanded(true)
      return
    }
    await fetchSuggestions(value, true)
  }

  const clearSearch = () => {
    abortRef.current?.abort()
    setQuery('')
    setResults([])
    setExpanded(false)
    setSearching(false)
    setMessage('')
    markerRef.current?.remove()
    markerRef.current = null
    inputRef.current?.focus()
  }

  if (!host) return null

  const renderGroup = (title: string, items: SearchResult[]) => items.length ? (
    <section className="map-address-group">
      <header>{title}<span>{items.length}</span></header>
      {items.map((result) => (
        <button type="button" className="map-address-result" key={result.id} onClick={() => chooseResult(result)}>
          <span className="map-address-result-icon"><MapPin size={14} /></span>
          <span className="map-address-result-copy"><strong>{result.name}</strong><small>{result.detail}</small></span>
          <em>{result.kind}</em>
        </button>
      ))}
    </section>
  ) : null

  return createPortal(
    <div ref={rootRef} className={`map-address-search${open ? ' is-open' : ''}${expanded ? ' has-results' : ''}`} style={{ left: anchor.left, top: anchor.top }}>
      <style>{`
        .map-address-search{position:absolute;z-index:900;width:38px;font-family:Inter,system-ui,sans-serif;color:#172033;transition:width .16s ease,top .16s ease}
        .map-address-search.is-open{width:min(330px,calc(100vw - 300px));min-width:250px}
        .map-address-toggle{width:38px;height:38px;display:grid;place-items:center;border:1px solid rgba(148,163,184,.55);border-radius:12px;background:rgba(255,255,255,.97);color:#334155;box-shadow:0 4px 12px rgba(15,23,42,.2);cursor:pointer}
        .map-address-box{height:38px;display:flex;align-items:center;gap:5px;padding:0 5px 0 10px;border:1px solid rgba(148,163,184,.55);border-radius:12px;background:rgba(255,255,255,.98);box-shadow:0 4px 12px rgba(15,23,42,.2)}
        .map-address-box>svg{color:#64748b;flex:0 0 auto}.map-address-box input{min-width:0;flex:1;height:100%;border:0;outline:0;background:transparent;color:#172033;font-size:10px;font-weight:650}.map-address-box input::placeholder{color:#94a3b8}
        .map-address-action,.map-address-clear{width:27px;height:27px;display:grid;place-items:center;flex:0 0 auto;border:0;border-radius:8px;cursor:pointer}.map-address-action{background:#2563eb;color:white}.map-address-action:disabled{opacity:.5}.map-address-clear{background:#f1f5f9;color:#64748b}
        .map-address-results{margin-top:5px;max-height:min(46vh,360px);overflow-y:auto;border:1px solid #dce5ee;border-radius:12px;background:rgba(255,255,255,.99);box-shadow:0 12px 30px rgba(15,23,42,.18)}
        .map-address-group+.map-address-group{border-top:1px solid #e8eef4}.map-address-group>header{height:25px;display:flex;align-items:center;justify-content:space-between;padding:0 9px;background:#f8fafc;color:#64748b;font-size:7px;font-weight:900;text-transform:uppercase}.map-address-group>header span{padding:1px 5px;border-radius:999px;background:#e2e8f0}
        .map-address-result{width:100%;min-height:42px;display:grid;grid-template-columns:25px minmax(0,1fr) auto;align-items:center;gap:7px;padding:6px 8px;border:0;border-top:1px solid #f0f3f7;background:#fff;text-align:left;cursor:pointer}.map-address-result:hover{background:#f8fbff}.map-address-result-icon{width:25px;height:25px;display:grid;place-items:center;border-radius:8px;background:#eff6ff;color:#2563eb}.map-address-result-copy{min-width:0}.map-address-result-copy strong,.map-address-result-copy small{display:block;overflow:hidden;white-space:nowrap;text-overflow:ellipsis}.map-address-result-copy strong{font-size:9.5px}.map-address-result-copy small{margin-top:2px;color:#7c8ba0;font-size:7px}.map-address-result em{padding:3px 5px;border-radius:999px;background:#f1f5f9;color:#64748b;font-size:7px;font-style:normal;font-weight:800}
        .map-address-message{padding:9px 10px;color:#64748b;font-size:8px;text-align:center}.map-address-attribution{padding:5px 8px;border-top:1px solid #edf1f5;background:#fbfdff;color:#94a3b8;font-size:6.5px;text-align:right}
        .address-search-marker-wrap{background:transparent!important;border:0!important}.address-search-marker{width:34px;height:34px;display:grid;place-items:center;border:3px solid #fff;border-radius:50% 50% 50% 10%;transform:rotate(-45deg);background:#2563eb;color:#fff;box-shadow:0 5px 14px rgba(15,23,42,.32);font-size:18px;font-weight:900}
        @media(max-width:760px){.map-address-search.is-open{width:min(300px,calc(100vw - 32px));min-width:220px}.map-address-result{grid-template-columns:25px minmax(0,1fr)}.map-address-result em{display:none}}
      `}</style>
      {!open ? (
        <button type="button" className="map-address-toggle" onClick={() => setOpen(true)} aria-label="Adres ara" title="Adres ara"><Search size={17} /></button>
      ) : (
        <>
          <div className="map-address-box">
            <Search size={15} />
            <input ref={inputRef} value={query} onChange={(event) => setQuery(event.target.value)} onFocus={() => results.length && setExpanded(true)} onKeyDown={(event) => { if (event.key === 'Enter') void runSearch(); if (event.key === 'Escape') { setOpen(false); setExpanded(false) } }} placeholder="Adres" aria-label="Adres, yer adı veya koordinat ara" />
            {query && <button type="button" className="map-address-clear" onClick={clearSearch} aria-label="Temizle"><X size={13} /></button>}
            <button type="button" className="map-address-action" onClick={() => void runSearch()} disabled={searching} aria-label="Ara"><Search size={13} /></button>
          </div>
          {expanded && <div className="map-address-results">
            {renderGroup('Ana Sonuçlar', grouped.main)}
            {renderGroup('Diğer Sonuçlar', grouped.other)}
            {message && <div className="map-address-message">{message}</div>}
            <div className="map-address-attribution">Arama: Photon · OpenStreetMap</div>
          </div>}
        </>
      )}
    </div>,
    host,
  )
}
