import { useEffect, useMemo, useState } from 'react'
import { Scale, X } from 'lucide-react'
import DESCalibrationPanel from './DESCalibrationPanel'
import type { DesLayerModel } from './DESProfessionalEngine'

const RECORDS_KEY = 'evren-jeofizik-gis-des-analysis-v1'
const MODELS_KEY = 'evren-jeofizik-gis-des-professional-v2'
const CALIBRATION_KEY = 'evren-jeofizik-gis-des-calibration-v1'
const OPEN_EVENT = 'evren-open-des-calibration'
const CLEAR_LABEL = 'Evet, Kalıcı Sil'

type DesRecord = {
  id: string
  name: string
  fileName: string
  province: string
  district: string
}

type SavedModel = {
  recordId: string
  layers: DesLayerModel[]
  rms: number
  curveType: string
  method: string
  updatedAt: number
}

function readRecords(): DesRecord[] {
  try {
    const raw = JSON.parse(localStorage.getItem(RECORDS_KEY) || '[]') as Array<Partial<DesRecord>>
    if (!Array.isArray(raw)) return []
    return raw.flatMap((item, index) => {
      if (typeof item.id !== 'string' || !item.id) return []
      return [{
        id: item.id,
        name: typeof item.name === 'string' && item.name ? item.name : `DES ${index + 1}`,
        fileName: typeof item.fileName === 'string' ? item.fileName : '',
        province: typeof item.province === 'string' ? item.province : '',
        district: typeof item.district === 'string' ? item.district : '',
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
    Object.entries(raw).forEach(([recordId, model]) => {
      if (!model || !Array.isArray(model.layers) || model.layers.length < 3) return
      const layers = model.layers.map((layer, index) => ({
        id: typeof layer.id === 'string' ? layer.id : `layer-${index + 1}`,
        rho: Math.max(0.2, Number(layer.rho) || 100),
        thickness: index === model.layers!.length - 1 ? null : Math.max(0.5, Number(layer.thickness) || 10),
        interpretation: typeof layer.interpretation === 'string' ? layer.interpretation : '',
      }))
      next[recordId] = {
        recordId,
        layers,
        rms: Number(model.rms) || 0,
        curveType: typeof model.curveType === 'string' ? model.curveType : '–',
        method: typeof model.method === 'string' ? model.method : '',
        updatedAt: Number(model.updatedAt) || Date.now(),
      }
    })
    return next
  } catch {
    return {}
  }
}

export default function DESCalibrationFeature() {
  const [open, setOpen] = useState(false)
  const [records, setRecords] = useState<DesRecord[]>(readRecords)
  const [models, setModels] = useState<Record<string, SavedModel>>(readModels)
  const [selectedId, setSelectedId] = useState<string | null>(() => readRecords()[0]?.id ?? null)
  const selected = records.find((record) => record.id === selectedId) ?? records[0] ?? null
  const model = selected ? models[selected.id] ?? null : null
  const modeledCount = useMemo(() => records.filter((record) => Boolean(models[record.id])).length, [records, models])

  useEffect(() => {
    const show = () => {
      const nextRecords = readRecords()
      const nextModels = readModels()
      setRecords(nextRecords)
      setModels(nextModels)
      const target = nextRecords.find((record) => record.id === selectedId) ?? nextRecords.find((record) => nextModels[record.id]) ?? nextRecords[0] ?? null
      setSelectedId(target?.id ?? null)
      setOpen(true)
    }
    window.addEventListener(OPEN_EVENT, show)
    return () => window.removeEventListener(OPEN_EVENT, show)
  }, [selectedId])

  useEffect(() => {
    if (!open) return
    const previous = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    const close = (event: KeyboardEvent) => { if (event.key === 'Escape') setOpen(false) }
    window.addEventListener('keydown', close)
    return () => {
      document.body.style.overflow = previous
      window.removeEventListener('keydown', close)
    }
  }, [open])

  useEffect(() => {
    const refresh = () => {
      const nextRecords = readRecords()
      const nextModels = readModels()
      setRecords(nextRecords)
      setModels(nextModels)
      if (selectedId && nextRecords.some((record) => record.id === selectedId)) return
      setSelectedId(nextRecords.find((record) => nextModels[record.id])?.id ?? nextRecords[0]?.id ?? null)
    }
    window.addEventListener('evren-des-analysis-changed', refresh)
    return () => window.removeEventListener('evren-des-analysis-changed', refresh)
  }, [selectedId])

  useEffect(() => {
    const clear = (event: MouseEvent) => {
      const target = event.target
      if (!(target instanceof Element)) return
      const button = target.closest<HTMLButtonElement>('button.confirm-delete')
      if (!button || button.textContent?.trim() !== CLEAR_LABEL) return
      localStorage.removeItem(CALIBRATION_KEY)
    }
    document.addEventListener('click', clear, true)
    return () => document.removeEventListener('click', clear, true)
  }, [])

  if (!open) return null

  return (
    <div className="descal-overlay" role="dialog" aria-modal="true" aria-label="DES Referans Kalibrasyon ve Doğrulama">
      <section className="descal-shell">
        <header className="descal-host-head">
          <div className="descal-host-title"><span><Scale size={22} /></span><div><small>EVREN GIS · REFERANS DOĞRULAMA</small><h2>DES Kalibrasyon / Doğrulama</h2></div></div>
          <button type="button" className="descal-close" onClick={() => setOpen(false)} aria-label="Kapat"><X size={19} /></button>
        </header>

        {!records.length ? (
          <div className="descal-empty"><Scale size={36} /><strong>DES kaydı bulunamadı</strong><span>Önce DES Analiz bölümünden ham Excel verisini yükleyin.</span><button type="button" onClick={() => { setOpen(false); window.dispatchEvent(new CustomEvent('evren-open-des-analysis')) }}>DES Analiz'i Aç</button></div>
        ) : (
          <div className="descal-host-layout">
            <aside className="descal-sidebar">
              <strong>DES Kayıtları</strong>
              <small>{modeledCount}/{records.length} kayıtlı 1B model</small>
              {records.map((record) => <button type="button" key={record.id} className={`descal-record${record.id === selected?.id ? ' is-active' : ''}`} onClick={() => setSelectedId(record.id)}><strong>{record.name}</strong><small>{models[record.id] ? `${models[record.id].layers.length} tabaka · RMS ${models[record.id].rms.toFixed(2)}%` : 'Önce model kaydedilmeli'}</small></button>)}
            </aside>

            <main className="descal-main">
              {selected && model ? (
                <>
                  <div className="descal-current-card">
                    <span><strong>{selected.name}</strong><small>Seçili DES</small></span>
                    <span><strong>{model.layers.length}</strong><small>Evren tabaka sayısı</small></span>
                    <span><strong>{model.rms.toFixed(2)}%</strong><small>Evren Log RMS</small></span>
                    <span><strong>{model.curveType}</strong><small>Model eğri tipi</small></span>
                  </div>
                  <DESCalibrationPanel recordId={selected.id} recordName={selected.name} currentLayers={model.layers} currentRms={model.rms} />
                </>
              ) : (
                <div className="descal-empty"><Scale size={34} /><strong>{selected?.name || 'DES'} için kayıtlı Professional model yok</strong><span>Önce DES Professional Studio’da otomatik veya manuel modeli tamamlayıp “Modeli Kaydet” seçin.</span><button type="button" onClick={() => { setOpen(false); window.dispatchEvent(new CustomEvent('evren-open-des-professional')) }}>DES Professional'ı Aç</button></div>
              )}
            </main>
          </div>
        )}
      </section>
    </div>
  )
}
