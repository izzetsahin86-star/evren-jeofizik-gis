import { useEffect, useMemo, useRef, useState, type ChangeEvent } from 'react'
import { createPortal } from 'react-dom'
import L, { type FeatureGroup, type Map as LeafletMap } from 'leaflet'
import { AlertTriangle, CheckCircle2, Eye, FileSearch, FileUp, MapPin, Plus, ShieldCheck, SlidersHorizontal, X } from 'lucide-react'
import { scanCoordinateDocument, type DocumentCoordinateCandidate, type DocumentScanProgress, type DocumentScanResult } from '../documentCoordinates'

const MAP_READY_EVENT = 'evren-document-coordinates-map-ready'
const MAX_PREVIEW_POINTS = 1000

let capturedMap: LeafletMap | null = null
let hookInstalled = false

function installMapHook() {
  if (hookInstalled) return
  hookInstalled = true
  L.Map.addInitHook(function captureDocumentCoordinateMap(this: LeafletMap) {
    capturedMap = this
    window.dispatchEvent(new CustomEvent(MAP_READY_EVENT))
    this.once('unload', () => {
      if (capturedMap === this) capturedMap = null
    })
  })
}

installMapHook()

function setNativeValue(element: HTMLTextAreaElement, value: string) {
  const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')?.set
  if (setter) setter.call(element, value)
  else element.value = value
  element.dispatchEvent(new Event('input', { bubbles: true }))
  element.dispatchEvent(new Event('change', { bubbles: true }))
}

function findCard(title: string) {
  return Array.from(document.querySelectorAll<HTMLElement>('.panel-card')).find((card) => card.querySelector('h2')?.textContent?.trim() === title) ?? null
}

function confidenceText(candidate: DocumentCoordinateCandidate) {
  if (candidate.confidenceLevel === 'high') return 'Güvenli'
  if (candidate.confidenceLevel === 'medium') return 'Kontrol Et'
  return 'Düşük'
}

function markerColor(candidate: DocumentCoordinateCandidate) {
  if (candidate.confidenceLevel === 'high') return '#16a34a'
  if (candidate.confidenceLevel === 'medium') return '#d97706'
  return '#dc2626'
}

function wait(ms: number) {
  return new Promise((resolve) => window.setTimeout(resolve, ms))
}

export default function DocumentCoordinateFeatureV2() {
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
      const stack = document.querySelector<HTMLElement>('.smart-sheet-body .panel-stack')
      const legacy = findCard('Belgeden Koordinat Al')
      if (!stack || !legacy) {
        setHost(null)
        return
      }
      legacyRef.current = legacy
      legacy.style.display = 'none'
      let mount = stack.querySelector<HTMLElement>('[data-document-coordinate-v2-host]')
      if (!mount) {
        mount = document.createElement('div')
        mount.dataset.documentCoordinateV2Host = 'true'
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
      document.querySelector('[data-document-coordinate-v2-host]')?.remove()
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

  const selectedCandidates = useMemo(() => scan?.candidates.filter((candidate) => selectedIds.has(candidate.id)) ?? [], [scan, selectedIds])
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
  }, [selectedCandidates, map])

  useEffect(() => {
    if (!status) return
    const timer = window.setTimeout(() => setStatus(null), 4200)
    return () => window.clearTimeout(timer)
  }, [status])

  const scanFile = async (event: ChangeEvent<HTMLInputElement>) => {
    const input = event.target
    const file = input.files?.[0]
    if (!file) return
    setBusy(true)
    setScan(null)
    setSelectedIds(new Set())
    setFilter('all')
    setProgress({ percent: 1, label: 'Belge hazırlanıyor…' })
    setStatus({ text: 'Belge yapısı, tablolar ve koordinat biçimleri analiz ediliyor.', tone: 'info' })
    try {
      const result = await scanCoordinateDocument(file, { zone, hemisphere, datum }, setProgress)
      setScan(result)
      const safeIds = new Set(result.candidates.filter((candidate) => candidate.confidence >= 65).map((candidate) => candidate.id))
      setSelectedIds(safeIds)
      if (result.detection.zone) setZone(result.detection.zone)
      if (result.detection.hemisphere) setHemisphere(result.detection.hemisphere)
      if (result.detection.datum === 'ED50' || result.detection.datum === 'WGS84') setDatum(result.detection.datum)
      setStatus({
        text: result.candidates.length
          ? `${result.candidates.length} benzersiz koordinat bulundu · ${result.stats.high} güvenli · ${result.stats.medium + result.stats.low} kontrol gerekli.`
          : 'Belgede koordinat bulunamadı.',
        tone: result.candidates.length ? 'success' : 'error',
      })
      window.setTimeout(() => fitPreview(true), 100)
    } catch (error) {
      setStatus({ text: error instanceof Error ? error.message : 'Belge analiz edilemedi.', tone: 'error' })
    } finally {
      setBusy(false)
      input.value = ''
    }
  }

  const fitPreview = (fromFreshScan = false) => {
    const layer = layerRef.current
    const targetMap = map ?? capturedMap
    if (!layer || !targetMap) return
    if (!layer.getLayers().length) {
      if (!fromFreshScan) setStatus({ text: 'Haritada gösterilecek seçili koordinat yok.', tone: 'info' })
      return
    }
    const bounds = layer.getBounds()
    if (bounds.isValid()) targetMap.fitBounds(bounds.pad(0.18), { maxZoom: 17, animate: true })
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

    const latButton = Array.from(bulkCard.querySelectorAll<HTMLButtonElement>('button')).find((button) => button.textContent?.trim().toLowerCase().startsWith('lat'))
    latButton?.click()
    await wait(80)

    const textarea = bulkCard.querySelector<HTMLTextAreaElement>('textarea')
    if (!textarea) {
      setStatus({ text: 'Toplu koordinat alanı bulunamadı.', tone: 'error' })
      return
    }
    setNativeValue(textarea, selectedCandidates.map((candidate) => `${candidate.lat.toFixed(8)}, ${candidate.lng.toFixed(8)}`).join('\n'))
    await wait(100)

    const addButton = Array.from(bulkCard.querySelectorAll<HTMLButtonElement>('button')).find((button) => button.textContent?.includes('Koordinatları Ekle'))
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
        <div className="document-v2-title"><span><FileSearch size={19} /></span><div><strong>Belgeden Koordinat Al 2.0</strong><small>Akıllı tablo · OCR · Zone/Datum · güven analizi · harita önizleme</small></div></div>
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
        <p className="document-v2-note"><ShieldCheck size={13} /> Zone ve datum belgede bulunursa otomatik kullanılır; bulunamazsa yukarıdaki değerler yalnız UTM adayları için varsayılan kabul edilir.</p>

        {status && <div className={`document-v2-status ${status.tone}`}>{status.text}</div>}

        {scan && (
          <div className="document-v2-results">
            <div className="document-v2-summary">
              <span><small>Koordinat</small><strong>{scan.candidates.length}</strong></span>
              <span className="safe"><small>Güvenli</small><strong>{scan.stats.high}</strong></span>
              <span className="review"><small>Kontrol</small><strong>{scan.stats.medium + scan.stats.low}</strong></span>
              <span><small>Tekrar Silindi</small><strong>{scan.stats.duplicatesRemoved}</strong></span>
              <span><small>Tablo Satırı</small><strong>{scan.stats.tableRows}</strong></span>
            </div>

            <div className="document-v2-detection">
              <div><SlidersHorizontal size={14} /><span><small>Algılanan Sistem</small><strong>Zone {scan.detection.zone}{scan.detection.hemisphere} · {scan.detection.datum}</strong></span></div>
              <em>{scan.usedOcr ? 'Metin + OCR' : 'Metin analizi'}</em>
            </div>
            {scan.detection.evidence.length > 0 && <div className="document-v2-evidence">{scan.detection.evidence.map((item) => <span key={item}><CheckCircle2 size={11} /> {item}</span>)}</div>}
            {scan.warning && <div className="document-v2-warning"><AlertTriangle size={14} />{scan.warning}</div>}

            {scan.candidates.length > 0 ? (
              <>
                <div className="document-v2-toolbar">
                  <div className="document-v2-filters">
                    <button type="button" className={filter === 'all' ? 'is-active' : ''} onClick={() => setFilter('all')}>Tümü {scan.candidates.length}</button>
                    <button type="button" className={filter === 'safe' ? 'is-active' : ''} onClick={() => setFilter('safe')}>Güvenli {scan.stats.high}</button>
                    <button type="button" className={filter === 'review' ? 'is-active' : ''} onClick={() => setFilter('review')}>Kontrol {scan.stats.medium + scan.stats.low}</button>
                  </div>
                  <div className="document-v2-actions-mini">
                    <button type="button" onClick={selectSafe}><ShieldCheck size={13} /> Güvenlileri Seç</button>
                    <button type="button" onClick={() => fitPreview(false)}><Eye size={13} /> Haritada Göster</button>
                  </div>
                </div>

                <label className="document-v2-select-all"><input type="checkbox" checked={selectedIds.size === scan.candidates.length} onChange={toggleAll} /><span>Tüm sonuçları seç</span><strong>{selectedIds.size}/{scan.candidates.length}</strong></label>

                <div className="document-v2-list">
                  {filteredCandidates.map((candidate, index) => (
                    <label className={`document-v2-row confidence-${candidate.confidenceLevel}`} key={candidate.id}>
                      <input type="checkbox" checked={selectedIds.has(candidate.id)} onChange={() => toggleCandidate(candidate.id)} />
                      <span className="document-v2-pin"><MapPin size={14} /></span>
                      <span className="document-v2-copy">
                        <strong>{candidate.name || `Nokta ${index + 1}`} <em>{candidate.format}</em></strong>
                        <code>{candidate.lat.toFixed(7)}, {candidate.lng.toFixed(7)}</code>
                        <small>{candidate.source} · {candidate.sourceKind}{candidate.group ? ` · ${candidate.group}` : ''}{candidate.zone ? ` · Z${candidate.zone}${candidate.hemisphere} ${candidate.datum}` : ''}</small>
                        <span className="document-v2-raw" title={candidate.raw}>{candidate.raw}</span>
                        <span className="document-v2-reasons">{candidate.reasons.slice(0, 3).join(' · ')}</span>
                      </span>
                      <span className={`document-v2-confidence ${candidate.confidenceLevel}`}><b>%{candidate.confidence}</b><small>{confidenceText(candidate)}</small></span>
                    </label>
                  ))}
                </div>

                {selectedCandidates.length > MAX_PREVIEW_POINTS && <p className="document-v2-note"><AlertTriangle size={13} /> Harita performansı için ilk {MAX_PREVIEW_POINTS} seçili aday önizleniyor; projeye ekleme seçimin tamamını kullanır.</p>}
                <button type="button" className="document-v2-add" onClick={() => void addSelectedToProject()} disabled={!selectedIds.size}><Plus size={17} /> Seçilen {selectedIds.size} Koordinatı Aktif Poligona Ekle</button>
              </>
            ) : <div className="document-v2-empty"><FileSearch size={27} /><strong>Koordinat bulunamadı</strong><small>Belgedeki tablo başlıklarını, Zone/Datum bilgisini veya görsel netliğini kontrol edin.</small></div>}
          </div>
        )}
      </div>
    </section>,
    host,
  )
}
