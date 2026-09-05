import { useEffect, useState } from 'react'
import { createPortal } from 'react-dom'
import { Layers3, Save, Sparkles } from 'lucide-react'
import {
  createInitialLayers,
  fitLayerModel,
  prepareObserved,
  type DesFitResult,
  type DesLayerModel,
  type ObservedPoint,
} from './DESProfessionalEngine'
import {
  finalizeDualAnalysis,
  runDualLayerCount,
  type DualAnalysisResult,
  type DualLayerResult,
} from './DESDualInversionEngine'
import './DESBatchActionsFeature.css'

const RECORDS_KEY = 'evren-jeofizik-gis-des-analysis-v1'
const PROFESSIONAL_KEY = 'evren-jeofizik-gis-des-professional-v2'
const DUAL_KEY = 'evren-jeofizik-gis-des-dual-inversion-v1'

type DesMeasurement = { ab2: number; mn: number; rho: number }
type DesRecord = {
  id: string
  name: string
  measurements: DesMeasurement[]
}

type ProfessionalModel = {
  recordId: string
  layers: DesLayerModel[]
  rms: number
  curveType: string
  method: string
  updatedAt: number
}

type ProfessionalStore = Record<string, ProfessionalModel>

type ProfessionalCandidate = {
  layerCount: number
  result: DesFitResult
  bic: number
  overfitPenalty: number
  selectionScore: number
}

type BusyMode = 'professional' | 'dual' | null

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
        measurements,
      }]
    })
  } catch {
    return []
  }
}

function readProfessionalStore(): ProfessionalStore {
  try {
    const raw = JSON.parse(localStorage.getItem(PROFESSIONAL_KEY) || '{}') as ProfessionalStore
    return raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {}
  } catch {
    return {}
  }
}

function readDualStore(): Record<string, DualAnalysisResult> {
  try {
    const raw = JSON.parse(localStorage.getItem(DUAL_KEY) || '{}') as Record<string, DualAnalysisResult>
    return raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {}
  } catch {
    return {}
  }
}

function professionalBic(observed: ObservedPoint[], response: number[], parameterCount: number) {
  const n = observed.length
  if (!n || response.length !== n) return Number.POSITIVE_INFINITY
  const sse = observed.reduce((sum, point, index) => {
    const predicted = Math.max(0.001, response[index])
    const residual = Math.log(predicted / point.rho)
    return sum + residual * residual
  }, 0)
  const mse = Math.max(1e-12, sse / n)
  return n * Math.log(mse) + parameterCount * Math.log(Math.max(2, n))
}

function yieldToUi(ms = 18) {
  return new Promise<void>((resolve) => window.setTimeout(resolve, ms))
}

export default function DESBatchActionsFeature() {
  const [professionalTarget, setProfessionalTarget] = useState<HTMLElement | null>(null)
  const [calibrationTarget, setCalibrationTarget] = useState<HTMLElement | null>(null)
  const [dualTarget, setDualTarget] = useState<HTMLElement | null>(null)
  const [pendingModels, setPendingModels] = useState<ProfessionalStore | null>(null)
  const [pendingCount, setPendingCount] = useState(0)
  const [busyMode, setBusyMode] = useState<BusyMode>(null)
  const [progress, setProgress] = useState('')
  const [status, setStatus] = useState('')

  useEffect(() => {
    const syncTargets = () => {
      const professional = document.querySelector<HTMLElement>('.despro-toolbar-actions')
      const calibration = document.querySelector<HTMLElement>('.descal-host-head')
      const dual = document.querySelector<HTMLElement>('.desdual-actions')
      setProfessionalTarget((current) => current === professional ? current : professional)
      setCalibrationTarget((current) => current === calibration ? current : calibration)
      setDualTarget((current) => current === dual ? current : dual)
    }
    syncTargets()
    const observer = new MutationObserver(syncTargets)
    observer.observe(document.body, { childList: true, subtree: true })
    return () => observer.disconnect()
  }, [])

  const autoFitAll = async () => {
    if (busyMode) return
    const records = readRecords()
    if (!records.length) {
      setStatus('Toplu uyum için DES kaydı bulunamadı.')
      return
    }
    setBusyMode('professional')
    setPendingModels(null)
    setPendingCount(0)
    setStatus('')
    const existing = readProfessionalStore()
    const next: ProfessionalStore = { ...existing }
    const selectedCounts: Record<number, number> = { 3: 0, 4: 0, 5: 0, 6: 0 }
    let fitted = 0
    let skipped = 0

    try {
      for (let recordIndex = 0; recordIndex < records.length; recordIndex += 1) {
        const record = records[recordIndex]
        const observed = prepareObserved(record.measurements)
        if (observed.length < 4) {
          skipped += 1
          continue
        }

        const candidates: ProfessionalCandidate[] = []
        for (const layerCount of [3, 4, 5, 6]) {
          setProgress(`${recordIndex + 1}/${records.length} · ${record.name} · ${layerCount} tabaka deneniyor…`)
          await yieldToUi(16)
          const result = fitLayerModel(observed, layerCount, createInitialLayers(observed, layerCount))
          const parameterCount = layerCount * 2 - 1
          const bic = professionalBic(observed, result.response, parameterCount)
          const overfitPenalty = Math.max(0, parameterCount + 2 - observed.length) * 12
          candidates.push({
            layerCount,
            result,
            bic,
            overfitPenalty,
            selectionScore: bic + overfitPenalty,
          })
        }

        const best = candidates.reduce((currentBest, candidate) => (
          candidate.selectionScore < currentBest.selectionScore ? candidate : currentBest
        ))
        const previousLayers = existing[record.id]?.layers || []
        const layers = best.result.layers.map((layer, index) => ({
          ...layer,
          interpretation: previousLayers[index]?.interpretation || '',
        }))

        next[record.id] = {
          recordId: record.id,
          layers,
          rms: best.result.rms,
          curveType: best.result.curveType,
          method: `Schlumberger · Ghosh tipi 9 noktalı dijital filtre yaklaşımı · log-uzay uyum · 3–6 tabaka otomatik tarama · BIC + karmaşıklık cezası · önerilen ${best.layerCount} tabaka`,
          updatedAt: Date.now(),
        }
        selectedCounts[best.layerCount] += 1
        fitted += 1
      }

      const distribution = [3, 4, 5, 6]
        .filter((count) => selectedCounts[count] > 0)
        .map((count) => `${count} tabaka: ${selectedCounts[count]}`)
        .join(' · ')
      setPendingModels(next)
      setPendingCount(fitted)
      setStatus(`${fitted} DES için 3–6 tabaka tarandı ve en uygun model seçildi${distribution ? ` · ${distribution}` : ''}${skipped ? ` · ${skipped} kayıt yetersiz veri nedeniyle atlandı` : ''}. “Tüm Modelleri Kaydet” ile kaydedebilir; sonra her DES'i 3–6 tabaka arasında manuel değiştirebilirsin.`)
    } catch (error) {
      setPendingModels(null)
      setPendingCount(0)
      setStatus(error instanceof Error ? error.message : 'Toplu otomatik uyum tamamlanamadı.')
    } finally {
      setProgress('')
      setBusyMode(null)
    }
  }

  const saveAllModels = () => {
    if (!pendingModels || !pendingCount || busyMode) {
      setStatus('Önce “Tümüne Otomatik Uyumla” işlemini çalıştırın.')
      return
    }
    localStorage.setItem(PROFESSIONAL_KEY, JSON.stringify(pendingModels))
    setPendingModels(null)
    const count = pendingCount
    setPendingCount(0)
    setStatus(`${count} otomatik uyumlanmış DES modeli topluca kaydedildi. İstersen seçili DES üzerinde 3–6 tabaka arasında manuel değişiklik yapabilirsin.`)

    if (document.querySelector('.despro-overlay')) {
      window.dispatchEvent(new CustomEvent('evren-open-des-professional'))
    } else if (document.querySelector('.descal-overlay')) {
      window.dispatchEvent(new CustomEvent('evren-open-des-calibration'))
    }
  }

  const runAllDual = async () => {
    if (busyMode) return
    const records = readRecords()
    if (!records.length) {
      setStatus('Tam otomatik analiz için DES kaydı bulunamadı.')
      return
    }
    setBusyMode('dual')
    setStatus('')
    let nextSaved = readDualStore()
    let completed = 0
    let skipped = 0

    try {
      for (let recordIndex = 0; recordIndex < records.length; recordIndex += 1) {
        const record = records[recordIndex]
        const observed = prepareObserved(record.measurements)
        if (observed.length < 4) {
          skipped += 1
          continue
        }
        const results: DualLayerResult[] = []
        for (const layerCount of [3, 4, 5, 6]) {
          setProgress(`${recordIndex + 1}/${records.length} · ${record.name} · ${layerCount} tabaka · Motor A + B…`)
          await yieldToUi(22)
          results.push(runDualLayerCount(observed, layerCount))
        }
        const analysis = finalizeDualAnalysis(results)
        if (!analysis) {
          skipped += 1
          continue
        }
        nextSaved = { ...nextSaved, [record.id]: analysis }
        localStorage.setItem(DUAL_KEY, JSON.stringify(nextSaved))
        completed += 1
      }
      setStatus(`${completed} DES için Tam Otomatik Analiz tamamlandı ve kaydedildi${skipped ? ` · ${skipped} kayıt atlandı` : ''}.`)
      if (document.querySelector('.desdual-overlay')) {
        window.dispatchEvent(new CustomEvent('evren-open-des-dual-inversion'))
      }
    } catch (error) {
      setStatus(error instanceof Error ? error.message : 'Tüm DES otomatik analizi tamamlanamadı.')
    } finally {
      setProgress('')
      setBusyMode(null)
    }
  }

  const professionalActions = (
    <>
      <button type="button" className="desbatch-button" onClick={() => void autoFitAll()} disabled={Boolean(busyMode)}>
        <Sparkles size={15} /> {busyMode === 'professional' ? '3–6 Taranıyor…' : 'Tümüne Otomatik Uyumla'}
      </button>
      <button type="button" className="desbatch-button save" onClick={saveAllModels} disabled={Boolean(busyMode) || !pendingModels || pendingCount === 0}>
        <Save size={15} /> Tüm Modelleri Kaydet
      </button>
    </>
  )

  return (
    <>
      {professionalTarget ? createPortal(professionalActions, professionalTarget) : null}
      {calibrationTarget ? createPortal(
        <div className="desbatch-cal-actions">
          <button type="button" onClick={() => void autoFitAll()} disabled={Boolean(busyMode)}><Sparkles size={14} /> {busyMode === 'professional' ? '3–6 Taranıyor…' : 'Tümüne Otomatik Uyumla'}</button>
          <button type="button" onClick={saveAllModels} disabled={Boolean(busyMode) || !pendingModels || pendingCount === 0}><Save size={14} /> Tüm Modelleri Kaydet</button>
        </div>,
        calibrationTarget,
      ) : null}
      {dualTarget ? createPortal(
        <button type="button" className="desbatch-button dual" onClick={() => void runAllDual()} disabled={Boolean(busyMode)}>
          <Layers3 size={15} /> {busyMode === 'dual' ? 'Tüm DES Analiz Ediliyor…' : 'Tüm DES · Tam Otomatik Analiz'}
        </button>,
        dualTarget,
      ) : null}

      {progress || status ? (
        <div className={`desbatch-toast${busyMode ? ' is-busy' : ''}`}>
          {busyMode ? <span className="desbatch-spinner" /> : null}
          <div><strong>{busyMode === 'dual' ? 'DES Otomatik' : busyMode === 'professional' ? 'DES Professional' : 'Toplu İşlem'}</strong><span>{progress || status}</span></div>
        </div>
      ) : null}
    </>
  )
}
