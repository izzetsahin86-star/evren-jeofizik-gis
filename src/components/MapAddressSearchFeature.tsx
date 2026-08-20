import { useEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import L, { type Map as LeafletMap, type Marker as LeafletMarker } from 'leaflet'
import { MapPin, Search, X } from 'lucide-react'

const MAP_READY_EVENT = 'evren-map-address-search-ready'
const MAX_RESULTS = 10

type SearchResult = {
  place_id: number
  lat: string
  lon: string
  display_name: string
  type?: string
  addresstype?: string
  importance?: number
  boundingbox?: string[]
  address?: Record<string, string>
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

function resultZoom(result: SearchResult) {
  const type = (result.addresstype || result.type || '').toLowerCase()
  if (['country'].includes(type)) return 6
  if (['state', 'province', 'region'].includes(type)) return 8
  if (['county', 'district'].includes(type)) return 10
  if (['city', 'town', 'municipality'].includes(type)) return 13
  if (['village', 'suburb', 'neighbourhood', 'quarter'].includes(type)) return 15
  if (['road', 'street', 'highway'].includes(type)) return 16
  return 17
}

function resultKind(result: SearchResult) {
  const type = (result.addresstype || result.type || '').toLowerCase()
  const labels: Record<string, string> = {
    country: 'Ülke', state: 'Bölge', province: 'İl', region: 'Bölge', county: 'İlçe', district: 'İlçe',
    city: 'Şehir', town: 'Şehir', municipality: 'Belediye', village: 'Köy', suburb: 'Semt', neighbourhood: 'Mahalle',
    quarter: 'Mahalle', road: 'Yol', street: 'Sokak', highway: 'Yol', house: 'Adres', building: 'Yapı', amenity: 'Yer',
  }
  return labels[type] || 'Yer'
}

function shortName(result: SearchResult) {
  const address = result.address || {}
  return address.amenity || address.building || address.shop || address.tourism || address.road || address.neighbourhood || address.suburb || address.village || address.town || address.city || result.display_name.split(',')[0] || 'Sonuç'
}

function cacheKey(query: string, map: LeafletMap) {
  const bounds = map.getBounds()
  const rounded = [bounds.getWest(), bounds.getNorth(), bounds.getEast(), bounds.getSouth()].map((value) => value.toFixed(2)).join(',')
  return `${query.trim().toLocaleLowerCase('tr-TR')}|${rounded}`
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
  const [query, setQuery] = useState('')
  const [results, setResults] = useState<SearchResult[]>([])
  const [searching, setSearching] = useState(false)
  const [message, setMessage] = useState('')
  const [expanded, setExpanded] = useState(false)
  const rootRef = useRef<HTMLDivElement | null>(null)
  const markerRef = useRef<LeafletMarker | null>(null)
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
    const onPointerDown = (event: PointerEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) setExpanded(false)
    }
    document.addEventListener('pointerdown', onPointerDown)
    return () => document.removeEventListener('pointerdown', onPointerDown)
  }, [])

  useEffect(() => () => {
    if (markerRef.current) markerRef.current.remove()
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
    const lat = Number(result.lat)
    const lng = Number(result.lon)
    if (!Number.isFinite(lat) || !Number.isFinite(lng)) return
    const zoom = Math.max(map.getZoom(), resultZoom(result))
    map.flyTo([lat, lng], Math.min(18, zoom), { duration: 0.8 })
    showTarget(lat, lng, shortName(result))
    setQuery(result.display_name)
    setExpanded(false)
    setMessage('')
  }

  const runSearch = async () => {
    if (!map) {
      setMessage('Harita henüz hazır değil.')
      return
    }
    const value = query.trim()
    if (!value) {
      setResults([])
      setExpanded(false)
      return
    }

    const coordinate = parseCoordinateQuery(value)
    if (coordinate) {
      map.flyTo([coordinate.lat, coordinate.lng], 17, { duration: 0.8 })
      showTarget(coordinate.lat, coordinate.lng, `${coordinate.lat.toFixed(6)}, ${coordinate.lng.toFixed(6)}`)
      setResults([])
      setExpanded(false)
      setMessage('')
      return
    }

    if (value.length < 2) {
      setMessage('En az 2 karakter yazın.')
      return
    }

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
      const bounds = map.getBounds()
      const params = new URLSearchParams({
        format: 'jsonv2',
        addressdetails: '1',
        limit: String(MAX_RESULTS),
        q: value,
        'accept-language': 'tr',
        viewbox: `${bounds.getWest()},${bounds.getNorth()},${bounds.getEast()},${bounds.getSouth()}`,
        bounded: '0',
      })
      const response = await fetch(`https://nominatim.openstreetmap.org/search?${params.toString()}`)
      if (!response.ok) throw new Error('Arama hizmeti yanıt vermedi.')
      const raw = await response.json() as Omit<SearchResult, 'inView'>[]
      const normalized = (Array.isArray(raw) ? raw : []).map((item) => {
        const lat = Number(item.lat)
        const lng = Number(item.lon)
        return {
          ...item,
          inView: Number.isFinite(lat) && Number.isFinite(lng) ? bounds.contains([lat, lng]) : false,
        }
      }).sort((a, b) => Number(b.inView) - Number(a.inView) || Number(b.importance || 0) - Number(a.importance || 0))
      cacheRef.current.set(key, normalized)
      setResults(normalized)
      setExpanded(true)
      setMessage(normalized.length ? '' : 'Sonuç bulunamadı.')
    } catch {
      setResults([])
      setExpanded(true)
      setMessage('Adres bulunamadı veya arama hizmetine ulaşılamadı.')
    } finally {
      setSearching(false)
    }
  }

  const clearSearch = () => {
    setQuery('')
    setResults([])
    setMessage('')
    setExpanded(false)
    markerRef.current?.remove()
    markerRef.current = null
  }

  if (!host) return null

  const renderGroup = (title: string, items: SearchResult[]) => items.length ? (
    <section className="map-address-group">
      <header>{title}<span>{items.length}</span></header>
      {items.map((result) => (
        <button type="button" className="map-address-result" key={result.place_id} onClick={() => chooseResult(result)}>
          <span className="map-address-result-icon"><MapPin size={15} /></span>
          <span className="map-address-result-copy"><strong>{shortName(result)}</strong><small>{result.display_name}</small></span>
          <em>{resultKind(result)}</em>
        </button>
      ))}
    </section>
  ) : null

  return createPortal(
    <div ref={rootRef} className={`map-address-search${expanded ? ' is-expanded' : ''}`}>
      <style>{`
        .map-address-search{position:absolute;z-index:900;top:14px;left:50%;transform:translateX(-50%);width:min(410px,calc(100vw - 300px));min-width:270px;font-family:Inter,system-ui,sans-serif;color:#172033}
        .map-address-box{height:42px;display:flex;align-items:center;gap:8px;padding:0 7px 0 13px;border:1px solid rgba(148,163,184,.52);border-radius:14px;background:rgba(255,255,255,.97);box-shadow:0 7px 22px rgba(15,23,42,.16);backdrop-filter:blur(14px)}
        .map-address-box>svg{flex:0 0 auto;color:#64748b}.map-address-box input{min-width:0;flex:1;height:100%;border:0;outline:0;background:transparent;color:#172033;font-size:11px;font-weight:600}.map-address-box input::placeholder{color:#94a3b8;font-weight:500}
        .map-address-action{width:30px;height:30px;display:grid;place-items:center;flex:0 0 auto;border:0;border-radius:9px;background:#2563eb;color:#fff;cursor:pointer}.map-address-action:disabled{opacity:.55;cursor:wait}.map-address-clear{width:26px;height:26px;display:grid;place-items:center;flex:0 0 auto;border:0;border-radius:8px;background:#f1f5f9;color:#64748b;cursor:pointer}
        .map-address-results{margin-top:6px;overflow:hidden;border:1px solid #dce5ee;border-radius:14px;background:rgba(255,255,255,.985);box-shadow:0 14px 38px rgba(15,23,42,.2);backdrop-filter:blur(16px)}
        .map-address-group+ .map-address-group{border-top:1px solid #e8eef4}.map-address-group>header{height:28px;display:flex;align-items:center;justify-content:space-between;padding:0 10px;color:#64748b;background:#f8fafc;font-size:8px;font-weight:900;text-transform:uppercase;letter-spacing:.05em}.map-address-group>header span{min-width:19px;padding:2px 5px;border-radius:999px;background:#e2e8f0;text-align:center;color:#475569}
        .map-address-result{width:100%;min-height:48px;display:grid;grid-template-columns:28px minmax(0,1fr) auto;align-items:center;gap:8px;padding:7px 9px;border:0;border-top:1px solid #f0f3f7;background:#fff;text-align:left;cursor:pointer}.map-address-result:hover{background:#f8fbff}.map-address-result-icon{width:28px;height:28px;display:grid;place-items:center;border-radius:9px;background:#eff6ff;color:#2563eb}.map-address-result-copy{min-width:0}.map-address-result-copy strong{display:block;overflow:hidden;color:#1e293b;font-size:10px;white-space:nowrap;text-overflow:ellipsis}.map-address-result-copy small{display:block;overflow:hidden;margin-top:2px;color:#7c8ba0;font-size:7.5px;line-height:1.3;white-space:nowrap;text-overflow:ellipsis}.map-address-result em{padding:4px 6px;border-radius:999px;background:#f1f5f9;color:#64748b;font-size:7px;font-style:normal;font-weight:800}
        .map-address-message{padding:10px 12px;color:#64748b;font-size:9px;text-align:center}.map-address-attribution{padding:6px 9px;border-top:1px solid #edf1f5;color:#94a3b8;background:#fbfdff;font-size:7px;text-align:right}
        .address-search-marker-wrap{background:transparent!important;border:0!important}.address-search-marker{width:34px;height:34px;display:grid;place-items:center;border:3px solid #fff;border-radius:50% 50% 50% 10%;transform:rotate(-45deg);background:#2563eb;color:#fff;box-shadow:0 5px 14px rgba(15,23,42,.32);font-size:18px;font-weight:900}.address-search-marker::first-letter{transform:rotate(45deg)}
        @media(max-width:760px){.map-address-search{top:10px;width:calc(100vw - 112px);min-width:0;left:56px;transform:none}.map-address-box{height:40px;padding-left:10px}.map-address-result{grid-template-columns:26px minmax(0,1fr)}.map-address-result em{display:none}.map-address-results{max-height:50vh;overflow:auto}}
      `}</style>
      <div className="map-address-box">
        <Search size={17} />
        <input
          value={query}
          onFocus={() => results.length && setExpanded(true)}
          onChange={(event) => setQuery(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Enter') void runSearch()
            if (event.key === 'Escape') setExpanded(false)
          }}
          placeholder="Adres"
          aria-label="Adres, yer adı veya koordinat ara"
        />
        {query && <button type="button" className="map-address-clear" onClick={clearSearch} aria-label="Aramayı temizle"><X size={14} /></button>}
        <button type="button" className="map-address-action" onClick={() => void runSearch()} disabled={searching} aria-label="Adres ara"><Search size={15} /></button>
      </div>
      {expanded && (
        <div className="map-address-results">
          {renderGroup('Ana Sonuçlar', grouped.main)}
          {renderGroup('Diğer Sonuçlar', grouped.other)}
          {message && <div className="map-address-message">{message}</div>}
          <div className="map-address-attribution">Arama: © OpenStreetMap contributors · Nominatim</div>
        </div>
      )}
    </div>,
    host,
  )
}
