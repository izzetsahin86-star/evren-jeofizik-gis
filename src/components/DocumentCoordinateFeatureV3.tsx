import { useEffect, useMemo, useRef, useState, type ChangeEvent } from 'react'
import { createPortal } from 'react-dom'
import L, { type FeatureGroup, type Map as LeafletMap } from 'leaflet'
import { AlertTriangle, CheckCircle2, Eye, FileSearch, FileUp, Plus, ShieldCheck, SlidersHorizontal, X } from 'lucide-react'
import { scanCoordinateDocumentV31 } from '../documentCoordinatesV31'
import type { DocumentCoordinateCandidate, DocumentScanProgress, DocumentScanResult } from '../documentCoordinates'

const MAP_READY_EVENT = 'evren-document-coordinates-v31-map-ready'
const MAX_PREVIEW_POINTS = 1000

let capturedMap: LeafletMap | null = null
let hookInstalled = false

function installMapHook() {
  if (hookInstalled) return
  hookInstalled = true
  L.Map.addInitHook(function captureDocumentMap(this: LeafletMap) {
    capturedMap = this
    window.dispatchEvent(new CustomEvent(MAP_READY_EVENT))
    this.once('unload', () => {
      if (capturedMap === this) capturedMap = null
    })
  })
}

installMapHook()

function findCard(title: string) {
  return Array.from(document.querySelectorAll<HTMLElement>('.panel-card'))
    .find((card) => card.querySelector('h2')?.textContent?.trim() === title) ?? null
}

function setNativeValue(element: HTMLTextAreaElement, value: string) {
  const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')?.set
  if (setter) setter.call(element, value)
  else element.value = value
  element.dispatchEvent(new Event('input', { bubbles: true }))
  element.dispatchEvent(new Event('change', { bubbles: true }))
}

function markerColor(candidate: DocumentCoordinateCandidate) {
  if (candidate.confidenceLevel === 'high') return '#16a34a'
  if (candidate.confidenceLevel === 'medium') return '#d97706'
  return '#dc2626'
}

function confidenceText(candidate: DocumentCoordinateCandidate) {
  if (candidate.confidenceLevel === 'high') return 'Güvenli'
  if (candidate.confidenceLevel === 'medium') return 'Kontrol'
  return 'Düşük'
}

function wait(ms: number) {
  return new Promise((resolve) => window.setTimeout(resolve, ms))
}

export default function DocumentCoordinateFeatureV3() {
  const [host, setHost] = useState<HTMLElement | null>(null)
  const [map, setMap] = useState<LeafletMap | null>(() => capturedMap)
  const [scan, setScan] = useState<DocumentScanResult | null>(null)
  const [selectedIds, setSelectedIds] = useState<Set<string>>(() => new Set())
  const [busy, setBusy] = useState(false)
  const [progress, setProgress] = useState<DocumentScanProgress>({ percent: 0, label: '' })
  const [zone, setZone] = useState(36)
  const [hemisphere, setHemisphere] = useState<'N' | 'S'>('N')
  const [datum, setDatum] = useState('WGS84')
  const [filter, setFilter] = useState<'all' | 'safe' | 'review'>('all')
  const [status, setStatus] = useState<{ text: string; tone: 'success' | 'error' | 'info' } | null>(null)
  const layerRef = useRef<FeatureGroup | null>(null)
  const legacyRef = useRef<HTMLElement | null>(null)

  useEffect(() => {
    const discover = () => {
      const stack = document.querySelector<HTMLElement>('.workspace-panel-scroll .panel-stack')
      const legacy = findCard('Belgeden Koordinat Al')
      if (!stack || !legacy) {
        setHost(null)
        return
      }
      legacyRef.current = legacy
      legacy.style.display = 'none'
      let mount = stack.querySelector<HTMLElement>('[data-document-coordinate-v3-host]')
      if (!mount) {
        mount = document.createElement('div')
        mount.dataset.documentCoordinateV3Host = 'true'
        stack.insertBefore(mount, legacy)
      }
      setHost(mount)
      if (capturedMap) setMap(capturedMap)
    }

    discover()
    window.addEventListener(MAP_READY_EVENT, discover)
    const observer = new MutationObserver(discover)
    observer.observe(document.body, { childList: true, subtree: true })
    return () => {
      observer.disconnect()
      window.removeEventListener(MAP_READY_EVENT, discover)
      if (legacyRef.current) legacyRef.current.style.display = ''
      document.querySelector('[data-document-coordinate-v3-host]')?.remove()
    }
  }, [])

  useEffect(() => {
    if (!map) return
    const layer = L.featureGroup().addTo(map)
    layerRef.current = layer
    return () => {
      layer.remove()
      layerRef.current = null
    }
  }, [map])

  const selectedCandidates = useMemo(
    () => scan?.candidates.filter((candidate) => selectedIds.has(candidate.id)) ?? [],
    [scan, selectedIds],
  )

  const filteredCandidates = useMemo(() => {
    if (!scan) return []
    if (filter === 'safe') return scan.candidates.filter((candidate) => candidate.confidenceLevel === 'high')
    if (filter === 'review') return scan.candidates.filter((candidate) => candidate.confidenceLevel !== 'high')
    return scan.candidates
  }, [scan, filter])

  useEffect(() => {
    const layer = layerRef.current
    if (!layer) return
    layer.clearLayers()
    selectedCandidates.slice(0, MAX_PREVIEW_POINTS).forEach((candidate, index) => {
      const marker = L.circleMarker([candidate.lat, candidate.lng], {
        radius: 6,
        color: '#ffffff',
        weight: 2,
        fillColor: markerColor(candidate),
        fillOpacity: 1,
      })
      marker.bindTooltip(`${candidate.name || `Nokta ${index + 1}`} · %${candidate.confidence}`, { direction: 'top' })
      marker.addTo(layer)
    })
  }, [selectedCandidates])

  useEffect(() => {
    if (!status) return
    const timer = window.setTimeout(() => setStatus(null), 5000)
    return () => window.clearTimeout(timer)
  }, [status])

  const fitPreview = () => {
    const layer = layerRef.current
    const targetMap = map ?? capturedMap
    if (!layer || !targetMap || !layer.getLayers().length) {
      setStatus({ text: 'Haritada gösterilecek seçili koordinat yok.', tone: 'info' })
      return
    }
    const bounds = layer.getBounds()
    if (bounds.isValid()) targetMap.fitBounds(bounds.pad(0.18), { maxZoom: 17, animate: true })
  }

  const scanFile = async (event: ChangeEvent<HTMLInputElement>) => {
    const input = event.target
    const file = input.files?.[0]
    if (!file) return
    setBusy(true)
    setScan(null)
    setSelectedIds(new Set())
    setFilter('all')
    setProgress({ percent: 1, label: 'Belge hazırlanıyor…' })
    setStatus({ text: 'Ruhsat tablosu, sütunlar ve koordinat sistemi analiz ediliyor.', tone: 'info' })
    try {
      const result = await scanCoordinateDocumentV31(file, { zone, hemisphere, datum }, setProgress)
      setScan(result)
      const safeIds = new Set(result.candidates.filter((candidate) => candidate.confidence >= 65).map((candidate) => candidate.id))
      setSelectedIds(safeIds)
      if (result.detection.zone) setZone(result.detection.zone)
      if (result.detection.hemisphere) setHemisphere(result.detection.hemisphere)
      if (result.detection.datum === 'ED50' || result.detection.datum === 'WGS84') setDatum(result.detection.datum)
      setStatus({
        text: result.candidates.length
          ? `${result.candidates.length} koordinat bulundu · ${result.stats.tableRows} ruhsat tablo noktası · ${result.stats.high} güvenli.`
          : 'Belgede koordinat bulunamadı.',
        tone: result.candidates.length ? 'success' : 'error',
      })
      window.setTimeout(() => {
        const layer = layerRef.current
        const targetMap = map ?? capturedMap
        if (!layer || !targetMap || !layer.getLayers().length) return
        const bounds = layer.getBounds()
        if (bounds.isValid()) targetMap.fitBounds(bounds.pad(0.18), { maxZoom: 17, animate: true })
      }, 250)
    } catch (error) {
      setStatus({ text: error instanceof Error ? error.message : 'Belge analiz edilemedi.', tone: 'error' })
    } finally {
      setBusy(false)
      input.value = ''
    }
  }

  const toggleCandidate = (id: string) => {
    setSelectedIds((current) => {
      const next = new Set(current)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }

  const selectSafe = () => {
    if (!scan) return
    setSelectedIds(new Set(scan.candidates.filter((candidate) => candidate.confidence >= 65).map((candidate) => candidate.id)))
  }

  const toggleAll = () => {
    if (!scan) return
    setSelectedIds((current) => current.size === scan.candidates.length ? new Set() : new Set(scan.candidates.map((candidate) => candidate.id)))
  }

  const clearResult = () => {
    setScan(null)
    setSelectedIds(new Set())
    setProgress({ percent: 0, label: '' })
    layerRef.current?.clearLayers()
  }

  const addSelectedToProject = async () => {
    if (!selectedCandidates.length) {
      setStatus({ text: 'Aktif poligona eklenecek koordinat seçin.', tone: 'error' })
      return
    }
    const bulkCard = findCard('Toplu Koordinat Ekle')
    if (!bulkCard) {
      setStatus({ text: 'Koordinat ekleme motoruna ulaşılamadı.', tone: 'error' })
      return
    }
    const latButton = Array.from(bulkCard.querySelectorAll<HTMLButtonElement>('button'))
      .find((button) => button.textContent?.trim().toLowerCase().startsWith('lat'))
    latButton?.click()
    await wait(80)
    const textarea = bulkCard.querySelector<HTMLTextAreaElement>('textarea')
    if (!textarea) {
      setStatus({ text: 'Toplu koordinat alanı bulunamadı.', tone: 'error' })
      return
    }
    setNativeValue(textarea, selectedCandidates.map((candidate) => `${candidate.lat.toFixed(8)}, ${candidate.lng.toFixed(8)}`).join('\n'))
    await wait(100)
    const addButton = Array.from(bulkCard.querySelectorAll<HTMLButtonElement>('button'))
      .find((button) => button.textContent?.includes('Koordinatları Ekle'))
    if (!addButton) {
      setStatus({ text: 'Projeye ekleme düğmesi bulunamadı.', tone: 'error' })
      return
    }
    addButton.click()
    setStatus({ text: `${selectedCandidates.length} koordinat aktif poligona aktarıldı.`, tone: 'success' })
    await wait(180)
    clearResult()
  }

  if (!host) return null

  return createPortal(
    <section className="document-v2-card">
      <header className="document-v2-head">
        <div className="document-v2-title"><span><FileSearch size={19} /></span><div><strong>Belgeden Koordinat Al 3.1</strong><small>Ruhsat tablosu · Sağa(Y)/Yukarı(X) · OCR hata toleransı · Zone/Datum · harita önizleme</small></div></div>
        {scan && <button type="button" className="document-v2-close" onClick={clearResult} aria-label="Sonucu kapat"><X size={15} /></button>}
      </header>

      <div className="document-v2-body">
        <label className={`document-v2-drop${busy ? ' is-busy' : ''}`}>
          <FileUp size={26} />
          <span><strong>{busy ? progress.label : 'Belge veya görsel seçin'}</strong><small>PDF · DOCX · TXT · CSV · TSV · JPG · PNG · WEBP</small></span>
          <input type="file" accept=".pdf,.docx,.txt,.csv,.tsv,text/plain,text/csv,image/png,image/jpeg,image/webp" onChange={scanFile} disabled={busy} />
        </label>

        {busy && <div className="document-v2-progress" role="status"><span style={{ width: `${progress.percent}%` }} /><output>{progress.percent}%</output></div>}

        <div className="document-v2-settings">
          <label><span>Varsayılan Zone</span><select value={zone} onChange={(event) => setZone(Number(event.target.value))}>{Array.from({ length: 60 }, (_, index) => index + 1).map((value) => <option key={value}>{value}</option>)}</select></label>
          <label><span>Yarımküre</span><select value={hemisphere} onChange={(event) => setHemisphere(event.target.value as 'N' | 'S')}><option value="N">Kuzey (N)</option><option value="S">Güney (S)</option></select></label>
          <label><span>Datum</span><select value={datum} onChange={(event) => setDatum(event.target.value)}><option>WGS84</option><option>ED50</option></select></label>
        </div>
        <p className="document-v2-note"><ShieldCheck size={13} /> Ruhsatlarda Sağa (Y) Easting, Yukarı (X) Northing olarak okunur. OCR başlığı yanlış okusa bile (Y)/(X) ve sayı sütunları eşleştirilir. Zone belge üzerinde yoksa il bilgisinden tahmin edilir; datum tahmin edilmez.</p>

        {status && <div className={`document-v2-status ${status.tone}`}>{status.text}</div>}

        {scan && <div className="document-v2-results">
          <div className="document-v2-summary">
            <span><small>Koordinat</small><strong>{scan.candidates.length}</strong></span>
            <span className="safe"><small>Güvenli</small><strong>{scan.stats.high}</strong></span>
            <span className="review"><small>Kontrol</small><strong>{scan.stats.medium + scan.stats.low}</strong></span>
            <span><small>Tekrar Silindi</small><strong>{scan.stats.duplicatesRemoved}</strong></span>
            <span><small>Tablo Noktası</small><strong>{scan.stats.tableRows}</strong></span>
          </div>

          <div className="document-v2-detection">
            <div><SlidersHorizontal size={14} /><span><small>Algılanan Sistem</small><strong>Zone {scan.detection.zone}{scan.detection.hemisphere} · {scan.detection.datum}</strong></span></div>
            <em>{scan.usedOcr ? 'Metin + OCR' : 'Metin analizi'}</em>
          </div>
          {scan.detection.evidence.length > 0 && <div className="document-v2-evidence">{scan.detection.evidence.map((item) => <span key={item}><CheckCircle2 size={11} /> {item}</span>)}</div>}
          {scan.warning && <div className="document-v2-warning"><AlertTriangle size={14} />{scan.warning}</div>}

          {scan.candidates.length > 0 ? <>
            <div className="document-v2-toolbar">
              <div className="document-v2-filters">
                <button type="button" className={filter === 'all' ? 'is-active' : ''} onClick={() => setFilter('all')}>Tümü {scan.candidates.length}</button>
                <button type="button" className={filter === 'safe' ? 'is-active' : ''} onClick={() => setFilter('safe')}>Güvenli {scan.stats.high}</button>
                <button type="button" className={filter === 'review' ? 'is-active' : ''} onClick={() => setFilter('review')}>Kontrol {scan.stats.medium + scan.stats.low}</button>
              </div>
              <div className="document-v2-actions-mini">
                <button type="button" onClick={selectSafe}><ShieldCheck size={13} /> Güvenlileri Seç</button>
                <button type="button" onClick={fitPreview}><Eye size={13} /> Haritada Göster</button>
              </div>
            </div>

            <label className="document-v2-select-all"><input type="checkbox" checked={selectedIds.size === scan.candidates.length} onChange={toggleAll} /><span>Tüm sonuçları seç</span><strong>{selectedIds.size}/{scan.candidates.length}</strong></label>

            <div className="document-v2-list">
              {filteredCandidates.map((candidate, index) => <label key={candidate.id} className={`document-v2-row confidence-${candidate.confidenceLevel}`}>
                <input type="checkbox" checked={selectedIds.has(candidate.id)} onChange={() => toggleCandidate(candidate.id)} />
                <span className="document-v2-pin"><span>⌖</span></span>
                <span className="document-v2-value">
                  <strong>{candidate.name || `Nokta ${index + 1}`} <em>{candidate.format}</em></strong>
                  <code>{candidate.lat.toFixed(6)}, {candidate.lng.toFixed(6)}</code>
                  <small>{candidate.source} · {candidate.sourceKind}{candidate.zone ? ` · Z${candidate.zone}${candidate.hemisphere ?? ''} ${candidate.datum ?? ''}` : ''}</small>
                  <small>{candidate.raw}</small>
                </span>
                <span className={`document-v2-confidence ${candidate.confidenceLevel}`}><strong>%{candidate.confidence}</strong><small>{confidenceText(candidate)}</small></span>
              </label>)}
            </div>

            <button type="button" className="document-v2-add" onClick={() => void addSelectedToProject()} disabled={!selectedIds.size}><Plus size={18} /> Seçilen {selectedIds.size} Koordinatı Aktif Poligona Ekle</button>
          </> : <div className="document-v2-empty"><FileSearch size={27} /><strong>Koordinat bulunamadı</strong><span>Belge netliğini ve tablo başlıklarını kontrol edin.</span></div>}
        </div>}
      </div>
    </section>,
    host,
  )
}
