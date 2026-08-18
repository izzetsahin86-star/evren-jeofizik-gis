import { useMemo, useState, type ChangeEvent } from 'react'
import {
  AlertTriangle,
  Calculator,
  Camera,
  CheckCircle2,
  ChevronDown,
  CircleDot,
  Copy,
  Download,
  Eye,
  EyeOff,
  FileDown,
  FileSearch,
  FileUp,
  Gauge,
  Grid3X3,
  Layers3,
  MapPin,
  Navigation,
  Palette,
  Plus,
  Search,
  SlidersHorizontal,
  Sparkles,
  Trash2,
  Upload,
  Wifi,
  WifiOff,
  X,
} from 'lucide-react'
import {
  analyzePolygon,
  deltaEastNorth,
  downloadBlob,
  downloadKmz,
  formatAreaShort,
  formatNumber,
  formatPoint,
  fromUtm,
  generateDesGrid,
  parseCoordinate,
  pointBearing,
  pointDistance,
  polygonsToCsv,
  polygonsToGeoJson,
  polygonsToKml,
  readSpatialFile,
  toUtm,
} from '../geo'
import { exportProjectPdf } from '../report'
import type { BaseLayerId, CoordinateFormat, DisplaySettings, GeoPoint, PanelId, PerformanceMode, PolygonAppearance, PolygonLayer } from '../types'
import { Card, EmptyState, Field, Segmented } from './PanelUi'

const coordinateOptions: Array<{ value: CoordinateFormat; label: string }> = [
  { value: 'utm', label: 'UTM' },
  { value: 'latlon', label: 'Lat / Lon' },
  { value: 'dms', label: 'DMS (°′″)' },
  { value: 'ddm', label: 'DDM (°.′)' },
]

const panelTitles: Record<PanelId, string> = {
  layers: 'Katmanlar',
  coordinates: 'Koordinat',
  tools: 'Araçlar',
  import: 'İçe Aktar',
  export: 'Dışa Aktar',
  settings: 'Ayarla',
}

type VisibilitySetting = Exclude<keyof DisplaySettings, 'cardScale'>

const visibilityOptions: Array<{ key: VisibilitySetting; label: string; description: string }> = [
  { key: 'coordinateCard', label: 'Koordinat kartı', description: 'Enlem, boylam ve UTM bilgisi' },
  { key: 'areaCard', label: 'Alan kartı', description: 'Aktif poligonun hesaplanan alanı' },
  { key: 'mapActions', label: 'Harita işlem kartları', description: 'Tıkla, hedeften ekle ve serbest ölç' },
  { key: 'measurementCard', label: 'Ölçüm kartı', description: 'Mesafe, azimut ve alan sonuçları' },
  { key: 'locationCard', label: 'Konum kartı', description: 'GPS düğmesi ve konum hassasiyeti' },
  { key: 'headerStats', label: 'Üst durum kartları', description: 'Poligon, nokta ve alan sayaçları' },
]

interface BottomPanelProps {
  panel: PanelId
  polygons: PolygonLayer[]
  activeId: string
  baseLayer: BaseLayerId
  performanceMode: PerformanceMode
  performanceActive: boolean
  displaySettings: DisplaySettings
  isOnline: boolean
  onClose: () => void
  onSetBaseLayer: (layer: BaseLayerId) => void
  onSetActive: (id: string) => void
  onNewPolygon: () => void
  onRenamePolygon: (id: string, name: string) => void
  onCycleColor: (id: string) => void
  onSetPolygonStyle: (id: string, appearance: Partial<PolygonAppearance>) => void
  onSetPerformanceMode: (mode: PerformanceMode) => void
  onSetDisplaySettings: (settings: DisplaySettings) => void
  onClearAllData: () => void
  onDeletePolygon: (id: string) => void
  onDuplicatePolygon: (id: string) => void
  onAddPoints: (points: Array<Omit<GeoPoint, 'id'>>) => void
  onDeletePoint: (pointId: string) => void
  onClearPoints: () => void
  onSetDesPoints: (polygonId: string, points: GeoPoint[]) => void
  onImportLayers: (layers: PolygonLayer[]) => void
  onFitActive: () => void
  onFlyTo: (target: { lat: number; lng: number; zoom?: number }) => void
  onMessage: (message: string, tone?: 'success' | 'error' | 'info') => void
}

function LayerPanel(props: BottomPanelProps) {
  const active = props.polygons.find((layer) => layer.id === props.activeId) ?? props.polygons[0]
  return (
    <div className="panel-stack">
      <Card title="Harita Görünümü" icon={<Layers3 size={19} />}>
        <Segmented
          value={props.baseLayer}
          ariaLabel="Harita katmanı"
          options={[
            { value: 'street', label: 'Sokak' },
            { value: 'satellite', label: 'Uydu' },
            { value: 'topographic', label: 'Topo' },
          ]}
          onChange={props.onSetBaseLayer}
        />
      </Card>

      <Card title="Poligon Katmanları" subtitle={`${props.polygons.length} katman`} icon={<CircleDot size={19} />} tone="purple">
        <button type="button" className="primary-button" onClick={props.onNewPolygon}><Plus size={18} /> Yeni Poligon</button>
        <div className="layer-list">
          {props.polygons.map((layer) => (
            <div key={layer.id} className={`layer-row${layer.id === props.activeId ? ' is-active' : ''}`}>
              <button className="layer-main" type="button" onClick={() => props.onSetActive(layer.id)}>
                <span className="layer-color" style={{ background: layer.color }} />
                <span><strong>{layer.name}</strong><small>{layer.points.length} nokta · {layer.desPoints.length} DES</small></span>
              </button>
              <button type="button" onClick={() => props.onCycleColor(layer.id)} aria-label="Renk değiştir"><Palette size={16} /></button>
              <button type="button" onClick={() => props.onDuplicatePolygon(layer.id)} aria-label="Kopyala"><Copy size={16} /></button>
              <button type="button" onClick={() => props.onDeletePolygon(layer.id)} aria-label="Poligonu sil" disabled={props.polygons.length === 1}><Trash2 size={16} /></button>
            </div>
          ))}
        </div>
        <div className="inline-form">
          <input
            aria-label="Aktif poligon adı"
            value={props.polygons.find((layer) => layer.id === props.activeId)?.name ?? ''}
            onChange={(event) => props.onRenamePolygon(props.activeId, event.target.value)}
          />
          <button type="button" className="secondary-button" onClick={props.onFitActive}>Haritada Göster</button>
        </div>
      </Card>

      <Card title="Poligon Görünümü" subtitle={`Aktif: ${active.name}`} icon={<SlidersHorizontal size={19} />} tone="green">
        <div className="appearance-grid">
          <Field label="Renk"><input className="color-input" type="color" value={active.color} onChange={(event) => props.onSetPolygonStyle(active.id, { color: event.target.value })} /></Field>
          <Field label={`Çizgi · ${active.strokeWidth ?? 3}px`}><input type="range" min="1" max="8" step="1" value={active.strokeWidth ?? 3} onChange={(event) => props.onSetPolygonStyle(active.id, { strokeWidth: Number(event.target.value) })} /></Field>
          <Field label={`Çizgi görünürlüğü · ${Math.round((active.strokeOpacity ?? 1) * 100)}%`}><input type="range" min="0.15" max="1" step="0.05" value={active.strokeOpacity ?? 1} onChange={(event) => props.onSetPolygonStyle(active.id, { strokeOpacity: Number(event.target.value) })} /></Field>
          <Field label={`Dolgu · ${Math.round((active.fillOpacity ?? 0.14) * 100)}%`}><input type="range" min="0" max="0.6" step="0.02" value={active.fillOpacity ?? 0.14} onChange={(event) => props.onSetPolygonStyle(active.id, { fillOpacity: Number(event.target.value) })} /></Field>
        </div>
      </Card>

      <Card title="Büyük Proje Performansı" subtitle="Yoğun noktalarda haritayı akıcı tutar" icon={<Gauge size={19} />} tone="amber">
        <Segmented value={props.performanceMode} ariaLabel="Performans modu" options={[{ value: 'auto', label: 'Otomatik' }, { value: 'on', label: 'Açık' }, { value: 'off', label: 'Kapalı' }]} onChange={props.onSetPerformanceMode} />
        <div className={`mode-status ${props.performanceActive ? 'is-active' : ''}`}><Gauge size={16} /><span><strong>{props.performanceActive ? 'Hızlı çizim aktif' : 'Normal çizim aktif'}</strong><small>{props.performanceActive ? 'Köşe ve DES işaretleri örneklenerek gösteriliyor.' : 'Tüm köşe ve DES işaretleri gösteriliyor.'}</small></span></div>
      </Card>

      <Card title="Çevrimdışı Saha Modu" subtitle="Uygulama ve ziyaret edilen harita kareleri saklanır" icon={props.isOnline ? <Wifi size={19} /> : <WifiOff size={19} />}>
        <div className={`mode-status ${props.isOnline ? 'is-online' : 'is-offline'}`}>{props.isOnline ? <CheckCircle2 size={17} /> : <AlertTriangle size={17} />}<span><strong>{props.isOnline ? 'Çevrimiçi · önbellek hazırlanıyor' : 'Çevrimdışı çalışıyorsunuz'}</strong><small>İnternet varken gezdiğiniz harita bölgeleri saha kullanımı için cihazda tutulur.</small></span></div>
      </Card>
    </div>
  )
}

function CoordinatePanel(props: BottomPanelProps) {
  const active = props.polygons.find((layer) => layer.id === props.activeId) ?? props.polygons[0]
  const [format, setFormat] = useState<CoordinateFormat>('utm')
  const [listFormat, setListFormat] = useState<CoordinateFormat>('latlon')
  const [bulkFormat, setBulkFormat] = useState<CoordinateFormat>('utm')
  const [datum, setDatum] = useState('WGS84')
  const [zone, setZone] = useState(36)
  const [hemisphere, setHemisphere] = useState<'N' | 'S'>('N')
  const [coordinate, setCoordinate] = useState('')
  const [easting, setEasting] = useState('')
  const [northing, setNorthing] = useState('')
  const [bulk, setBulk] = useState('')
  const [ocrBusy, setOcrBusy] = useState(false)
  const [visiblePointCount, setVisiblePointCount] = useState(200)

  const addSingle = () => {
    const point = format === 'utm'
      ? (easting && northing ? fromUtm(Number(easting), Number(northing), zone, hemisphere, datum) : null)
      : parseCoordinate(coordinate, format, { zone, hemisphere, datum })
    if (!point || !Number.isFinite(point.lat) || !Number.isFinite(point.lng)) {
      props.onMessage('Koordinat biçimi okunamadı. Değerleri kontrol edin.', 'error')
      return
    }
    props.onAddPoints([point])
    setCoordinate('')
    setEasting('')
    setNorthing('')
    props.onMessage('Nokta poligona eklendi.', 'success')
  }

  const addBulk = () => {
    const points = bulk.split(/\r?\n/)
      .map((line) => line.trim())
      .filter((line) => line && !line.startsWith('#'))
      .map((line) => parseCoordinate(line, bulkFormat, { zone, hemisphere, datum }))
      .filter((point): point is Omit<GeoPoint, 'id'> => Boolean(point))
    if (!points.length) {
      props.onMessage('Eklenebilecek geçerli koordinat bulunamadı.', 'error')
      return
    }
    props.onAddPoints(points)
    setBulk('')
    props.onMessage(`${points.length} koordinat eklendi.`, 'success')
  }

  const readCoordinateFile = async (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0]
    if (!file) return
    if (file.type.startsWith('image/')) {
      setOcrBusy(true)
      props.onMessage('Belge taranıyor; işlem görüntü boyutuna göre biraz sürebilir.', 'info')
      try {
        const { recognize } = await import('tesseract.js')
        const result = await recognize(file, 'eng')
        setBulk(result.data.text)
        props.onMessage('Görseldeki metin okundu ve toplu koordinat alanına aktarıldı.', 'success')
      } catch {
        props.onMessage('Görsel okunamadı. Daha net bir belge deneyin.', 'error')
      } finally {
        setOcrBusy(false)
      }
      event.target.value = ''
      return
    }
    if (file.name.toLowerCase().endsWith('.pdf')) {
      props.onMessage('PDF için sayfayı görsel olarak dışa aktarıp yükleyin; görsel OCR yerel olarak çalışır.', 'info')
      event.target.value = ''
      return
    }
    setBulk(await file.text())
    props.onMessage('Belgedeki metin toplu koordinat alanına aktarıldı.', 'success')
    event.target.value = ''
  }

  const readCsv = async (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0]
    if (!file) return
    const text = await file.text()
    const points = text.split(/\r?\n/).slice(1).map((line) => {
      const values = line.split(/[;,]/).map((item) => item.trim())
      if (values.length >= 2 && Math.abs(Number(values[0])) <= 90 && Math.abs(Number(values[1])) <= 180) {
        return { lat: Number(values[0]), lng: Number(values[1]) }
      }
      if (values.length >= 2) return fromUtm(Number(values[0]), Number(values[1]), Number(values[2] || zone), (values[3]?.toUpperCase() === 'S' ? 'S' : 'N'), values[4] || datum)
      return null
    }).filter((point): point is Omit<GeoPoint, 'id'> => Boolean(point && Number.isFinite(point.lat) && Number.isFinite(point.lng)))
    props.onAddPoints(points)
    props.onMessage(`${points.length} CSV koordinatı eklendi.`, points.length ? 'success' : 'error')
    event.target.value = ''
  }

  return (
    <div className="panel-stack">
      <div className="active-layer-chip"><span style={{ background: active.color }} /> <strong>Aktif: {active.name}</strong><em>{active.points.length} nokta</em></div>

      <label className={`document-button secondary${ocrBusy ? ' is-busy' : ''}`}><Camera size={18} /> {ocrBusy ? 'Belge Okunuyor…' : 'Belgeden Koordinat Al (AI)'}<input type="file" accept=".txt,.csv,.pdf,image/*" onChange={readCoordinateFile} disabled={ocrBusy} /></label>
      <label className={`document-button gradient${ocrBusy ? ' is-busy' : ''}`}><Sparkles size={18} /> {ocrBusy ? 'OCR İşleniyor…' : 'AI + OCR ile Koordinat Al'}<input type="file" accept=".txt,.csv,.pdf,image/*" onChange={readCoordinateFile} disabled={ocrBusy} /></label>

      <Card title="Koordinat Ekle" icon={<MapPin size={19} />}>
        <Segmented value={format} options={coordinateOptions} onChange={setFormat} ariaLabel="Koordinat biçimi" />
        <div className="form-grid compact">
          {format === 'utm' ? (
            <>
              <Field label="Datum"><select value={datum} onChange={(event) => setDatum(event.target.value)}><option>WGS84</option><option>ED50</option></select></Field>
              <Field label="Zone"><select value={zone} onChange={(event) => setZone(Number(event.target.value))}>{Array.from({ length: 6 }, (_, i) => 32 + i).map((value) => <option key={value}>{value}</option>)}</select></Field>
              <Field label="Yarımküre"><select value={hemisphere} onChange={(event) => setHemisphere(event.target.value as 'N' | 'S')}><option value="N">Kuzey (N)</option><option value="S">Güney (S)</option></select></Field>
              <Field label="Easting (X)"><input inputMode="decimal" value={easting} onChange={(event) => setEasting(event.target.value)} placeholder="500000" /></Field>
              <Field label="Northing (Y)"><input inputMode="decimal" value={northing} onChange={(event) => setNorthing(event.target.value)} placeholder="4500000" /></Field>
            </>
          ) : (
            <Field label="Koordinat"><input value={coordinate} onChange={(event) => setCoordinate(event.target.value)} placeholder={format === 'latlon' ? 'Örn: 41.0082, 28.9784' : format === 'dms' ? `39°55'12"N 32°51'36"E` : `39°55.2'N 32°51.6'E`} /></Field>
          )}
        </div>
        <button type="button" className="primary-button" onClick={addSingle}><Plus size={18} /> Nokta Ekle</button>
      </Card>

      <Card title="Toplu Koordinat Ekle" subtitle="Birden fazla koordinatı tek seferde ekleyin" icon={<FileUp size={19} />} tone="purple">
        <Segmented value={bulkFormat} options={coordinateOptions.map((option) => ({ ...option, label: option.label.split(' ')[0] }))} onChange={setBulkFormat} ariaLabel="Toplu koordinat biçimi" />
        <div className="form-grid three">
          <Field label="Zone"><select value={zone} onChange={(event) => setZone(Number(event.target.value))}>{Array.from({ length: 6 }, (_, i) => 32 + i).map((value) => <option key={value}>{value}</option>)}</select></Field>
          <Field label="Yarımküre"><select value={hemisphere} onChange={(event) => setHemisphere(event.target.value as 'N' | 'S')}><option value="N">Kuzey</option><option value="S">Güney</option></select></Field>
          <Field label="Datum"><select value={datum} onChange={(event) => setDatum(event.target.value)}><option>WGS84</option><option>ED50</option></select></Field>
        </div>
        <Field label="Koordinatlar">
          <textarea rows={6} value={bulk} onChange={(event) => setBulk(event.target.value)} placeholder={'# Her satıra bir koordinat\n# Örnek: 500000, 4500000'} />
        </Field>
        <p className="form-note">Her satıra bir koordinat yazın. # ile başlayan satırlar atlanır.</p>
        <button type="button" className="primary-button purple" onClick={addBulk}><Plus size={18} /> Koordinatları Ekle</button>
      </Card>

      <Card title="CSV İçe Aktar" subtitle="Dosyadan koordinat yükleyin" icon={<FileUp size={19} />} tone="green">
        <label className="dropzone"><Upload size={26} /><strong>CSV dosyası seçin</strong><small>Lat, Lon veya Easting, Northing, Zone, Yarımküre, Datum</small><input type="file" accept=".csv,text/csv" onChange={readCsv} /></label>
        <button type="button" className="secondary-button" onClick={() => downloadBlob('Latitude,Longitude\n39.9255,32.8663', 'koordinat-sablonu.csv', 'text/csv;charset=utf-8')}><FileDown size={16} /> Şablon İndir</button>
      </Card>

      <Card title="Koordinatlar" subtitle={`${active.points.length} nokta`} icon={<CircleDot size={19} />}>
        {active.points.length ? (
          <>
            <div className="list-toolbar"><Segmented value={listFormat} options={coordinateOptions.map((option) => ({ ...option, label: option.label.split(' ')[0] }))} onChange={setListFormat} ariaLabel="Liste biçimi" /><button type="button" className="danger-text" onClick={props.onClearPoints}>Tümünü Sil</button></div>
            <ol className="coordinate-list">
              {active.points.slice(0, visiblePointCount).map((point, index) => (
                <li key={point.id}><span className="point-number" style={{ background: active.color }}>{index + 1}</span><code>{formatPoint(point, listFormat, zone, datum)}</code><button type="button" onClick={() => props.onDeletePoint(point.id)} aria-label={`${index + 1}. noktayı sil`}><Trash2 size={15} /></button></li>
              ))}
            </ol>
            {active.points.length > visiblePointCount && <button type="button" className="secondary-button" onClick={() => setVisiblePointCount((value) => value + 200)}>Sonraki 200 noktayı göster · {active.points.length - visiblePointCount} kaldı</button>}
            {active.points.length > 500 && <p className="form-note">Liste performans için bölümler hâlinde gösteriliyor.</p>}
          </>
        ) : <EmptyState><MapPin size={28} /><strong>Henüz koordinat eklenmedi</strong><span>Poligon çizmek için en az 3 nokta ekleyin</span></EmptyState>}
      </Card>
    </div>
  )
}

function ToolsPanel(props: BottomPanelProps) {
  const [selectedPolygonId, setSelectedPolygonId] = useState(props.activeId)
  const selected = props.polygons.find((layer) => layer.id === selectedPolygonId) ?? props.polygons.find((layer) => layer.id === props.activeId) ?? props.polygons[0]
  const analysis = useMemo(() => analyzePolygon(selected.points), [selected.points])
  const [spacing, setSpacing] = useState(50)
  const [customSpacing, setCustomSpacing] = useState('')
  const [desPrefix, setDesPrefix] = useState('DES1')
  const [address, setAddress] = useState('')
  const [searching, setSearching] = useState(false)
  const [startId, setStartId] = useState('')
  const [endId, setEndId] = useState('')
  const [convertDirection, setConvertDirection] = useState<'utmToLat' | 'latToUtm'>('utmToLat')
  const [convertZone, setConvertZone] = useState(36)
  const [convertHemisphere, setConvertHemisphere] = useState<'N' | 'S'>('N')
  const [convertDatum, setConvertDatum] = useState('WGS84')
  const [convertA, setConvertA] = useState('')
  const [convertB, setConvertB] = useState('')
  const [convertResult, setConvertResult] = useState('')

  const pointA = selected.points.find((point) => point.id === startId)
  const pointB = selected.points.find((point) => point.id === endId)
  const distance = pointDistance(pointA, pointB)
  const bearing = pointBearing(pointA, pointB)
  const delta = deltaEastNorth(pointA, pointB)

  const createDes = () => {
    const finalSpacing = customSpacing ? Number(customSpacing) : spacing
    const points = generateDesGrid(selected.points, finalSpacing, desPrefix)
    if (!points.length) {
      props.onMessage('DES noktaları için en az 3 noktalı bir poligon gerekir.', 'error')
      return
    }
    props.onSetDesPoints(selected.id, points)
    props.onMessage(`${points.length} DES noktası üretildi.`, 'success')
  }

  const searchAddress = async () => {
    if (!address.trim()) return
    setSearching(true)
    try {
      const response = await fetch(`https://nominatim.openstreetmap.org/search?format=json&limit=1&q=${encodeURIComponent(address)}`, { headers: { 'Accept-Language': 'tr' } })
      const result = (await response.json())[0]
      if (!result) throw new Error('Adres bulunamadı')
      props.onFlyTo({ lat: Number(result.lat), lng: Number(result.lon), zoom: 16 })
      props.onMessage(result.display_name, 'success')
    } catch {
      props.onMessage('Adres bulunamadı veya arama hizmetine ulaşılamadı.', 'error')
    } finally {
      setSearching(false)
    }
  }

  const convert = () => {
    try {
      if (convertDirection === 'utmToLat') {
        const result = fromUtm(Number(convertA), Number(convertB), convertZone, convertHemisphere, convertDatum)
        setConvertResult(`${result.lat.toFixed(7)}, ${result.lng.toFixed(7)}`)
      } else {
        const result = toUtm(Number(convertA), Number(convertB), convertZone, convertHemisphere, convertDatum)
        setConvertResult(`${result.zone}${result.hemisphere} · ${result.easting.toFixed(2)} E · ${result.northing.toFixed(2)} N`)
      }
    } catch {
      setConvertResult('Koordinat dönüştürülemedi.')
    }
  }

  const shortest = analysis.edgeLengths.length ? Math.min(...analysis.edgeLengths) : 0
  const longest = analysis.edgeLengths.length ? Math.max(...analysis.edgeLengths) : 0

  return (
    <div className="panel-stack">
      <Card title="DES Noktaları Oluştur" icon={<Grid3X3 size={19} />} tone="amber">
        <Field label="Poligon Seç"><select value={selected.id} onChange={(event) => setSelectedPolygonId(event.target.value)}>{props.polygons.map((layer) => <option key={layer.id} value={layer.id}>{layer.name} · {layer.points.length} nokta</option>)}</select></Field>
        <div className="summary-line"><span><small>Seçili Poligon</small><strong>{selected.name}</strong></span><span><small>Nokta / Alan</small><strong>{selected.points.length} pkt · {formatAreaShort(analysis.areaM2)}</strong></span></div>
        <Field label="Başlangıç DES Numarası"><input value={desPrefix} onChange={(event) => setDesPrefix(event.target.value)} placeholder="DES1 veya DES101" /></Field>
        <span className="field-label">Nokta Aralığı (metre)</span>
        <div className="spacing-grid">{[10, 25, 50, 60, 100, 200, 250, 500, 1000].map((value) => <button key={value} type="button" className={!customSpacing && spacing === value ? 'is-active' : ''} onClick={() => { setSpacing(value); setCustomSpacing('') }}>{value}</button>)}</div>
        <Field label="Özel Aralık"><input type="number" min="1" value={customSpacing} onChange={(event) => setCustomSpacing(event.target.value)} placeholder="metre" /></Field>
        <button type="button" className="primary-button amber" onClick={createDes} disabled={selected.points.length < 3}><Grid3X3 size={18} /> Noktaları Üret</button>
        {selected.desPoints.length > 0 && <button type="button" className="secondary-button danger-text" onClick={() => props.onSetDesPoints(selected.id, [])}><Trash2 size={16} /> DES Noktalarını Sil ({selected.desPoints.length})</button>}
      </Card>

      <Card title="Adres Ara" icon={<Search size={19} />} tone="amber">
        <div className="search-field"><input value={address} onChange={(event) => setAddress(event.target.value)} onKeyDown={(event) => event.key === 'Enter' && searchAddress()} placeholder="Adres, şehir, ülke, sokak ara..." /><button type="button" onClick={searchAddress} disabled={searching}><Search size={17} /></button></div>
      </Card>

      <Card title="Alan Hesaplama" subtitle={selected.points.length >= 3 ? 'Poligon alanı hesaplandı' : 'En az 3 nokta gerekli'} icon={<Calculator size={19} />} tone="amber">
        {selected.points.length >= 3 ? (
          <>
            <div className="big-metric"><small>Hesaplanan Alan</small><strong>{formatNumber(analysis.areaM2, 2)}</strong><span>Metrekare (m²)</span></div>
            <div className="unit-grid">
              <span><small>km²</small><strong>{formatNumber(analysis.areaM2 / 1_000_000, 3)}</strong></span>
              <span><small>ha</small><strong>{formatNumber(analysis.areaM2 / 10_000, 2)}</strong></span>
              <span><small>da</small><strong>{formatNumber(analysis.areaM2 / 1_000, 2)}</strong></span>
              <span><small>acre</small><strong>{formatNumber(analysis.areaM2 / 4046.856, 2)}</strong></span>
            </div>
            {analysis.centroid && <div className="info-row"><span>Merkez</span><strong>{analysis.centroid.lat.toFixed(6)}, {analysis.centroid.lng.toFixed(6)}</strong></div>}
          </>
        ) : <EmptyState><Calculator size={28} /><strong>Alan hesaplamak için en az 3 nokta ekleyin</strong></EmptyState>}
      </Card>

      <Card title="Çevre ve Kenarlar" subtitle="Poligon çevresi ve kenar ölçüleri" icon={<Navigation size={19} />}>
        {selected.points.length >= 2 ? (
          <>
            <div className="big-metric blue"><small>Toplam Çevre</small><strong>{formatNumber(analysis.perimeterM, 2)}</strong><span>Metre</span></div>
            <div className="unit-grid two"><span><small>En Kısa Kenar</small><strong>{formatNumber(shortest, 2)} m</strong></span><span><small>En Uzun Kenar</small><strong>{formatNumber(longest, 2)} m</strong></span></div>
            <ol className="edge-list">{analysis.edgeLengths.map((value, index) => <li key={index}><span>K{index + 1}</span><strong>{formatNumber(value, 2)} m</strong><small>{formatNumber(analysis.edgeBearings[index], 2)}°</small></li>)}</ol>
          </>
        ) : <EmptyState><Navigation size={28} /><strong>Çevre hesabı için en az 2 nokta gerekli</strong></EmptyState>}
      </Card>

      <Card title="İki Nokta Analizi" subtitle="Mesafe, azimut ve Δ değerleri" icon={<CircleDot size={19} />} tone="purple">
        <div className="form-grid two">
          <Field label="Başlangıç"><select value={startId} onChange={(event) => setStartId(event.target.value)}><option value="">Nokta seçin</option>{selected.points.map((point, index) => <option key={point.id} value={point.id}>Nokta {index + 1}</option>)}</select></Field>
          <Field label="Bitiş"><select value={endId} onChange={(event) => setEndId(event.target.value)}><option value="">Nokta seçin</option>{selected.points.map((point, index) => <option key={point.id} value={point.id}>Nokta {index + 1}</option>)}</select></Field>
        </div>
        {distance !== null && bearing !== null && delta ? (
          <div className="analysis-grid">
            <span><small>Mesafe</small><strong>{formatNumber(distance, 2)} m</strong></span>
            <span><small>Azimut</small><strong>{formatNumber(bearing, 2)}°</strong></span>
            <span><small>Δ East</small><strong>{formatNumber(delta.east, 2)} m</strong></span>
            <span><small>Δ North</small><strong>{formatNumber(delta.north, 2)} m</strong></span>
          </div>
        ) : <p className="form-note">Farklı iki nokta seçin.</p>}
      </Card>

      <Card title="Koordinat Dönüşümü" icon={<Navigation size={19} />}>
        <Segmented value={convertDirection} options={[{ value: 'utmToLat', label: 'UTM → Enlem/Boylam' }, { value: 'latToUtm', label: 'Enlem/Boylam → UTM' }]} onChange={setConvertDirection} ariaLabel="Dönüşüm yönü" />
        <div className="form-grid three">
          <Field label="Zone"><select value={convertZone} onChange={(event) => setConvertZone(Number(event.target.value))}>{Array.from({ length: 6 }, (_, i) => 32 + i).map((value) => <option key={value}>{value}</option>)}</select></Field>
          <Field label="Yarımküre"><select value={convertHemisphere} onChange={(event) => setConvertHemisphere(event.target.value as 'N' | 'S')}><option value="N">Kuzey</option><option value="S">Güney</option></select></Field>
          <Field label="Datum"><select value={convertDatum} onChange={(event) => setConvertDatum(event.target.value)}><option>WGS84</option><option>ED50</option></select></Field>
        </div>
        <div className="form-grid two">
          <Field label={convertDirection === 'utmToLat' ? 'Easting' : 'Enlem'}><input value={convertA} onChange={(event) => setConvertA(event.target.value)} placeholder={convertDirection === 'utmToLat' ? '500000' : '39.9255'} /></Field>
          <Field label={convertDirection === 'utmToLat' ? 'Northing' : 'Boylam'}><input value={convertB} onChange={(event) => setConvertB(event.target.value)} placeholder={convertDirection === 'utmToLat' ? '4500000' : '32.8663'} /></Field>
        </div>
        <button type="button" className="primary-button" onClick={convert}>Dönüştür</button>
        {convertResult && <output className="conversion-result">{convertResult}</output>}
      </Card>
    </div>
  )
}

function ImportPanel(props: BottomPanelProps) {
  const [readingImport, setReadingImport] = useState(false)
  const [pendingImport, setPendingImport] = useState<{ name: string; size: number; layers: PolygonLayer[] } | null>(null)
  const importFile = async (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0]
    if (!file) return
    setReadingImport(true)
    try {
      const layers = await readSpatialFile(file)
      if (!layers.length) throw new Error('Katman bulunamadı')
      setPendingImport({ name: file.name, size: file.size, layers })
      props.onMessage('Dosya okundu. İçe aktarmadan önce önizlemeyi kontrol edin.', 'info')
    } catch (error) {
      props.onMessage(error instanceof Error ? error.message : 'Dosya okunamadı.', 'error')
      setPendingImport(null)
    } finally {
      setReadingImport(false)
    }
    event.target.value = ''
  }
  const confirmImport = () => {
    if (!pendingImport) return
    props.onImportLayers(pendingImport.layers)
    props.onMessage(`${pendingImport.layers.length} katman haritaya eklendi.`, 'success')
    setPendingImport(null)
  }
  return (
    <div className="panel-stack">
      <Card title="Mekânsal Veri İçe Aktar" subtitle="Önizle, kontrol et ve haritaya ekle" icon={<FileUp size={19} />} tone="green">
        <label className={`dropzone tall${readingImport ? ' is-busy' : ''}`}><Upload size={32} /><strong>{readingImport ? 'Dosya okunuyor…' : 'Dosyayı buraya sürükle veya tıkla'}</strong><small>KML, KMZ, GeoJSON, JSON ve CSV destekleniyor</small><input type="file" accept=".kml,.kmz,.geojson,.json,.csv,text/csv" onChange={importFile} disabled={readingImport} /></label>
      </Card>
      {pendingImport && (
        <Card title="İçe Aktarma Önizlemesi" subtitle={`${pendingImport.name} · ${formatNumber(pendingImport.size / 1024, 1)} KB`} icon={<FileSearch size={19} />} tone="amber">
          <div className="import-summary"><span><small>Katman</small><strong>{pendingImport.layers.length}</strong></span><span><small>Nokta</small><strong>{pendingImport.layers.reduce((sum, layer) => sum + layer.points.length, 0)}</strong></span><span><small>Geçerli geometri</small><strong>{pendingImport.layers.filter((layer) => layer.points.length >= 2).length}</strong></span></div>
          <div className="import-preview-list">{pendingImport.layers.slice(0, 12).map((layer) => <div key={layer.id}><span style={{ background: layer.color }} /><strong>{layer.name}</strong><small>{layer.points.length} nokta · {layer.points.length >= 3 ? 'Poligon' : layer.points.length === 2 ? 'Hat' : 'Nokta'}</small></div>)}{pendingImport.layers.length > 12 && <p>+ {pendingImport.layers.length - 12} katman daha</p>}</div>
          {pendingImport.layers.some((layer) => layer.points.length < 2) && <p className="form-note warning"><AlertTriangle size={13} /> İki noktadan az kayıtlar poligon veya hat oluşturmaz; yine de nokta olarak eklenir.</p>}
          <div className="preview-actions"><button type="button" className="secondary-button" onClick={() => setPendingImport(null)}><X size={16} /> Vazgeç</button><button type="button" className="primary-button" onClick={confirmImport}><CheckCircle2 size={17} /> Haritaya Ekle</button></div>
        </Card>
      )}
    </div>
  )
}

function ExportPanel(props: BottomPanelProps) {
  const [filename, setFilename] = useState('evren-jeofizik-projesi')
  const [csvFormat, setCsvFormat] = useState<CoordinateFormat>('latlon')
  const [reportProject, setReportProject] = useState('Jeofizik Saha Projesi')
  const [reportClient, setReportClient] = useState('')
  const [reportLocation, setReportLocation] = useState('')
  const [reportNotes, setReportNotes] = useState('')
  const [includeMap, setIncludeMap] = useState(true)
  const [reportBusy, setReportBusy] = useState(false)
  const totalPoints = props.polygons.reduce((sum, layer) => sum + layer.points.length, 0)
  const safeName = filename.trim().replace(/[^a-zA-Z0-9ğüşöçıİĞÜŞÖÇ_-]+/g, '-') || 'evren-jeofizik-projesi'

  const exportPdf = async () => {
    setReportBusy(true)
    try {
      await exportProjectPdf({ polygons: props.polygons, filename: safeName, metadata: { projectName: reportProject, client: reportClient, location: reportLocation, notes: reportNotes }, includeMap })
      props.onMessage('Gelişmiş PDF raporu hazırlandı.', 'success')
    } catch {
      props.onMessage('PDF raporu hazırlanamadı.', 'error')
    } finally {
      setReportBusy(false)
    }
  }

  return (
    <div className="panel-stack">
      <Card title="Dışa Aktar" subtitle={`Tüm poligonlar · ${props.polygons.length} katman`} icon={<Download size={19} />}>
        <Field label="Dosya adı"><input value={filename} onChange={(event) => setFilename(event.target.value)} placeholder="polygon_1" /></Field>
        <Field label="CSV Formatı"><select value={csvFormat} onChange={(event) => setCsvFormat(event.target.value as CoordinateFormat)}>{coordinateOptions.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}</select></Field>
        <div className="export-grid">
          <button type="button" disabled={!totalPoints} onClick={() => downloadBlob(polygonsToKml(props.polygons), `${safeName}.kml`, 'application/vnd.google-earth.kml+xml')}><FileDown size={20} /><strong>KML</strong></button>
          <button type="button" disabled={!totalPoints} onClick={() => downloadKmz(props.polygons, safeName)}><FileDown size={20} /><strong>KMZ</strong></button>
          <button type="button" disabled={!totalPoints} onClick={() => downloadBlob(JSON.stringify(polygonsToGeoJson(props.polygons), null, 2), `${safeName}.geojson`, 'application/geo+json')}><FileDown size={20} /><strong>GeoJSON</strong></button>
          <button type="button" disabled={!totalPoints} onClick={() => downloadBlob(polygonsToCsv(props.polygons, csvFormat), `${safeName}.csv`, 'text/csv;charset=utf-8')}><FileDown size={20} /><strong>CSV</strong></button>
        </div>
        {!totalPoints && <p className="form-note warning">Dışa aktarmak için koordinat ekleyin.</p>}
      </Card>
      <Card title="Gelişmiş PDF Raporu" subtitle="Harita, proje bilgileri, koordinat ve kenar tabloları" icon={<FileSearch size={19} />} tone="amber">
        <Field label="Proje adı"><input value={reportProject} onChange={(event) => setReportProject(event.target.value)} placeholder="Jeofizik Saha Projesi" /></Field>
        <div className="form-grid two"><Field label="Müşteri"><input value={reportClient} onChange={(event) => setReportClient(event.target.value)} placeholder="Müşteri / kurum" /></Field><Field label="Konum"><input value={reportLocation} onChange={(event) => setReportLocation(event.target.value)} placeholder="İl, ilçe, saha" /></Field></div>
        <Field label="Rapor notu"><textarea rows={3} value={reportNotes} onChange={(event) => setReportNotes(event.target.value)} placeholder="Çalışma amacı ve saha notları…" /></Field>
        <label className="check-row"><input type="checkbox" checked={includeMap} onChange={(event) => setIncludeMap(event.target.checked)} /><span><strong>Harita görüntüsünü ekle</strong><small>Mevcut harita görünümü rapor kapağına yerleştirilir.</small></span></label>
        <button type="button" className={`primary-button amber${reportBusy ? ' is-busy' : ''}`} onClick={exportPdf} disabled={!totalPoints || reportBusy}><FileDown size={18} /> {reportBusy ? 'Rapor Hazırlanıyor…' : 'Gelişmiş PDF İndir'}</button>
        {!totalPoints && <p className="form-note">Rapor için koordinat ekleyin.</p>}
      </Card>
    </div>
  )
}

function SettingsPanel(props: BottomPanelProps) {
  const [confirmingClear, setConfirmingClear] = useState(false)

  const setAllCards = (visible: boolean) => {
    props.onSetDisplaySettings({
      ...props.displaySettings,
      coordinateCard: visible,
      areaCard: visible,
      mapActions: visible,
      measurementCard: visible,
      locationCard: visible,
      headerStats: visible,
    })
  }

  const clearAllData = () => {
    props.onClearAllData()
    setConfirmingClear(false)
  }

  return (
    <div className="panel-stack">
      <Card title="Ekran Kartları" subtitle="Haritada görmek istediklerinizi seçin" icon={<Eye size={19} />} tone="green">
        <div className="settings-quick-actions">
          <button type="button" onClick={() => setAllCards(true)}><Eye size={16} /> Tümünü Göster</button>
          <button type="button" onClick={() => setAllCards(false)}><EyeOff size={16} /> Tümünü Gizle</button>
        </div>
        <div className="settings-toggle-list">
          {visibilityOptions.map((option) => (
            <label key={option.key} className="setting-toggle">
              <span><strong>{option.label}</strong><small>{option.description}</small></span>
              <input
                type="checkbox"
                checked={props.displaySettings[option.key]}
                onChange={(event) => props.onSetDisplaySettings({ ...props.displaySettings, [option.key]: event.target.checked })}
              />
            </label>
          ))}
        </div>
      </Card>

      <Card title="Kart Ölçeği" subtitle="Harita kartlarını yüzde olarak ayarlayın" icon={<SlidersHorizontal size={19} />} tone="purple">
        <div className="card-scale-control">
          <div className="card-scale-heading"><span>Ölçek</span><output>{props.displaySettings.cardScale}%</output></div>
          <input
            className="card-scale-range"
            type="range"
            min="70"
            max="160"
            step="5"
            value={props.displaySettings.cardScale}
            aria-label="Harita kartı ölçeği"
            aria-valuetext={`${props.displaySettings.cardScale}%`}
            onChange={(event) => props.onSetDisplaySettings({ ...props.displaySettings, cardScale: Number(event.target.value) })}
          />
          <div className="card-scale-marks" aria-hidden="true"><span>70%</span><span>100%</span><span>130%</span><span>160%</span></div>
          <button type="button" className="scale-reset-button" disabled={props.displaySettings.cardScale === 100} onClick={() => props.onSetDisplaySettings({ ...props.displaySettings, cardScale: 100 })}>Ölçeği %100 yap</button>
        </div>
        <p className="form-note">Koordinat, alan, işlem, konum ve ölçüm kartları aynı oranda büyür veya küçülür.</p>
      </Card>

      <Card title="Tüm Verileri Sil" subtitle="Bu cihazdaki çalışma verilerini temizler" icon={<Trash2 size={19} />} tone="amber">
        <p className="danger-zone-copy">Tüm poligonlar, koordinatlar, DES noktaları ve ölçümler kalıcı olarak silinir. Ekran ayarlarınız korunur.</p>
        {!confirmingClear ? (
          <button type="button" className="danger-button" onClick={() => setConfirmingClear(true)}><Trash2 size={17} /> Tüm Verileri Sil</button>
        ) : (
          <div className="danger-confirm" role="alert">
            <span><AlertTriangle size={18} /><strong>Bu işlem geri alınamaz. Emin misiniz?</strong></span>
            <div>
              <button type="button" onClick={() => setConfirmingClear(false)}>Vazgeç</button>
              <button type="button" className="confirm-delete" onClick={clearAllData}>Evet, Kalıcı Sil</button>
            </div>
          </div>
        )}
      </Card>
    </div>
  )
}

export default function BottomPanel(props: BottomPanelProps) {
  return (
    <aside className="workspace-panel" aria-label={panelTitles[props.panel]}>
      <div className="workspace-panel-title"><span>{panelTitles[props.panel]}</span><button type="button" onClick={props.onClose} aria-label="Paneli kapat"><X size={19} /></button></div>
      <div className="workspace-panel-scroll">
        {props.panel === 'layers' && <LayerPanel {...props} />}
        {props.panel === 'coordinates' && <CoordinatePanel {...props} />}
        {props.panel === 'tools' && <ToolsPanel {...props} />}
        {props.panel === 'import' && <ImportPanel {...props} />}
        {props.panel === 'export' && <ExportPanel {...props} />}
        {props.panel === 'settings' && <SettingsPanel {...props} />}
      </div>
      <div className="panel-resize-cue"><ChevronDown size={15} /></div>
    </aside>
  )
}
