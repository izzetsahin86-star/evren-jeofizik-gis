import { useEffect, useMemo, useState } from 'react'
import {
  Activity,
  BarChart3,
  Download,
  Layers3,
  RefreshCw,
  Save,
  SlidersHorizontal,
  Sparkles,
  X,
} from 'lucide-react'
import {
  createInitialLayers,
  curveTypeFromLayers,
  fitLayerModel,
  fitTone,
  logRms,
  prepareObserved,
  responseFor,
  type DesLayerModel,
  type ObservedPoint,
} from './DESProfessionalEngine'
import './DESProfessionalFeature.css'

const RECORDS_KEY = 'evren-jeofizik-gis-des-analysis-v1'
const MODELS_KEY = 'evren-jeofizik-gis-des-professional-v2'
const OPEN_EVENT = 'evren-open-des-professional'
const CLEAR_LABEL = 'Evet, Kalıcı Sil'

type DesMeasurement = {
  ab2: number
  mn: number
  rho: number
}

type DesRecord = {
  id: string
  name: string
  number: number | null
  fileName: string
  province: string
  district: string
  easting: number | null
  northing: number | null
  elevation: number | null
  zone: number
  hemisphere: 'N' | 'S'
  note: string
  measurements: DesMeasurement[]
}

type SavedModel = {
  recordId: string
  layers: DesLayerModel[]
  rms: number
  curveType: string
  method: string
  updatedAt: number
}

function finiteOrNull(value: unknown) {
  if (value === '' || value === null || value === undefined) return null
  const number = Number(value)
  return Number.isFinite(number) ? number : null
}

function readRecords(): DesRecord[] {
  try {
    const raw = JSON.parse(localStorage.getItem(RECORDS_KEY) || '[]') as Array<Partial<DesRecord>>
    if (!Array.isArray(raw)) return []
    return raw.flatMap((item, index) => {
      if (!Array.isArray(item.measurements)) return []
      const measurements = item.measurements.flatMap((measurement) => {
        const ab2 = Number(measurement.ab2)
        const mn = Number(measurement.mn)
        const rho = Number(measurement.rho)
        if (!Number.isFinite(ab2) || ab2 <= 0 || !Number.isFinite(rho) || rho <= 0) return []
        return [{ ab2, mn: Number.isFinite(mn) ? mn : 0, rho }]
      })
      if (measurements.length < 3) return []
      return [{
        id: typeof item.id === 'string' && item.id ? item.id : `des-${index}`,
        name: typeof item.name === 'string' && item.name ? item.name : `DES ${index + 1}`,
        number: finiteOrNull(item.number),
        fileName: typeof item.fileName === 'string' ? item.fileName : '',
        province: typeof item.province === 'string' ? item.province : '',
        district: typeof item.district === 'string' ? item.district : '',
        easting: finiteOrNull(item.easting),
        northing: finiteOrNull(item.northing),
        elevation: finiteOrNull(item.elevation),
        zone: Math.max(1, Math.min(60, Math.round(Number(item.zone) || 36))),
        hemisphere: item.hemisphere === 'S' ? 'S' : 'N',
        note: typeof item.note === 'string' ? item.note : '',
        measurements,
      }]
    })
  } catch {
    return []
  }
}

function readModels(): Record<string, SavedModel> {
  try {
    const raw = JSON.parse(localStorage.getItem(MODELS_KEY) || '{}') as Record<string, Partial<SavedModel>>
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {}
    const next: Record<string, SavedModel> = {}
    Object.entries(raw).forEach(([key, value]) => {
      if (!value || !Array.isArray(value.layers) || value.layers.length < 3) return
      const layers = value.layers.map((layer, index) => ({
        id: typeof layer.id === 'string' ? layer.id : `layer-${index + 1}`,
        rho: Math.max(0.2, Number(layer.rho) || 100),
        thickness: index === value.layers!.length - 1 ? null : Math.max(0.5, Number(layer.thickness) || 10),
        interpretation: typeof layer.interpretation === 'string' ? layer.interpretation : '',
      }))
      next[key] = {
        recordId: key,
        layers,
        rms: Number(value.rms) || 0,
        curveType: typeof value.curveType === 'string' ? value.curveType : '–',
        method: typeof value.method === 'string' ? value.method : '',
        updatedAt: Number(value.updatedAt) || Date.now(),
      }
    })
    return next
  } catch {
    return {}
  }
}

function niceLogTicks(min: number, max: number) {
  const values: number[] = []
  const start = Math.floor(Math.log10(min)) - 1
  const end = Math.ceil(Math.log10(max)) + 1
  for (let power = start; power <= end; power += 1) {
    ;[1, 2, 5].forEach((multiplier) => {
      const value = multiplier * 10 ** power
      if (value >= min && value <= max) values.push(value)
    })
  }
  return values
}

function ModelCurve({ observed, response, name }: { observed: ObservedPoint[]; response: number[]; name: string }) {
  if (!observed.length) return null
  const allY = [...observed.map((point) => point.rho), ...response.filter((value) => value > 0)]
  const minX = Math.max(0.1, Math.min(...observed.map((point) => point.ab2)) * 0.86)
  const maxX = Math.max(...observed.map((point) => point.ab2)) * 1.16
  const minY = Math.max(0.01, Math.min(...allY) * 0.72)
  const maxY = Math.max(...allY) * 1.38
  const width = 820
  const height = 400
  const left = 72
  const right = 24
  const top = 24
  const bottom = 56
  const innerW = width - left - right
  const innerH = height - top - bottom
  const lx0 = Math.log10(minX)
  const lx1 = Math.log10(maxX)
  const ly0 = Math.log10(minY)
  const ly1 = Math.log10(maxY)
  const x = (value: number) => left + (Math.log10(value) - lx0) / (lx1 - lx0) * innerW
  const y = (value: number) => top + (ly1 - Math.log10(value)) / (ly1 - ly0) * innerH
  const observedPoints = observed.map((point) => `${x(point.ab2)},${y(point.rho)}`).join(' ')
  const responsePoints = observed.map((point, index) => `${x(point.ab2)},${y(Math.max(0.001, response[index] || point.rho))}`).join(' ')

  return (
    <div className="despro-chart-card">
      <div className="despro-card-title"><div><strong>Gözlenen / Hesaplanan Eğri</strong><small>{name} · Schlumberger 1B</small></div><BarChart3 size={18} /></div>
      <svg viewBox={`0 0 ${width} ${height}`} className="despro-chart" role="img" aria-label={`${name} gözlenen ve hesaplanan DES eğrisi`}>
        <rect x={left} y={top} width={innerW} height={innerH} className="despro-chart-bg" />
        {niceLogTicks(minX, maxX).map((tick) => <g key={`x-${tick}`}><line x1={x(tick)} y1={top} x2={x(tick)} y2={top + innerH} className="despro-grid" /><text x={x(tick)} y={height - 28} textAnchor="middle" className="despro-axis-text">{tick}</text></g>)}
        {niceLogTicks(minY, maxY).map((tick) => <g key={`y-${tick}`}><line x1={left} y1={y(tick)} x2={left + innerW} y2={y(tick)} className="despro-grid" /><text x={left - 11} y={y(tick) + 4} textAnchor="end" className="despro-axis-text">{tick}</text></g>)}
        <polyline points={observedPoints} className="despro-observed-line" />
        <polyline points={responsePoints} className="despro-response-line" />
        {observed.map((point) => <circle key={point.ab2} cx={x(point.ab2)} cy={y(point.rho)} r="4.2" className="despro-observed-dot"><title>{`AB/2 ${point.ab2} m · ρa ${point.rho.toFixed(2)} Ωm${point.count > 1 ? ` · ${point.count} tekrar ortalaması` : ''}`}</title></circle>)}
        <line x1={left} y1={top + innerH} x2={left + innerW} y2={top + innerH} className="despro-axis" />
        <line x1={left} y1={top} x2={left} y2={top + innerH} className="despro-axis" />
        <text x={left + innerW / 2} y={height - 5} textAnchor="middle" className="despro-axis-title">AB/2 (m) · log</text>
        <text transform={`translate(18 ${top + innerH / 2}) rotate(-90)`} textAnchor="middle" className="despro-axis-title">ρa (Ωm) · log</text>
      </svg>
      <div className="despro-legend"><span><i className="observed" />Gözlenen</span><span><i className="calculated" />Hesaplanan 1B</span></div>
    </div>
  )
}

function rhoHue(rho: number, min: number, max: number) {
  const lo = Math.log10(Math.max(0.1, min))
  const hi = Math.log10(Math.max(min * 1.01, max))
  const t = (Math.log10(Math.max(0.1, rho)) - lo) / Math.max(0.001, hi - lo)
  return 210 - Math.max(0, Math.min(1, t)) * 175
}

function LayerLog({ layers }: { layers: DesLayerModel[] }) {
  const finiteDepth = layers.slice(0, -1).reduce((sum, layer) => sum + (layer.thickness || 0), 0)
  const maxDepth = Math.max(10, finiteDepth * 1.18)
  const minRho = Math.min(...layers.map((layer) => layer.rho))
  const maxRho = Math.max(...layers.map((layer) => layer.rho))
  let topDepth = 0
  return (
    <div className="despro-log-card">
      <div className="despro-card-title"><div><strong>1B Elektriksel Model</strong><small>Tabaka özdirenci ve sınır derinlikleri</small></div><Layers3 size={18} /></div>
      <div className="despro-log-body">
        <div className="despro-depth-axis"><span>0 m</span><span>{(maxDepth / 2).toFixed(0)} m</span><span>{maxDepth.toFixed(0)} m</span></div>
        <div className="despro-log-column">
          {layers.map((layer, index) => {
            const start = topDepth
            const thickness = layer.thickness ?? Math.max(12, maxDepth - start)
            topDepth += layer.thickness || 0
            const height = Math.max(34, thickness / maxDepth * 430)
            const hue = rhoHue(layer.rho, minRho, maxRho)
            return <div key={layer.id} className="despro-log-layer" style={{ height, background: `hsl(${hue} 55% 34%)` }}><strong>{index + 1}. Tabaka</strong><span>{layer.rho.toFixed(1)} Ωm</span><small>{layer.thickness === null ? `${start.toFixed(1)} m +` : `${start.toFixed(1)}–${(start + thickness).toFixed(1)} m`}</small>{layer.interpretation ? <em>{layer.interpretation}</em> : null}</div>
          })}
        </div>
      </div>
    </div>
  )
}

function downloadModel(record: DesRecord, observed: ObservedPoint[], response: number[], layers: DesLayerModel[], rms: number, curveType: string) {
  const rows: Array<Array<string | number>> = [
    ['EVREN GIS DES PROFESSIONAL STUDIO'],
    ['DES', record.name],
    ['Dosya', record.fileName],
    ['Log RMS %', rms.toFixed(3)],
    ['Eğri Tipi', curveType],
    [],
    ['TABAKA', 'OZDIRENC_OHM_M', 'KALINLIK_M', 'TABAN_DERINLIK_M', 'JEOLOJIK_YORUM'],
  ]
  let depth = 0
  layers.forEach((layer, index) => {
    if (layer.thickness !== null) depth += layer.thickness
    rows.push([index + 1, layer.rho.toFixed(4), layer.thickness === null ? 'YARI_SONSUZ' : layer.thickness.toFixed(4), layer.thickness === null ? '' : depth.toFixed(4), layer.interpretation])
  })
  rows.push([], ['AB2_M', 'GOZLENEN_RHOA', 'HESAPLANAN_RHOA', 'TEKRAR_SAYISI'])
  observed.forEach((point, index) => rows.push([point.ab2, point.rho.toFixed(6), (response[index] || 0).toFixed(6), point.count]))
  const csv = '\ufeff' + rows.map((row) => row.map((cell) => `"${String(cell ?? '').replace(/"/g, '""')}"`).join(';')).join('\r\n')
  const blob = new Blob([csv], { type: 'text/csv;charset=utf-8' })
  const url = URL.createObjectURL(blob)
  const link = document.createElement('a')
  link.href = url
  link.download = `${record.name.replace(/[^A-Za-z0-9_-]+/g, '-')}-1B-model.csv`
  document.body.appendChild(link)
  link.click()
  link.remove()
  window.setTimeout(() => URL.revokeObjectURL(url), 500)
}

export default function DESProfessionalFeature() {
  const [open, setOpen] = useState(false)
  const [records, setRecords] = useState<DesRecord[]>(readRecords)
  const [selectedId, setSelectedId] = useState<string | null>(() => readRecords()[0]?.id ?? null)
  const [models, setModels] = useState<Record<string, SavedModel>>(readModels)
  const [layers, setLayers] = useState<DesLayerModel[]>([])
  const [busy, setBusy] = useState(false)
  const [status, setStatus] = useState('')
  const selected = records.find((record) => record.id === selectedId) ?? records[0] ?? null
  const observed = useMemo(() => prepareObserved(selected?.measurements || []), [selected])

  const loadLayersFor = (record: DesRecord | null, currentModels = models) => {
    if (!record) { setLayers([]); return }
    const observedData = prepareObserved(record.measurements)
    const saved = currentModels[record.id]
    setLayers(saved?.layers?.length ? saved.layers.map((layer) => ({ ...layer })) : createInitialLayers(observedData, 4))
  }

  useEffect(() => {
    const show = () => {
      const nextRecords = readRecords()
      const nextModels = readModels()
      setRecords(nextRecords)
      setModels(nextModels)
      const target = nextRecords.find((record) => record.id === selectedId) ?? nextRecords[0] ?? null
      setSelectedId(target?.id ?? null)
      loadLayersFor(target, nextModels)
      setStatus('')
      setOpen(true)
    }
    window.addEventListener(OPEN_EVENT, show)
    return () => window.removeEventListener(OPEN_EVENT, show)
  })

  useEffect(() => {
    const refresh = () => {
      const next = readRecords()
      setRecords(next)
      const target = next.find((record) => record.id === selectedId) ?? next[0] ?? null
      setSelectedId(target?.id ?? null)
      loadLayersFor(target)
    }
    window.addEventListener('evren-des-analysis-changed', refresh)
    return () => window.removeEventListener('evren-des-analysis-changed', refresh)
  })

  useEffect(() => {
    if (!open) return
    const previous = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    const close = (event: KeyboardEvent) => { if (event.key === 'Escape') setOpen(false) }
    window.addEventListener('keydown', close)
    return () => { document.body.style.overflow = previous; window.removeEventListener('keydown', close) }
  }, [open])

  useEffect(() => {
    const clear = (event: MouseEvent) => {
      const target = event.target
      if (!(target instanceof Element)) return
      const button = target.closest<HTMLButtonElement>('button.confirm-delete')
      if (!button || button.textContent?.trim() !== CLEAR_LABEL) return
      localStorage.removeItem(MODELS_KEY)
      setModels({})
      setLayers([])
    }
    document.addEventListener('click', clear, true)
    return () => document.removeEventListener('click', clear, true)
  }, [])

  const response = useMemo(() => responseFor(observed, layers), [observed, layers])
  const rms = useMemo(() => logRms(observed, response), [observed, response])
  const curveType = useMemo(() => curveTypeFromLayers(layers), [layers])
  const fit = fitTone(rms)
  const modelDepth = layers.slice(0, -1).reduce((sum, layer) => sum + (layer.thickness || 0), 0)

  const chooseRecord = (record: DesRecord) => {
    setSelectedId(record.id)
    loadLayersFor(record)
    setStatus('')
  }

  const setLayerCount = (count: number) => {
    setLayers(createInitialLayers(observed, count))
    setStatus(`${count} tabakalı yeni başlangıç modeli oluşturuldu.`)
  }

  const updateLayer = (index: number, patch: Partial<DesLayerModel>) => {
    setLayers((current) => current.map((layer, layerIndex) => layerIndex === index ? { ...layer, ...patch } : layer))
  }

  const autoFit = () => {
    if (!selected || observed.length < 4 || layers.length < 3) return
    setBusy(true)
    setStatus('1B model otomatik uyumlanıyor…')
    window.setTimeout(() => {
      const result = fitLayerModel(observed, layers.length, layers)
      setLayers(result.layers)
      setStatus(`Otomatik uyum tamamlandı · Log RMS ${result.rms.toFixed(2)}% · ${result.iterations} arama adımı.`)
      setBusy(false)
    }, 30)
  }

  const resetModel = () => {
    if (!selected) return
    const saved = models[selected.id]
    setLayers(saved?.layers?.length ? saved.layers.map((layer) => ({ ...layer })) : createInitialLayers(observed, 4))
    setStatus(saved ? 'Son kaydedilen modele dönüldü.' : 'Başlangıç modeli yeniden oluşturuldu.')
  }

  const saveModel = () => {
    if (!selected || !layers.length) return
    const saved: SavedModel = {
      recordId: selected.id,
      layers: layers.map((layer) => ({ ...layer })),
      rms,
      curveType,
      method: 'Schlumberger · Ghosh tipi 9 noktalı dijital filtre yaklaşımı · log-uzay uyum',
      updatedAt: Date.now(),
    }
    const next = { ...models, [selected.id]: saved }
    setModels(next)
    localStorage.setItem(MODELS_KEY, JSON.stringify(next))
    setStatus('1B DES modeli kaydedildi. Ham DES verisi değiştirilmedi.')
  }

  if (!open) return null

  return (
    <div className="despro-overlay" role="dialog" aria-modal="true" aria-label="DES Professional Studio">
      <section className="despro-shell">
        <header className="despro-header">
          <div className="despro-title"><span><Activity size={23} /></span><div><small>EVREN GIS · JEOFİZİK MODELLEME</small><h2>DES Professional Studio</h2></div></div>
          <button type="button" className="despro-close" onClick={() => setOpen(false)} aria-label="Kapat"><X size={20} /></button>
        </header>

        {!records.length ? (
          <div className="despro-empty"><Activity size={38} /><strong>Önce DES verisi yükleyin</strong><span>Professional Studio, DES Analiz V1 içindeki ham Excel kayıtlarını güvenli biçimde okur.</span><button type="button" onClick={() => { setOpen(false); window.dispatchEvent(new CustomEvent('evren-open-des-analysis')) }}>DES Analiz'i Aç</button></div>
        ) : (
          <div className="despro-layout">
            <aside className="despro-sidebar">
              <div className="despro-sidebar-head"><strong>DES Kayıtları</strong><small>{records.length} ölçüm noktası</small></div>
              <div className="despro-records">{records.map((record) => <button type="button" key={record.id} className={record.id === selected?.id ? 'is-active' : ''} onClick={() => chooseRecord(record)}><span /><div><strong>{record.name}</strong><small>{record.measurements.length} ham ölçüm · {models[record.id] ? 'Model kayıtlı' : 'Model yok'}</small></div></button>)}</div>
              <div className="despro-sidebar-note"><strong>Veri güvenliği</strong><span>Bu ekran V1 ham DES kayıtlarını değiştirmez. 1B modeller ayrı depolanır.</span></div>
            </aside>

            <main className="despro-main">
              {selected ? <>
                <div className="despro-toolbar">
                  <div><small>SEÇİLİ DES</small><h3>{selected.name}</h3><span>{[selected.province, selected.district].filter(Boolean).join(' · ') || selected.fileName}</span></div>
                  <div className="despro-toolbar-actions">
                    <button type="button" onClick={resetModel}><RefreshCw size={15} /> Geri Al</button>
                    <button type="button" className="primary" onClick={saveModel}><Save size={15} /> Modeli Kaydet</button>
                  </div>
                </div>

                <div className="despro-stats">
                  <span><strong>{observed.length}</strong><small>Benzersiz AB/2</small></span>
                  <span><strong>{layers.length}</strong><small>Tabaka</small></span>
                  <span className={`tone-${fit.tone}`}><strong>{Number.isFinite(rms) ? `${rms.toFixed(2)}%` : '–'}</strong><small>Log RMS · {fit.label}</small></span>
                  <span><strong>{curveType}</strong><small>Model eğri tipi</small></span>
                  <span><strong>{modelDepth.toFixed(1)} m+</strong><small>Sonlu model derinliği</small></span>
                </div>

                <section className="despro-fit-panel">
                  <div className="despro-fit-head"><div><SlidersHorizontal size={18} /><span><strong>1B Katmanlı Yer Modeli</strong><small>3–6 tabaka seçin; otomatik uyumdan sonra değerleri elle hassaslaştırabilirsiniz.</small></span></div><div className="despro-layer-count">{[3, 4, 5, 6].map((count) => <button type="button" key={count} className={layers.length === count ? 'is-active' : ''} onClick={() => setLayerCount(count)}>{count}</button>)}</div><button type="button" className="despro-fit-button" onClick={autoFit} disabled={busy}><Sparkles size={16} /> {busy ? 'Hesaplanıyor…' : 'Otomatik Uyumla'}</button></div>
                  <div className="despro-method-note"><strong>Yöntem:</strong> Schlumberger 1B katmanlı yer, Ghosh tipi 9 noktalı dijital filtre yaklaşımı ve pozitif log-parametre araması. Tekrarlı AB/2 değerleri inversiyonda geometrik ortalama ile tek noktaya indirilir.</div>
                </section>

                {status ? <div className="despro-status">{status}</div> : null}

                <div className="despro-visual-grid"><ModelCurve observed={observed} response={response} name={selected.name} /><LayerLog layers={layers} /></div>

                <section className="despro-layer-editor">
                  <div className="despro-section-head"><div><strong>Tabaka Parametreleri</strong><small>Elektriksel model ile jeolojik yorumu ayrı tutun.</small></div><button type="button" onClick={() => downloadModel(selected, observed, response, layers, rms, curveType)}><Download size={15} /> Model CSV</button></div>
                  <div className="despro-layer-table">
                    <div className="despro-layer-row header"><span>Tabaka</span><span>Özdirenç (Ωm)</span><span>Kalınlık (m)</span><span>Taban derinliği</span><span>Jeolojik yorum</span></div>
                    {layers.map((layer, index) => {
                      const bottom = layers.slice(0, index + 1).reduce((sum, item) => sum + (item.thickness || 0), 0)
                      return <div className="despro-layer-row" key={layer.id}><strong>{index + 1}</strong><label><input inputMode="decimal" value={Number(layer.rho.toFixed(4))} onChange={(event) => updateLayer(index, { rho: Math.max(0.2, Number(event.target.value) || 0.2) })} /></label><label>{layer.thickness === null ? <span className="despro-halfspace">Yarı sonsuz</span> : <input inputMode="decimal" value={Number(layer.thickness.toFixed(4))} onChange={(event) => updateLayer(index, { thickness: Math.max(0.5, Number(event.target.value) || 0.5) })} />}</label><span>{layer.thickness === null ? '–' : `${bottom.toFixed(2)} m`}</span><label><input value={layer.interpretation} onChange={(event) => updateLayer(index, { interpretation: event.target.value })} placeholder="Örn. kırıklı zon / kil / kireçtaşı" /></label></div>
                    })}
                  </div>
                </section>

                <div className="despro-warning"><strong>Profesyonel yorum notu</strong><span>Bu sonuç elektriksel 1B yer modelidir. Özdirenç tek başına litolojiyi kesin belirlemez; sondaj, saha jeolojisi ve diğer jeofizik verilerle kalibre edilmelidir. Farklı tabaka modelleri benzer DES eğrileri üretebilir.</span></div>
              </> : null}
            </main>
          </div>
        )}
      </section>
    </div>
  )
}
