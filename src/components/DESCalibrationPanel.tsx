import { useEffect, useMemo, useState } from 'react'
import { Download, Save, Scale, ShieldCheck, Trash2 } from 'lucide-react'
import type { DesLayerModel } from './DESProfessionalEngine'
import './DESCalibrationPanel.css'

const STORAGE_KEY = 'evren-jeofizik-gis-des-calibration-v1'

type ReferenceSoftware = 'IPI2Win' | 'RES1D' | 'Diğer'

type ReferenceLayer = {
  rho: number | null
  thickness: number | null
}

type ReferenceCase = {
  recordId: string
  software: ReferenceSoftware
  label: string
  rms: number | null
  layers: ReferenceLayer[]
  updatedAt: number
}

type ReferenceStore = Record<string, ReferenceCase>

type Props = {
  recordId: string
  recordName: string
  currentLayers: DesLayerModel[]
  currentRms: number
}

function readStore(): ReferenceStore {
  try {
    const raw = JSON.parse(localStorage.getItem(STORAGE_KEY) || '{}') as ReferenceStore
    return raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {}
  } catch {
    return {}
  }
}

function finiteOrNull(value: unknown) {
  if (value === '' || value === null || value === undefined) return null
  const number = Number(value)
  return Number.isFinite(number) ? number : null
}

function blankLayers(count: number): ReferenceLayer[] {
  const safeCount = Math.max(3, Math.min(8, Math.round(count) || 4))
  return Array.from({ length: safeCount }, (_, index) => ({ rho: null, thickness: index === safeCount - 1 ? null : null }))
}

function pctDifference(current: number, reference: number) {
  if (!Number.isFinite(current) || !Number.isFinite(reference) || reference === 0) return null
  return Math.abs(current - reference) / Math.abs(reference) * 100
}

function mean(values: Array<number | null>) {
  const valid = values.filter((value): value is number => value !== null && Number.isFinite(value))
  return valid.length ? valid.reduce((sum, value) => sum + value, 0) / valid.length : null
}

function cumulativeDepths(layers: Array<{ thickness: number | null }>) {
  let depth = 0
  return layers.slice(0, -1).map((layer) => {
    depth += Math.max(0, Number(layer.thickness) || 0)
    return depth
  })
}

function exportComparison(
  recordName: string,
  software: ReferenceSoftware,
  label: string,
  currentLayers: DesLayerModel[],
  referenceLayers: ReferenceLayer[],
  currentRms: number,
  referenceRms: number | null,
) {
  const currentDepths = cumulativeDepths(currentLayers)
  const referenceDepths = cumulativeDepths(referenceLayers)
  const rows: Array<Array<string | number>> = [
    ['EVREN GIS DES REFERANS KARSILASTIRMA'],
    ['DES', recordName],
    ['Referans Yazilim', software],
    ['Referans Etiketi', label],
    ['Evren RMS %', Number.isFinite(currentRms) ? currentRms.toFixed(4) : ''],
    ['Referans RMS %', referenceRms === null ? '' : referenceRms.toFixed(4)],
    [],
    ['TABAKA', 'EVREN_RHO', 'REFERANS_RHO', 'RHO_FARK_%', 'EVREN_H', 'REFERANS_H', 'H_FARK_%', 'EVREN_TABAN_M', 'REFERANS_TABAN_M', 'TABAN_FARK_%'],
  ]
  const count = Math.max(currentLayers.length, referenceLayers.length)
  for (let index = 0; index < count; index += 1) {
    const current = currentLayers[index]
    const reference = referenceLayers[index]
    const rhoDiff = current && reference?.rho !== null ? pctDifference(current.rho, reference.rho) : null
    const hDiff = current?.thickness !== null && reference?.thickness !== null && current && reference
      ? pctDifference(current.thickness, reference.thickness)
      : null
    const depthDiff = index < count - 1 && currentDepths[index] !== undefined && referenceDepths[index] !== undefined
      ? pctDifference(currentDepths[index], referenceDepths[index])
      : null
    rows.push([
      index + 1,
      current?.rho?.toFixed(4) ?? '',
      reference?.rho?.toFixed(4) ?? '',
      rhoDiff === null ? '' : rhoDiff.toFixed(3),
      current?.thickness === null || !current ? 'YARI_SONSUZ' : current.thickness.toFixed(4),
      reference?.thickness === null || !reference ? 'YARI_SONSUZ' : reference.thickness.toFixed(4),
      hDiff === null ? '' : hDiff.toFixed(3),
      currentDepths[index] === undefined ? '' : currentDepths[index].toFixed(4),
      referenceDepths[index] === undefined ? '' : referenceDepths[index].toFixed(4),
      depthDiff === null ? '' : depthDiff.toFixed(3),
    ])
  }
  const csv = '\ufeff' + rows.map((row) => row.map((cell) => `"${String(cell ?? '').replace(/"/g, '""')}"`).join(';')).join('\r\n')
  const blob = new Blob([csv], { type: 'text/csv;charset=utf-8' })
  const url = URL.createObjectURL(blob)
  const link = document.createElement('a')
  link.href = url
  link.download = `${recordName.replace(/[^A-Za-z0-9_-]+/g, '-')}-${software}-dogrulama.csv`
  document.body.appendChild(link)
  link.click()
  link.remove()
  window.setTimeout(() => URL.revokeObjectURL(url), 500)
}

export default function DESCalibrationPanel({ recordId, recordName, currentLayers, currentRms }: Props) {
  const [store, setStore] = useState<ReferenceStore>(readStore)
  const saved = store[recordId] ?? null
  const [software, setSoftware] = useState<ReferenceSoftware>(saved?.software ?? 'IPI2Win')
  const [label, setLabel] = useState(saved?.label ?? '')
  const [referenceRms, setReferenceRms] = useState<number | null>(saved?.rms ?? null)
  const [referenceLayers, setReferenceLayers] = useState<ReferenceLayer[]>(saved?.layers?.length ? saved.layers : blankLayers(currentLayers.length))
  const [status, setStatus] = useState('')

  useEffect(() => {
    const next = readStore()
    setStore(next)
    const reference = next[recordId]
    setSoftware(reference?.software ?? 'IPI2Win')
    setLabel(reference?.label ?? '')
    setReferenceRms(reference?.rms ?? null)
    setReferenceLayers(reference?.layers?.length ? reference.layers.map((layer) => ({ ...layer })) : blankLayers(currentLayers.length))
    setStatus('')
  }, [recordId])

  const sameLayerCount = referenceLayers.length === currentLayers.length
  const referenceComplete = sameLayerCount && referenceLayers.every((layer, index) => (
    layer.rho !== null && layer.rho > 0 && (index === referenceLayers.length - 1 || (layer.thickness !== null && layer.thickness > 0))
  ))

  const comparison = useMemo(() => {
    if (!referenceComplete) return null
    const rhoDiffs = currentLayers.map((layer, index) => pctDifference(layer.rho, referenceLayers[index].rho!))
    const hDiffs = currentLayers.slice(0, -1).map((layer, index) => pctDifference(layer.thickness || 0, referenceLayers[index].thickness!))
    const currentDepths = cumulativeDepths(currentLayers)
    const referenceDepths = cumulativeDepths(referenceLayers)
    const depthDiffs = currentDepths.map((depth, index) => pctDifference(depth, referenceDepths[index]))
    const rmsDiff = referenceRms !== null && referenceRms > 0 && Number.isFinite(currentRms) ? pctDifference(currentRms, referenceRms) : null
    return {
      rhoMean: mean(rhoDiffs),
      thicknessMean: mean(hDiffs),
      depthMean: mean(depthDiffs),
      rmsDiff,
      currentDepths,
      referenceDepths,
    }
  }, [currentLayers, currentRms, referenceComplete, referenceLayers, referenceRms])

  const setLayerCount = (count: number) => {
    setReferenceLayers(blankLayers(count))
    setStatus('Referans tabaka sayısı değiştirildi; değerleri yeniden girin.')
  }

  const updateReferenceLayer = (index: number, patch: Partial<ReferenceLayer>) => {
    setReferenceLayers((current) => current.map((layer, layerIndex) => layerIndex === index ? { ...layer, ...patch } : layer))
  }

  const saveReference = () => {
    if (!referenceComplete) {
      setStatus('Referans model tamamlanmadı. Tüm özdirenç ve son tabaka hariç kalınlık değerlerini girin.')
      return
    }
    const nextCase: ReferenceCase = {
      recordId,
      software,
      label: label.trim(),
      rms: referenceRms,
      layers: referenceLayers.map((layer) => ({ ...layer })),
      updatedAt: Date.now(),
    }
    const next = { ...store, [recordId]: nextCase }
    setStore(next)
    localStorage.setItem(STORAGE_KEY, JSON.stringify(next))
    setStatus(`${software} referans modeli kaydedildi. Evren inversiyon motoru değiştirilmedi.`)
  }

  const clearReference = () => {
    if (!window.confirm(`${recordName} için kaydedilen referans doğrulama verisi silinsin mi?`)) return
    const next = { ...store }
    delete next[recordId]
    setStore(next)
    localStorage.setItem(STORAGE_KEY, JSON.stringify(next))
    setSoftware('IPI2Win')
    setLabel('')
    setReferenceRms(null)
    setReferenceLayers(blankLayers(currentLayers.length))
    setStatus('Referans doğrulama verisi silindi.')
  }

  return (
    <section className="descal-panel">
      <div className="descal-head">
        <div className="descal-title"><span><Scale size={19} /></span><div><strong>Referans Kalibrasyon / Doğrulama</strong><small>Evren 1B modeli ile IPI2Win veya RES1D sonucunu tabaka bazında karşılaştırın.</small></div></div>
        <div className={`descal-state ${referenceComplete ? 'is-ready' : ''}`}><ShieldCheck size={15} />{referenceComplete ? 'Karşılaştırmaya hazır' : 'Referans bekleniyor'}</div>
      </div>

      <div className="descal-meta">
        <label><span>Referans yazılım</span><select value={software} onChange={(event) => setSoftware(event.target.value as ReferenceSoftware)}><option value="IPI2Win">IPI2Win</option><option value="RES1D">RES1D</option><option value="Diğer">Diğer</option></select></label>
        <label><span>Referans / proje etiketi</span><input value={label} onChange={(event) => setLabel(event.target.value)} placeholder="Örn. IPI2Win nihai model" /></label>
        <label><span>Referans RMS (%)</span><input inputMode="decimal" value={referenceRms ?? ''} onChange={(event) => setReferenceRms(finiteOrNull(event.target.value))} placeholder="Opsiyonel" /></label>
        <div className="descal-count"><span>Referans tabaka sayısı</span><div>{[3, 4, 5, 6].map((count) => <button type="button" key={count} className={referenceLayers.length === count ? 'is-active' : ''} onClick={() => setLayerCount(count)}>{count}</button>)}</div></div>
      </div>

      {!sameLayerCount ? <div className="descal-warning">Evren modeli {currentLayers.length} tabaka, referans model {referenceLayers.length} tabaka. Tabaka bazlı doğrulama için sayıları eşitleyin.</div> : null}

      <div className="descal-table">
        <div className="descal-row header"><span>Tabaka</span><span>Evren ρ</span><span>Referans ρ</span><span>ρ fark</span><span>Evren h</span><span>Referans h</span><span>h fark</span><span>Sınır fark</span></div>
        {referenceLayers.map((reference, index) => {
          const current = currentLayers[index]
          const rhoDiff = current && reference.rho !== null ? pctDifference(current.rho, reference.rho) : null
          const hDiff = current?.thickness !== null && current && reference.thickness !== null ? pctDifference(current.thickness, reference.thickness) : null
          const currentDepth = currentLayers.slice(0, index + 1).reduce((sum, layer) => sum + (layer.thickness || 0), 0)
          const referenceDepth = referenceLayers.slice(0, index + 1).reduce((sum, layer) => sum + (layer.thickness || 0), 0)
          const depthDiff = index < referenceLayers.length - 1 && current ? pctDifference(currentDepth, referenceDepth) : null
          return <div className="descal-row" key={`reference-${index}`}>
            <strong>{index + 1}</strong>
            <span>{current ? `${current.rho.toFixed(2)} Ωm` : '–'}</span>
            <label><input inputMode="decimal" value={reference.rho ?? ''} onChange={(event) => updateReferenceLayer(index, { rho: finiteOrNull(event.target.value) })} placeholder="ρ Ωm" /></label>
            <span>{rhoDiff === null ? '–' : `${rhoDiff.toFixed(1)}%`}</span>
            <span>{!current ? '–' : current.thickness === null ? 'Yarı sonsuz' : `${current.thickness.toFixed(2)} m`}</span>
            <label>{index === referenceLayers.length - 1 ? <span className="descal-halfspace">Yarı sonsuz</span> : <input inputMode="decimal" value={reference.thickness ?? ''} onChange={(event) => updateReferenceLayer(index, { thickness: finiteOrNull(event.target.value) })} placeholder="h m" />}</label>
            <span>{hDiff === null ? '–' : `${hDiff.toFixed(1)}%`}</span>
            <span>{depthDiff === null ? '–' : `${depthDiff.toFixed(1)}%`}</span>
          </div>
        })}
      </div>

      <div className="descal-summary">
        <span><strong>{comparison?.rhoMean === null || comparison?.rhoMean === undefined ? '–' : `${comparison.rhoMean.toFixed(1)}%`}</strong><small>Ort. ρ farkı</small></span>
        <span><strong>{comparison?.thicknessMean === null || comparison?.thicknessMean === undefined ? '–' : `${comparison.thicknessMean.toFixed(1)}%`}</strong><small>Ort. kalınlık farkı</small></span>
        <span><strong>{comparison?.depthMean === null || comparison?.depthMean === undefined ? '–' : `${comparison.depthMean.toFixed(1)}%`}</strong><small>Ort. sınır derinliği farkı</small></span>
        <span><strong>{comparison?.rmsDiff === null || comparison?.rmsDiff === undefined ? '–' : `${comparison.rmsDiff.toFixed(1)}%`}</strong><small>RMS farkı</small></span>
      </div>

      <div className="descal-actions">
        <button type="button" className="primary" onClick={saveReference}><Save size={15} /> Referansı Kaydet</button>
        <button type="button" disabled={!referenceComplete} onClick={() => exportComparison(recordName, software, label, currentLayers, referenceLayers, currentRms, referenceRms)}><Download size={15} /> Karşılaştırma CSV</button>
        {saved ? <button type="button" className="danger" onClick={clearReference}><Trash2 size={15} /> Referansı Sil</button> : null}
      </div>

      {status ? <div className="descal-status">{status}</div> : null}
      <div className="descal-note"><strong>Kalibrasyon ilkesi:</strong> Bu ekran gerçek referans sonuçlarını ölçer; referans girilmeden uyum puanı üretmez ve inversiyon parametrelerini otomatik değiştirmez. Birkaç doğrulanmış DES örneği biriktikten sonra sistematik fark varsa motor ayrı bir sürümde kalibre edilir.</div>
    </section>
  )
}
