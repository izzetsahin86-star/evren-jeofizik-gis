import { useEffect, useMemo, useState } from 'react'
import {
  Activity,
  AlertTriangle,
  CheckCircle2,
  Download,
  Layers3,
  RefreshCw,
  Save,
  Sparkles,
  X,
} from 'lucide-react'
import { prepareObserved, type DesLayerModel, type ObservedPoint } from './DESProfessionalEngine'
import {
  finalizeDualAnalysis,
  runDualLayerCount,
  type DualAnalysisResult,
  type DualLayerResult,
} from './DESDualInversionEngine'
import './DESDualInversionFeature.css'

const RECORDS_KEY = 'evren-jeofizik-gis-des-analysis-v1'
const DUAL_KEY = 'evren-jeofizik-gis-des-dual-inversion-v1'
const PROFESSIONAL_KEY = 'evren-jeofizik-gis-des-professional-v2'
const OPEN_EVENT = 'evren-open-des-dual-inversion'
const CLEAR_LABEL = 'Evet, Kalıcı Sil'

type DesMeasurement = { ab2: number; mn: number; rho: number }
type DesRecord = {
  id: string
  name: string
  fileName: string
  province: string
  district: string
  measurements: DesMeasurement[]
}

type ProfessionalStore = Record<string, {
  recordId: string
  layers: DesLayerModel[]
  rms: number
  curveType: string
  method: string
  updatedAt: number
}>

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
      if (measurements.length < 4) return []
      return [{
        id: typeof item.id === 'string' && item.id ? item.id : `des-${index}`,
        name: typeof item.name === 'string' && item.name ? item.name : `DES ${index + 1}`,
        fileName: typeof item.fileName === 'string' ? item.fileName : '',
        province: typeof item.province === 'string' ? item.province : '',
        district: typeof item.district === 'string' ? item.district : '',
        measurements,
      }]
    })
  } catch {
    return []
  }
}

function readSaved() {
  try {
    const raw = JSON.parse(localStorage.getItem(DUAL_KEY) || '{}') as Record<string, DualAnalysisResult>
    return raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {}
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

function DualCurve({ observed, result }: { observed: ObservedPoint[]; result: DualLayerResult }) {
  const series = [result.motorA.response, result.motorB.response, result.consensusResponse]
  const allY = [...observed.map((point) => point.rho), ...series.flat()].filter((value) => value > 0)
  if (!observed.length || !allY.length) return null
  const minX = Math.max(0.1, Math.min(...observed.map((point) => point.ab2)) * 0.85)
  const maxX = Math.max(...observed.map((point) => point.ab2)) * 1.16
  const minY = Math.max(0.01, Math.min(...allY) * 0.7)
  const maxY = Math.max(...allY) * 1.4
  const width = 850
  const height = 405
  const left = 72
  const right = 24
  const top = 24
  const bottom = 58
  const innerW = width - left - right
  const innerH = height - top - bottom
  const lx0 = Math.log10(minX)
  const lx1 = Math.log10(maxX)
  const ly0 = Math.log10(minY)
  const ly1 = Math.log10(maxY)
  const x = (value: number) => left + (Math.log10(value) - lx0) / (lx1 - lx0) * innerW
  const y = (value: number) => top + (ly1 - Math.log10(value)) / (ly1 - ly0) * innerH
  const pathFor = (values: number[]) => observed.map((point, index) => `${x(point.ab2)},${y(Math.max(0.001, values[index] || point.rho))}`).join(' ')

  return (
    <div className="desdual-chart-card">
      <div className="desdual-card-head"><div><strong>İki Motor + Konsensus Eğrisi</strong><small>Önerilen {result.layerCount} tabakalı model</small></div><Activity size={18} /></div>
      <svg viewBox={`0 0 ${width} ${height}`} className="desdual-chart" role="img" aria-label="DES çift inversiyon karşılaştırma eğrisi">
        <rect x={left} y={top} width={innerW} height={innerH} className="desdual-chart-bg" />
        {niceLogTicks(minX, maxX).map((tick) => <g key={`x-${tick}`}><line x1={x(tick)} y1={top} x2={x(tick)} y2={top + innerH} className="desdual-grid" /><text x={x(tick)} y={height - 31} textAnchor="middle" className="desdual-axis-text">{tick}</text></g>)}
        {niceLogTicks(minY, maxY).map((tick) => <g key={`y-${tick}`}><line x1={left} y1={y(tick)} x2={left + innerW} y2={y(tick)} className="desdual-grid" /><text x={left - 11} y={y(tick) + 4} textAnchor="end" className="desdual-axis-text">{tick}</text></g>)}
        <polyline points={pathFor(result.motorA.response)} className="desdual-line motor-a" />
        <polyline points={pathFor(result.motorB.response)} className="desdual-line motor-b" />
        <polyline points={pathFor(result.consensusResponse)} className="desdual-line consensus" />
        <polyline points={observed.map((point) => `${x(point.ab2)},${y(point.rho)}`).join(' ')} className="desdual-line observed" />
        {observed.map((point) => <circle key={point.ab2} cx={x(point.ab2)} cy={y(point.rho)} r="4" className="desdual-dot"><title>{`AB/2 ${point.ab2} m · ρa ${point.rho.toFixed(2)} Ωm`}</title></circle>)}
        <line x1={left} y1={top + innerH} x2={left + innerW} y2={top + innerH} className="desdual-axis" />
        <line x1={left} y1={top} x2={left} y2={top + innerH} className="desdual-axis" />
        <text x={left + innerW / 2} y={height - 5} textAnchor="middle" className="desdual-axis-title">AB/2 (m) · log</text>
        <text transform={`translate(18 ${top + innerH / 2}) rotate(-90)`} textAnchor="middle" className="desdual-axis-title">ρa (Ωm) · log</text>
      </svg>
      <div className="desdual-legend"><span><i className="observed" />Gözlenen</span><span><i className="motor-a" />Motor A</span><span><i className="motor-b" />Motor B</span><span><i className="consensus" />Konsensus</span></div>
    </div>
  )
}

function downloadAnalysis(record: DesRecord, analysis: DualAnalysisResult) {
  const recommended = analysis.recommended
  const rows: Array<Array<string | number>> = [
    ['EVREN GIS DES DUAL INVERSION'],
    ['DES', record.name],
    ['Önerilen tabaka', recommended.layerCount],
    ['Güven', analysis.confidenceLabel],
    ['İç tutarlılık %', recommended.consistency.toFixed(2)],
    ['Motor A RMS %', recommended.motorA.rms.toFixed(3)],
    ['Motor B RMS %', recommended.motorB.rms.toFixed(3)],
    ['Konsensus RMS %', recommended.consensusRms.toFixed(3)],
    ['Ortalama BIC', recommended.meanBic.toFixed(3)],
    [],
    ['MODEL_TARAMA', 'MOTOR_A_RMS', 'MOTOR_B_RMS', 'KONSENSUS_RMS', 'RHO_FARK_%', 'H_FARK_%', 'EGRI_FARK_%', 'TUTARLILIK_%', 'ORT_BIC', 'SECIM_SKORU'],
  ]
  analysis.results.forEach((item) => rows.push([
    `${item.layerCount} tabaka`, item.motorA.rms.toFixed(3), item.motorB.rms.toFixed(3), item.consensusRms.toFixed(3),
    item.rhoDifferencePct.toFixed(2), item.thicknessDifferencePct.toFixed(2), item.curveDifferencePct.toFixed(2),
    item.consistency.toFixed(2), item.meanBic.toFixed(3), item.selectionScore.toFixed(3),
  ]))
  rows.push([], ['TABAKA', 'A_RHO', 'A_H', 'B_RHO', 'B_H', 'KONSENSUS_RHO', 'KONSENSUS_H', 'TABAN_DERINLIK'])
  let depth = 0
  recommended.consensusLayers.forEach((layer, index) => {
    if (layer.thickness !== null) depth += layer.thickness
    rows.push([
      index + 1,
      recommended.motorA.layers[index].rho.toFixed(4), recommended.motorA.layers[index].thickness ?? 'YARI_SONSUZ',
      recommended.motorB.layers[index].rho.toFixed(4), recommended.motorB.layers[index].thickness ?? 'YARI_SONSUZ',
      layer.rho.toFixed(4), layer.thickness ?? 'YARI_SONSUZ', layer.thickness === null ? '' : depth.toFixed(4),
    ])
  })
  const csv = '\ufeff' + rows.map((row) => row.map((cell) => `"${String(cell ?? '').replace(/"/g, '""')}"`).join(';')).join('\r\n')
  const blob = new Blob([csv], { type: 'text/csv;charset=utf-8' })
  const url = URL.createObjectURL(blob)
  const link = document.createElement('a')
  link.href = url
  link.download = `${record.name.replace(/[^A-Za-z0-9_-]+/g, '-')}-dual-inversion.csv`
  document.body.appendChild(link)
  link.click()
  link.remove()
  window.setTimeout(() => URL.revokeObjectURL(url), 500)
}

export default function DESDualInversionFeature() {
  const [open, setOpen] = useState(false)
  const [records, setRecords] = useState<DesRecord[]>(readRecords)
  const [selectedId, setSelectedId] = useState<string | null>(() => readRecords()[0]?.id ?? null)
  const [saved, setSaved] = useState<Record<string, DualAnalysisResult>>(readSaved)
  const [analysis, setAnalysis] = useState<DualAnalysisResult | null>(null)
  const [busy, setBusy] = useState(false)
  const [progress, setProgress] = useState('')
  const [status, setStatus] = useState('')
  const selected = records.find((record) => record.id === selectedId) ?? records[0] ?? null
  const observed = useMemo(() => prepareObserved(selected?.measurements || []), [selected])

  useEffect(() => {
    const show = () => {
      const nextRecords = readRecords()
      const nextSaved = readSaved()
      const target = nextRecords.find((record) => record.id === selectedId) ?? nextRecords[0] ?? null
      setRecords(nextRecords)
      setSaved(nextSaved)
      setSelectedId(target?.id ?? null)
      setAnalysis(target ? nextSaved[target.id] ?? null : null)
      setStatus('')
      setProgress('')
      setOpen(true)
    }
    window.addEventListener(OPEN_EVENT, show)
    return () => window.removeEventListener(OPEN_EVENT, show)
  }, [selectedId])

  useEffect(() => {
    const refresh = () => {
      const next = readRecords()
      setRecords(next)
      const target = next.find((record) => record.id === selectedId) ?? next[0] ?? null
      setSelectedId(target?.id ?? null)
      if (!target) setAnalysis(null)
    }
    window.addEventListener('evren-des-analysis-changed', refresh)
    return () => window.removeEventListener('evren-des-analysis-changed', refresh)
  }, [selectedId])

  useEffect(() => {
    if (!open) return
    const previous = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    const close = (event: KeyboardEvent) => { if (event.key === 'Escape' && !busy) setOpen(false) }
    window.addEventListener('keydown', close)
    return () => { document.body.style.overflow = previous; window.removeEventListener('keydown', close) }
  }, [open, busy])

  useEffect(() => {
    const clear = (event: MouseEvent) => {
      const target = event.target
      if (!(target instanceof Element)) return
      const button = target.closest<HTMLButtonElement>('button.confirm-delete')
      if (!button || button.textContent?.trim() !== CLEAR_LABEL) return
      localStorage.removeItem(DUAL_KEY)
      setSaved({})
      setAnalysis(null)
    }
    document.addEventListener('click', clear, true)
    return () => document.removeEventListener('click', clear, true)
  }, [])

  const chooseRecord = (record: DesRecord) => {
    setSelectedId(record.id)
    setAnalysis(saved[record.id] ?? null)
    setStatus('')
    setProgress('')
  }

  const runAutomatic = async () => {
    if (!selected || observed.length < 4 || busy) return
    setBusy(true)
    setStatus('')
    const results: DualLayerResult[] = []
    try {
      for (const layerCount of [3, 4, 5, 6]) {
        setProgress(`${layerCount} tabakalı model · Motor A ve Motor B çözülüyor…`)
        await new Promise<void>((resolve) => window.setTimeout(resolve, 24))
        results.push(runDualLayerCount(observed, layerCount))
      }
      const next = finalizeDualAnalysis(results)
      if (!next) throw new Error('Model sonucu üretilemedi.')
      setAnalysis(next)
      setProgress('')
      setStatus(`Tam otomatik analiz tamamlandı · Önerilen model ${next.recommended.layerCount} tabaka · ${next.confidenceLabel}.`)
    } catch (error) {
      setStatus(error instanceof Error ? error.message : 'Otomatik modelleme tamamlanamadı.')
      setProgress('')
    } finally {
      setBusy(false)
    }
  }

  const saveAnalysis = () => {
    if (!selected || !analysis) return
    const next = { ...saved, [selected.id]: analysis }
    setSaved(next)
    localStorage.setItem(DUAL_KEY, JSON.stringify(next))
    setStatus('Otomatik doğrulama sonucu kaydedildi. Ham DES verisi değiştirilmedi.')
  }

  const transferToProfessional = () => {
    if (!selected || !analysis) return
    if (!window.confirm(`${analysis.recommended.layerCount} tabakalı konsensus model ${selected.name} için DES Professional modeline aktarılsın mı?`)) return
    let store: ProfessionalStore = {}
    try {
      const raw = JSON.parse(localStorage.getItem(PROFESSIONAL_KEY) || '{}') as ProfessionalStore
      if (raw && typeof raw === 'object' && !Array.isArray(raw)) store = raw
    } catch { /* Keep an empty store. */ }
    const previousLayers = store[selected.id]?.layers || []
    const layers = analysis.recommended.consensusLayers.map((layer, index) => ({
      ...layer,
      interpretation: previousLayers[index]?.interpretation || '',
    }))
    store[selected.id] = {
      recordId: selected.id,
      layers,
      rms: analysis.recommended.consensusRms,
      curveType: analysis.recommended.consensusCurveType,
      method: 'DES Dual Inversion · Motor A/B konsensus modeli · BIC + iç tutarlılık seçimi',
      updatedAt: Date.now(),
    }
    localStorage.setItem(PROFESSIONAL_KEY, JSON.stringify(store))
    setStatus('Önerilen konsensus model DES Professional’a aktarıldı. Mevcut jeolojik yorumlar mümkün olduğunca korundu.')
  }

  if (!open) return null
  const recommended = analysis?.recommended ?? null
  const confidenceClass = analysis ? `is-${analysis.confidence}` : ''

  return (
    <div className="desdual-overlay" role="dialog" aria-modal="true" aria-label="DES Otomatik Doğrulama">
      <section className="desdual-shell">
        <header className="desdual-header">
          <div className="desdual-title"><span><Sparkles size={23} /></span><div><small>EVREN GIS · DUAL INVERSION</small><h2>DES Otomatik Doğrulama</h2></div></div>
          <button type="button" className="desdual-close" onClick={() => !busy && setOpen(false)} disabled={busy} aria-label="Kapat"><X size={20} /></button>
        </header>

        {!records.length ? (
          <div className="desdual-empty"><Activity size={38} /><strong>DES verisi bulunamadı</strong><span>Önce DES Analiz ekranından gerçek Excel ölçümünü yükleyin.</span><button type="button" onClick={() => { setOpen(false); window.dispatchEvent(new CustomEvent('evren-open-des-analysis')) }}>DES Analiz'i Aç</button></div>
        ) : (
          <div className="desdual-layout">
            <aside className="desdual-sidebar">
              <div className="desdual-sidebar-head"><strong>DES Kayıtları</strong><small>{records.length} nokta</small></div>
              <div className="desdual-records">{records.map((record) => <button type="button" key={record.id} className={record.id === selected?.id ? 'is-active' : ''} onClick={() => chooseRecord(record)} disabled={busy}><span /><div><strong>{record.name}</strong><small>{record.measurements.length} ölçüm · {saved[record.id] ? 'Doğrulama kayıtlı' : 'Analiz yok'}</small></div></button>)}</div>
              <div className="desdual-sidebar-note"><strong>Ne doğrulanıyor?</strong><span>İki ayrı optimizasyon aynı gerçek DES verisini çözer. Bu, çözüm kararlılığı kontrolüdür; harici IPI2Win/RES1D doğrulaması değildir.</span></div>
            </aside>

            <main className="desdual-main">
              {selected ? <>
                <div className="desdual-toolbar">
                  <div><small>SEÇİLİ DES</small><h3>{selected.name}</h3><span>{[selected.province, selected.district].filter(Boolean).join(' · ') || selected.fileName}</span></div>
                  <div className="desdual-actions">
                    <button type="button" onClick={() => { setAnalysis(saved[selected.id] ?? null); setStatus('Kaydedilmiş son sonuca dönüldü.') }} disabled={busy}><RefreshCw size={15} /> Geri Al</button>
                    <button type="button" className="primary" onClick={() => void runAutomatic()} disabled={busy}><Sparkles size={16} /> {busy ? 'Hesaplanıyor…' : 'Tam Otomatik Analiz'}</button>
                  </div>
                </div>

                <section className="desdual-method">
                  <div><strong>Motor A</strong><span>Yerel log-parametre uyumlama · çoklu yeniden başlatma</span></div>
                  <div><strong>Motor B</strong><span>Differential Evolution · geniş global çok başlangıçlı arama</span></div>
                  <div><strong>Model seçimi</strong><span>3–6 tabaka · BIC karmaşıklık cezası + iki motor iç tutarlılığı</span></div>
                </section>

                {progress ? <div className="desdual-progress"><span className="desdual-spinner" />{progress}</div> : null}
                {status ? <div className="desdual-status">{status}</div> : null}

                {analysis && recommended ? <>
                  <div className="desdual-stats">
                    <span><strong>{recommended.layerCount}</strong><small>Önerilen tabaka</small></span>
                    <span><strong>{recommended.motorA.rms.toFixed(2)}%</strong><small>Motor A RMS</small></span>
                    <span><strong>{recommended.motorB.rms.toFixed(2)}%</strong><small>Motor B RMS</small></span>
                    <span><strong>{recommended.consensusRms.toFixed(2)}%</strong><small>Konsensus RMS</small></span>
                    <span><strong>{recommended.consistency.toFixed(0)}%</strong><small>İç tutarlılık</small></span>
                    <span className={`confidence ${confidenceClass}`}><strong>{analysis.confidence === 'high' ? 'Yüksek' : analysis.confidence === 'medium' ? 'Orta' : 'Düşük'}</strong><small>{analysis.confidenceLabel}</small></span>
                  </div>

                  <section className="desdual-scan-card">
                    <div className="desdual-section-head"><div><strong>Otomatik Model Taraması</strong><small>En düşük seçim skoru önerilir; yalnız RMS’ye göre seçim yapılmaz.</small></div><Layers3 size={18} /></div>
                    <div className="desdual-scan-table">
                      <div className="desdual-scan-row header"><span>Model</span><span>A RMS</span><span>B RMS</span><span>Konsensus</span><span>ρ farkı</span><span>h farkı</span><span>Tutarlılık</span><span>Ort. BIC</span></div>
                      {analysis.results.map((item) => <div key={item.layerCount} className={`desdual-scan-row${item.layerCount === recommended.layerCount ? ' is-recommended' : ''}`}><span><strong>{item.layerCount} tabaka</strong>{item.layerCount === recommended.layerCount ? <em>Önerilen</em> : null}</span><span>{item.motorA.rms.toFixed(2)}%</span><span>{item.motorB.rms.toFixed(2)}%</span><span>{item.consensusRms.toFixed(2)}%</span><span>{item.rhoDifferencePct.toFixed(1)}%</span><span>{item.thicknessDifferencePct.toFixed(1)}%</span><span>{item.consistency.toFixed(0)}%</span><span>{item.meanBic.toFixed(1)}</span></div>)}
                    </div>
                  </section>

                  <div className="desdual-visual-grid">
                    <DualCurve observed={observed} result={recommended} />
                    <section className="desdual-reason-card">
                      <div className="desdual-card-head"><div><strong>Neden Bu Model?</strong><small>Otomatik seçim özeti</small></div>{analysis.confidence === 'low' ? <AlertTriangle size={18} /> : <CheckCircle2 size={18} />}</div>
                      <div className="desdual-reason-list">
                        <span><b>Tabaka:</b> {recommended.layerCount}</span>
                        <span><b>Eğri tipi:</b> {recommended.consensusCurveType}</span>
                        <span><b>Motor eğri farkı:</b> {recommended.curveDifferencePct.toFixed(2)}%</span>
                        <span><b>ρ parametre farkı:</b> {recommended.rhoDifferencePct.toFixed(2)}%</span>
                        <span><b>h parametre farkı:</b> {recommended.thicknessDifferencePct.toFixed(2)}%</span>
                        <span><b>BIC:</b> {recommended.meanBic.toFixed(2)}</span>
                        <span><b>Seçim skoru:</b> {recommended.selectionScore.toFixed(2)}</span>
                      </div>
                      <p>BIC, gereksiz tabaka ekleyerek RMS’yi yapay biçimde düşüren modelleri cezalandırır. İki motor aynı ileri fizik modelini kullandığı için bu sonuç dış yazılım benchmarkı değil, optimizasyon kararlılığı göstergesidir.</p>
                    </section>
                  </div>

                  <section className="desdual-layer-card">
                    <div className="desdual-section-head"><div><strong>Önerilen Konsensus 1B Model</strong><small>Motor A ve B parametrelerinin geometrik konsensusu</small></div><div className="desdual-inline-actions"><button type="button" onClick={() => downloadAnalysis(selected, analysis)}><Download size={15} /> CSV</button><button type="button" onClick={saveAnalysis}><Save size={15} /> Kaydet</button><button type="button" className="primary" onClick={transferToProfessional}>Professional'a Aktar</button></div></div>
                    <div className="desdual-layer-table">
                      <div className="desdual-layer-row header"><span>Tabaka</span><span>Motor A ρ / h</span><span>Motor B ρ / h</span><span>Konsensus ρ / h</span><span>Taban derinliği</span></div>
                      {(() => {
                        let depth = 0
                        return recommended.consensusLayers.map((layer, index) => {
                          if (layer.thickness !== null) depth += layer.thickness
                          const a = recommended.motorA.layers[index]
                          const b = recommended.motorB.layers[index]
                          const formatH = (value: number | null) => value === null ? '∞' : `${value.toFixed(2)} m`
                          return <div className="desdual-layer-row" key={layer.id}><strong>{index + 1}</strong><span>{a.rho.toFixed(1)} Ωm / {formatH(a.thickness)}</span><span>{b.rho.toFixed(1)} Ωm / {formatH(b.thickness)}</span><span className="consensus"><b>{layer.rho.toFixed(1)} Ωm</b> / {formatH(layer.thickness)}</span><span>{layer.thickness === null ? 'Yarı sonsuz' : `${depth.toFixed(2)} m`}</span></div>
                        })
                      })()}
                    </div>
                  </section>

                  <div className={`desdual-confidence-note ${confidenceClass}`}><strong>{analysis.confidenceLabel}</strong><span>{analysis.methodNote}</span></div>
                </> : (
                  <div className="desdual-start"><Sparkles size={38} /><strong>Tek tuşla 3–6 tabakayı iki motorla tara</strong><span>Gerçek DES ölçümünden iki ayrı optimizasyon çözümü üretilecek, BIC ile model karmaşıklığı kontrol edilecek ve en kararlı 1B model önerilecek.</span><button type="button" onClick={() => void runAutomatic()} disabled={busy}>Tam Otomatik Analizi Başlat</button></div>
                )}
              </> : null}
            </main>
          </div>
        )}
      </section>
    </div>
  )
}
