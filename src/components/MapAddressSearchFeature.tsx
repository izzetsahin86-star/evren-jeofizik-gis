import { useEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import L, { type Map as LeafletMap, type Marker as LeafletMarker } from 'leaflet'
import { MapPin, Search, X } from 'lucide-react'

const MAP_READY_EVENT = 'evren-map-address-search-ready'
const MAX_RESULTS = 8
const AUTOCOMPLETE_DELAY = 400

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
  type: 'Feature'
  geometry?: { type?: string; coordinates?: number[] }
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

function installMapCaptureHook() {
  if (hookInstalled) return
  hookInstalled = true
  L.Map.addInitHook(function captureAddressSearchMap(this: LeafletMap) {
    capturedMap = this
    window.dispatchEvent(new CustomEvent(MAP_READY_EVENT))
    this.once('unload', () => {
      if (capturedMap === this) capturedMap = null
    })
  })
}

installMapCaptureHook()

function parseCoordinateQuery(value: string) {
  const matches = value.trim().match(/^\s*([-+]?\d{1,3}(?:[.,]\d+)?)\s*[,;\s]\s*([-+]?\d{1,3}(?:[.,]\d+)?)\s*$/)
  if (!matches) return null
  const lat = Number(matches[1].replace(',', '.'))
  const lng = Number(matches[2].replace(',', '.'))
  if (!Number.isFinite(lat) || !Number.isFinite(lng) || Math.abs(lat) > 90 || Math.abs(lng) > 180) return null
  return { lat, lng }
}

function resultZoom(kind: string) {
  const type = kind.toLowerCase()
  if (type === 'ülke') return 6
  if (type === 'bölge' || type === 'il') return 9
  if (type === 'ilçe') return 11
  if (type === 'şehir') return 13
  if (type === 'köy' || type === 'mahalle' || type === 'semt') return 15
  if (type === 'sokak' || type === 'yol') return 16
  return 17
}

function resultKind(type?: string) {
  const value = (type || '').toLowerCase()
  const labels: Record<string, string> = {
    country: 'Ülke', state: 'İl', county: 'İlçe', city: 'Şehir', district: 'İlçe',
    locality: 'Mahalle', house: 'Adres', street: 'Sokak', other: 'Yer',
  }
  return labels[value] || 'Yer'
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

function cacheKey(query: string, map: LeafletMap) {
  const center = map.getCenter()
  return `${query.trim().toLocaleLowerCase('tr-TR')}|${center.lat.toFixed(2)},${center.lng.toFixed(2)}|${Math.round(map.getZoom())}`
}

function hideLegacyAddressCard() {
  document.querySelectorAll<HTMLElement>('.panel-card').forEach((card) => {
    const title = card.querySelector('h2')?.textContent?.trim()
    if (title === 'Adres Ara') card.style.display = 'none'
  })
}

export default function MapAddressSearchFeature() {
  const [map, setMap] = useState<LeafletMap | null>(() => capturedMap)
  const [host, setHost] = useState<HTMLElement | null>(null)
  const [open, setOpen] = useState(false)
  const [query, setQuery] = useState('')
  const [results, setResults] = useState<SearchResult[]>([])
  const [searching, setSearching] = useState(false)
  const [message, setMessage] = useState('')
  const [expanded, setExpanded] = useState(false)
  const rootRef = useRef<HTMLDivElement | null>(null)
  const inputRef = useRef<HTMLInputElement | null>(null)
  const markerRef = useRef<LeafletMarker | null>(null)
  const cacheRef = useRef<Map<string, SearchResult[]>>(new Map())
  const abortRef = useRef<AbortController | null>(null)

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
    if (!open) return
    const timer = window.setTimeout(() => inputRef.current?.focus(), 30)
    return () => window.clearTimeout(timer)
  }, [open])

  useEffect(() => {
    const onPointerDown = (event: PointerEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) {
        setExpanded(false)
        setOpen(false)
      }
    }
    document.addEventListener('pointerdown', onPointerDown)
    return () => document.removeEventListener('pointerdown', onPointerDown)
  }, [])

  useEffect(() => () => {
    abortRef.current?.abort()
    markerRef.current?.remove()
  }, [])

  const grouped = useMemo(() => ({
    main: results.filter((item) => item.inView),
    other: results.filter((item) => !item.inView),
  }), [results])

  const showTarget = (lat: number, lng: number, title: string) => {
    if (!map) return
    markerRef.current?.remove()
    const icon = L.divIcon({
      className: 'address-search-marker-wrap',
      html: '<span class="address-search-marker">⌖</span>',
      iconSize: [34, 38],
      iconAnchor: [17, 34],
    })
    markerRef.current = L.marker([lat, lng], { icon, title }).addTo(map).bindTooltip(title, { direction: 'top', offset: [0, -26] }).openTooltip()
  }

  const chooseResult = (result: SearchResult) => {
    if (!map) return
    map.flyTo([result.lat, result.lng], Math.max(map.getZoom(), resultZoom(result.kind)), { duration: 0.8 })
    showTarget(result.lat, result.lng, result.name)
    setQuery(result.name)
    setExpanded(false)
    setMessage('')
    setOpen(false)
  }

  const fetchSuggestions = async (value: string, controller?: AbortController) => {
    if (!map || value.trim().length < 3) return
    const key = cacheKey(value, map)
    const cached = cacheRef.current.get(key)
    if (cached) {
      setResults(cached)
      setExpanded(true)
      setMessage(cached.length ? '' : 'Sonuç bulunamadı.')
      return
    }

    setSearching(true)
    setMessage('')
    try {
      const center = map.getCenter()
      const params = new URLSearchParams({
        q: value.trim(),
        limit: String(MAX_RESULTS),
        lang: 'tr',
        lat: String(center.lat),
        lon: String(center.lng),
        zoom: String(Math.round(map.getZoom())),
      })
      const response = await fetch(`https://photon.komoot.io/api/?${params.toString()}`, { signal: controller?.signal })
      if (!response.ok) throw new Error('Arama hizmeti yanıt vermedi.')
      const payload = await response.json() as { features?: PhotonFeature[] }
      const bounds = map.getBounds()
      const normalized = (payload.features || []).flatMap((feature, index) => {
        const coordinates = feature.geometry?.coordinates
        const properties = feature.properties || {}
        const lng = Number(coordinates?.[0])
        const lat = Number(coordinates?.[1])
        if (!Number.isFinite(lat) || !Number.isFinite(lng)) return []
        const id = `${properties.osm_type || 'osm'}-${properties.osm_id || index}-${lat}-${lng}`
        return [{
          id,
          lat,
          lng,
          name: featureName(properties),
          detail: featureDetail(properties),
          kind: resultKind(properties.type),
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
      setMessage('Adres bulunamadı veya arama hizmetine ulaşılamadı.')
    } finally {
      if (!controller?.signal.aborted) setSearching(false)
    }
  }

  useEffect(() => {
    if (!open || !map) return
    const value = query.trim()
    const coordinate = parseCoordinateQuery(value)
    if (coordinate) {
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

    const timer = window.setTimeout(() => {
      abortRef.current?.abort()
      const controller = new AbortController()
      abortRef.current = controller
      void fetchSuggestions(value, controller)
    }, AUTOCOMPLETE_DELAY)

    return () => window.clearTimeout(timer)
  }, [query, open, map])

  const runSearch = async () => {
    if (!map) {
      setMessage('Harita henüz hazır değil.')
      return
    }
    const value = query.trim()
    if (!value) return

    const coordinate = parseCoordinateQuery(value)
    if (coordinate) {
      map.flyTo([coordinate.lat, coordinate.lng], 17, { duration: 0.8 })
      showTarget(coordinate.lat, coordinate.lng, `${coordinate.lat.toFixed(6)}, ${coordinate.lng.toFixed(6)}`)
      setResults([])
      setExpanded(false)
      setMessage('')
      setOpen(false)
      return
    }

    if (value.length < 3) {
      setMessage('Öneriler için en az 3 harf yazın.')
      setExpanded(true)
      return
    }

    abortRef.current?.abort()
    const controller = new AbortController()
    abortRef.current = controller
    await fetchSuggestions(value, controller)
  }

  const clearSearch = () => {
    abortRef.current?.abort()
    setQuery('')
    setResults([])
    setMessage('')
    setExpanded(false)
    setSearching(false)
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
    <div ref={rootRef} className={`map-address-search${open ? ' is-open' : ''}${expanded ? ' has-results' : ''}`}>
      <style>{`
        .map-address-search{position:absolute;z-index:900;top:14px;left:50%;transform:translateX(-50%);width:38px;font-family:Inter,system-ui,sans-serif;color:#172033;transition:width .18s ease}
        .map-address-search.is-open{width:min(330px,calc(100vw - 300px));min-width:250px}
        .map-address-toggle{width:38px;height:38px;display:grid;place-items:center;border:1px solid rgba(148,163,184,.5);border-radius:12px;background:rgba(255,255,255,.97);color:#334155;box-shadow:0 6px 18px rgba(15,23,42,.16);backdrop-filter:blur(12px);cursor:pointer}
        .map-address-box{height:38px;display:flex;align-items:center;gap:5px;padding:0 5px 0 10px;border:1px solid rgba(148,163,184,.5);border-radius:12px;background:rgba(255,255,255,.98);box-shadow:0 6px 18px rgba(15,23,42,.16);backdrop-filter:blur(12px)}
        .map-address-box>svg{flex:0 0 auto;color:#64748b}.map-address-box input{min-width:0;flex:1;height:100%;border:0;outline:0;background:transparent;color:#172033;font-size:10px;font-weight:650}.map-address-box input::placeholder{color:#94a3b8;font-weight:500}
        .map-address-action,.map-address-clear{width:27px;height:27px;display:grid;place-items:center;flex:0 0 auto;border:0;border-radius:8px;cursor:pointer}.map-address-action{background:#2563eb;color:#fff}.map-address-action:disabled{opacity:.55;cursor:wait}.map-address-clear{background:#f1f5f9;color:#64748b}
        .map-address-results{margin-top:5px;overflow:hidden;max-height:min(46vh,360px);overflow-y:auto;border:1px solid #dce5ee;border-radius:12px;background:rgba(255,255,255,.99);box-shadow:0 12px 30px rgba(15,23,42,.19);backdrop-filter:blur(14px)}
        .map-address-group+.map-address-group{border-top:1px solid #e8eef4}.map-address-group>header{height:25px;display:flex;align-items:center;justify-content:space-between;padding:0 9px;color:#64748b;background:#f8fafc;font-size:7px;font-weight:900;text-transform:uppercase;letter-spacing:.05em}.map-address-group>header span{min-width:17px;padding:1px 5px;border-radius:999px;background:#e2e8f0;text-align:center;color:#475569}
        .map-address-result{width:100%;min-height:42px;display:grid;grid-template-columns:25px minmax(0,1fr) auto;align-items:center;gap:7px;padding:6px 8px;border:0;border-top:1px solid #f0f3f7;background:#fff;text-align:left;cursor:pointer}.map-address-result:hover{background:#f8fbff}.map-address-result-icon{width:25px;height:25px;display:grid;place-items:center;border-radius:8px;background:#eff6ff;color:#2563eb}.map-address-result-copy{min-width:0}.map-address-result-copy strong{display:block;overflow:hidden;color:#1e293b;font-size:9px;white-space:nowrap;text-overflow:ellipsis}.map-address-result-copy small{display:block;overflow:hidden;margin-top:1px;color:#7c8ba0;font-size:7px;line-height:1.3;white-space:nowrap;text-overflow:ellipsis}.map-address-result em{padding:3px 5px;border-radius:999px;background:#f1f5f9;color:#64748b;font-size:6.5px;font-style:normal;font-weight:800}
        .map-address-message{padding:9px 10px;color:#64748b;font-size:8px;text-align:center}.map-address-attribution{padding:5px 8px;border-top:1px solid #edf1f5;color:#94a3b8;background:#fbfdff;font-size:6.5px;text-align:right}
        .address-search-marker-wrap{background:transparent!important;border:0!important}.address-search-marker{width:34px;height:34px;display:grid;place-items:center;border:3px solid #fff;border-radius:50% 50% 50% 10%;transform:rotate(-45deg);background:#2563eb;color:#fff;box-shadow:0 5px 14px rgba(15,23,42,.32);font-size:18px;font-weight:900}
        @media(max-width:760px){.map-address-search{top:10px;left:56px;transform:none}.map-address-search.is-open{width:min(286px,calc(100vw - 118px));min-width:0}.map-address-result{grid-template-columns:24px minmax(0,1fr)}.map-address-result em{display:none}.map-address-results{max-height:42vh}}
      `}</style>
      {!open ? (
        <button type="button" className="map-address-toggle" onClick={() => setOpen(true)} aria-label="Adres ara" title="Adres ara"><Search size={18} /></button>
      ) : (
        <>
          <div className="map-address-box">
            <Search size={14} />
            <input
              ref={inputRef}
              value={query}
              onFocus={() => results.length && setExpanded(true)}
              onChange={(event) => setQuery(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === 'Enter') void runSearch()
                if (event.key === 'Escape') { setExpanded(false); setOpen(false) }
              }}
              placeholder="Adres ara..."
              aria-label="Adres, yer adı veya koordinat ara"
            />
            {query && <button type="button" className="map-address-clear" onClick={clearSearch} aria-label="Aramayı temizle"><X size={13} /></button>}
            <button type="button" className="map-address-action" onClick={() => void runSearch()} disabled={searching} aria-label="Adres ara"><Search size={13} /></button>
          </div>
          {expanded && (
            <div className="map-address-results">
              {renderGroup('Ana Sonuçlar', grouped.main)}
              {renderGroup('Diğer Sonuçlar', grouped.other)}
              {message && <div className="map-address-message">{message}</div>}
              <div className="map-address-attribution">© OpenStreetMap contributors · Photon</div>
            </div>
          )}
        </>
      )}
    </div>,
    host,
  )
}
