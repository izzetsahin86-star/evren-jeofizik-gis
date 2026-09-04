import { useEffect, useMemo, useRef, useState, type ChangeEvent } from 'react'
import JSZip from 'jszip'
import {
  AlertTriangle,
  Box,
  Database,
  Download,
  Eye,
  FileArchive,
  MapPin,
  Plus,
  RotateCcw,
  Save,
  Trash2,
  Upload,
  X,
} from 'lucide-react'
import { fromUtm, toUtm, uid } from '../geo'
import './UndergroundModelFeature.css'

const STORAGE_KEY = 'evren-jeofizik-gis-underground-model-v1'
const STANDALONE_POINTS_KEY = 'evren-jeofizik-gis-standalone-points-v1'
const FIELD_POINTS_KEY = 'evren-jeofizik-gis-field-points-v1'
const OPEN_EVENT = 'evren-open-underground-model'
const CLEAR_LABEL = 'Evet, Kalıcı Sil'

type ModelTab = 'boreholes' | 'preview' | 'export'

type LithologyInterval = {
  id: string
  from: number
  to: number
  lithology: string
  note: string
  color: string
}

type Borehole = {
  id: string
  name: string
  easting: number
  northing: number
  elevation: number
  zone: number
  hemisphere: 'N' | 'S'
  totalDepth: number
  waterLevel: number | null
  temperature: number | null
  note: string
  source?: string
  intervals: LithologyInterval[]
  updatedAt: number
}

type StoredModel = {
  version: 1
  boreholes: Borehole[]
}

type MapPointLike = {
  id?: string
  name?: string
  lat?: number
  lng?: number
  note?: string
}

const LITHOLOGY_PRESETS = [
  { name: 'Alüvyon', color: '#d8b56a' },
  { name: 'Kil', color: '#9d7358' },
  { name: 'Kum', color: '#e3c878' },
  { name: 'Kumtaşı', color: '#c9874d' },
  { name: 'Kireçtaşı', color: '#aeb9c5' },
  { name: 'Tüf', color: '#cdbb9a' },
  { name: 'Bazalt', color: '#515a67' },
  { name: 'Granit', color: '#d49795' },
  { name: 'Şist', color: '#778390' },
  { name: 'Fay / Kırık Zon', color: '#d95d58' },
]

function blankInterval(from = 0, to = 10): LithologyInterval {
  return {
    id: uid('lit'),
    from,
    to,
    lithology: 'Alüvyon',
    note: '',
    color: LITHOLOGY_PRESETS[0].color,
  }
}

function blankBorehole(index = 0): Borehole {
  return {
    id: uid('borehole'),
    name: `Sondaj ${index + 1}`,
    easting: 0,
    northing: 0,
    elevation: 0,
    zone: 36,
    hemisphere: 'N',
    totalDepth: 100,
    waterLevel: null,
    temperature: null,
    note: '',
    intervals: [blankInterval(0, 20)],
    updatedAt: Date.now(),
  }
}

function finite(value: unknown, fallback = 0) {
  const number = Number(value)
  return Number.isFinite(number) ? number : fallback
}

function nullableNumber(value: unknown) {
  if (value === '' || value === null || value === undefined) return null
  const number = Number(value)
  return Number.isFinite(number) ? number : null
}

function normalizeInterval(value: Partial<LithologyInterval>, index: number): LithologyInterval {
  const preset = LITHOLOGY_PRESETS.find((item) => item.name === value.lithology)
  return {
    id: typeof value.id === 'string' && value.id ? value.id : uid(`lit-${index}`),
    from: Math.max(0, finite(value.from)),
    to: Math.max(0, finite(value.to)),
    lithology: typeof value.lithology === 'string' && value.lithology.trim() ? value.lithology.trim() : 'Bilinmiyor',
    note: typeof value.note === 'string' ? value.note : '',
    color: typeof value.color === 'string' && value.color ? value.color : preset?.color || '#8aa0b5',
  }
}

function normalizeBorehole(value: Partial<Borehole>, index: number): Borehole {
  const intervals = Array.isArray(value.intervals)
    ? value.intervals.map(normalizeInterval).sort((a, b) => a.from - b.from)
    : []
  return {
    id: typeof value.id === 'string' && value.id ? value.id : uid(`borehole-${index}`),
    name: typeof value.name === 'string' && value.name.trim() ? value.name.trim() : `Sondaj ${index + 1}`,
    easting: finite(value.easting),
    northing: finite(value.northing),
    elevation: finite(value.elevation),
    zone: Math.max(1, Math.min(60, Math.round(finite(value.zone, 36)))),
    hemisphere: value.hemisphere === 'S' ? 'S' : 'N',
    totalDepth: Math.max(0, finite(value.totalDepth)),
    waterLevel: nullableNumber(value.waterLevel),
    temperature: nullableNumber(value.temperature),
    note: typeof value.note === 'string' ? value.note : '',
    source: typeof value.source === 'string' ? value.source : undefined,
    intervals,
    updatedAt: finite(value.updatedAt, Date.now()),
  }
}

function readModel(): Borehole[] {
  try {
    const raw = JSON.parse(localStorage.getItem(STORAGE_KEY) || 'null') as Partial<StoredModel> | null
    if (!raw || !Array.isArray(raw.boreholes)) return []
    return raw.boreholes.map(normalizeBorehole)
  } catch {
    return []
  }
}

function saveModel(boreholes: Borehole[]) {
  const model: StoredModel = { version: 1, boreholes }
  localStorage.setItem(STORAGE_KEY, JSON.stringify(model))
}

function csvCell(value: unknown) {
  const text = value === null || value === undefined ? '' : String(value)
  return `"${text.replace(/"/g, '""')}"`
}

function downloadBlob(blob: Blob, fileName: string) {
  const url = URL.createObjectURL(blob)
  const link = document.createElement('a')
  link.href = url
  link.download = fileName
  document.body.appendChild(link)
  link.click()
  link.remove()
  window.setTimeout(() => URL.revokeObjectURL(url), 500)
}

function boreholeCsv(boreholes: Borehole[]) {
  const header = ['SONDAJ', 'UTM_ZONE', 'HEMISPHERE', 'EASTING', 'NORTHING', 'KOT_Z', 'TOPLAM_DERINLIK_M', 'SU_SEVIYESI_M', 'SICAKLIK_C', 'LAT', 'LON', 'NOT']
  const rows = boreholes.map((hole) => {
    let lat = ''
    let lng = ''
    if (hole.easting && hole.northing) {
      try {
        const point = fromUtm(hole.easting, hole.northing, hole.zone, hole.hemisphere)
        lat = point.lat.toFixed(7)
        lng = point.lng.toFixed(7)
      } catch { /* CSV remains usable with UTM coordinates. */ }
    }
    return [
      hole.name,
      hole.zone,
      hole.hemisphere,
      hole.easting.toFixed(3),
      hole.northing.toFixed(3),
      hole.elevation.toFixed(3),
      hole.totalDepth.toFixed(2),
      hole.waterLevel ?? '',
      hole.temperature ?? '',
      lat,
      lng,
      hole.note,
    ]
  })
  return '\ufeff' + [header, ...rows].map((row) => row.map(csvCell).join(';')).join('\r\n')
}

function intervalCsv(boreholes: Borehole[]) {
  const header = ['SONDAJ', 'FROM_M', 'TO_M', 'LITOLOJI', 'ACIKLAMA', 'UST_KOT_Z', 'ALT_KOT_Z', 'RENK']
  const rows = boreholes.flatMap((hole) => hole.intervals.map((interval) => [
    hole.name,
    interval.from.toFixed(2),
    interval.to.toFixed(2),
    interval.lithology,
    interval.note,
    (hole.elevation - interval.from).toFixed(3),
    (hole.elevation - interval.to).toFixed(3),
    interval.color,
  ]))
  return '\ufeff' + [header, ...rows].map((row) => row.map(csvCell).join(';')).join('\r\n')
}

function asciiLayerName(value: string) {
  return value
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/ı/g, 'i')
    .replace(/İ/g, 'I')
    .replace(/[^A-Za-z0-9_-]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 30)
    .toUpperCase() || 'LITOLOJI'
}

function dxfText(boreholes: Borehole[]) {
  const layers = new Set<string>(['SONDAJ_EKSEN', 'SONDAJ_ETIKET'])
  boreholes.forEach((hole) => hole.intervals.forEach((interval) => layers.add(`LIT_${asciiLayerName(interval.lithology)}`)))
  const values: string[] = ['0', 'SECTION', '2', 'HEADER', '0', 'ENDSEC', '0', 'SECTION', '2', 'TABLES', '0', 'TABLE', '2', 'LAYER', '70', String(layers.size)]
  layers.forEach((layer) => values.push('0', 'LAYER', '2', layer, '70', '0', '62', '7', '6', 'CONTINUOUS'))
  values.push('0', 'ENDTAB', '0', 'ENDSEC', '0', 'SECTION', '2', 'ENTITIES')

  boreholes.forEach((hole) => {
    const bottomZ = hole.elevation - hole.totalDepth
    values.push(
      '0', 'LINE', '8', 'SONDAJ_EKSEN',
      '10', String(hole.easting), '20', String(hole.northing), '30', String(hole.elevation),
      '11', String(hole.easting), '21', String(hole.northing), '31', String(bottomZ),
      '0', 'TEXT', '8', 'SONDAJ_ETIKET',
      '10', String(hole.easting), '20', String(hole.northing), '30', String(hole.elevation + 1),
      '40', '2.5', '1', asciiLayerName(hole.name),
    )
    hole.intervals.forEach((interval) => {
      values.push(
        '0', 'LINE', '8', `LIT_${asciiLayerName(interval.lithology)}`,
        '10', String(hole.easting), '20', String(hole.northing), '30', String(hole.elevation - interval.from),
        '11', String(hole.easting), '21', String(hole.northing), '31', String(hole.elevation - interval.to),
      )
    })
  })

  values.push('0', 'ENDSEC', '0', 'EOF')
  return values.join('\r\n')
}

function warningsFor(hole: Borehole) {
  const warnings: string[] = []
  if (!hole.easting || !hole.northing) warnings.push('UTM koordinatı eksik')
  if (hole.totalDepth <= 0) warnings.push('Toplam derinlik girilmedi')
  if (!hole.intervals.length) warnings.push('Litoloji aralığı yok')
  let previousTo = 0
  hole.intervals.slice().sort((a, b) => a.from - b.from).forEach((interval) => {
    if (interval.to <= interval.from) warnings.push(`${interval.lithology}: aralık geçersiz`)
    if (interval.from < previousTo) warnings.push(`${interval.lithology}: aralık çakışıyor`)
    if (interval.to > hole.totalDepth && hole.totalDepth > 0) warnings.push(`${interval.lithology}: toplam derinliği aşıyor`)
    previousTo = Math.max(previousTo, interval.to)
  })
  return warnings
}

function readMapPoints() {
  const values: Array<MapPointLike & { source: string }> = []
  try {
    const standalone = JSON.parse(localStorage.getItem(STANDALONE_POINTS_KEY) || '[]') as MapPointLike[]
    if (Array.isArray(standalone)) standalone.forEach((point) => values.push({ ...point, source: 'Nokta kayıtları' }))
  } catch { /* Ignore malformed legacy data. */ }
  try {
    const field = JSON.parse(localStorage.getItem(FIELD_POINTS_KEY) || '[]') as MapPointLike[]
    if (Array.isArray(field)) field.forEach((point) => values.push({ ...point, source: 'Saha Noktaları' }))
  } catch { /* Ignore malformed legacy data. */ }
  return values.filter((point) => Number.isFinite(Number(point.lat)) && Number.isFinite(Number(point.lng)))
}

function ThreeDPreview({ boreholes }: { boreholes: Borehole[] }) {
  if (!boreholes.length) {
    return <div className="underground-empty"><Box size={34} /><strong>3B önizleme için sondaj ekleyin</strong><span>En az bir sondajın koordinat, kot ve derinlik bilgilerini girin.</span></div>
  }

  const eastings = boreholes.map((hole) => hole.easting)
  const northings = boreholes.map((hole) => hole.northing)
  const elevations = boreholes.map((hole) => hole.elevation)
  const minE = Math.min(...eastings)
  const maxE = Math.max(...eastings)
  const minN = Math.min(...northings)
  const maxN = Math.max(...northings)
  const maxZ = Math.max(...elevations)
  const minZ = Math.min(...elevations)
  const spanE = Math.max(1, maxE - minE)
  const spanN = Math.max(1, maxN - minN)
  const spanZ = Math.max(1, maxZ - minZ)
  const maxDepth = Math.max(10, ...boreholes.map((hole) => hole.totalDepth))
  const depthScale = 250 / maxDepth

  const topPoint = (hole: Borehole) => {
    const east = (hole.easting - minE) / spanE
    const north = (hole.northing - minN) / spanN
    const elevationDrop = ((maxZ - hole.elevation) / spanZ) * 42
    return {
      x: 105 + east * 510 + north * 150,
      y: 88 + (1 - north) * 88 + east * 24 + elevationDrop,
    }
  }

  return (
    <div className="underground-preview-card">
      <svg viewBox="0 0 860 420" className="underground-preview-svg" role="img" aria-label="Sondajların üç boyutlu yeraltı önizlemesi">
        <defs>
          <linearGradient id="underground-surface" x1="0" x2="1">
            <stop offset="0%" stopColor="#133150" stopOpacity="0.42" />
            <stop offset="100%" stopColor="#1d6d82" stopOpacity="0.2" />
          </linearGradient>
        </defs>
        <path d="M70 112 L605 72 L805 152 L270 194 Z" fill="url(#underground-surface)" stroke="#3a6c87" strokeWidth="1" />
        {[0, 1, 2, 3, 4].map((index) => <line key={`grid-a-${index}`} x1={70 + index * 134} y1={112 - index * 10} x2={270 + index * 134} y2={194 - index * 10} stroke="#294a63" strokeWidth="0.8" strokeDasharray="4 6" />)}
        {[0, 1, 2, 3].map((index) => <line key={`grid-b-${index}`} x1={70 + index * 66} y1={112 + index * 27} x2={605 + index * 66} y2={72 + index * 27} stroke="#294a63" strokeWidth="0.8" strokeDasharray="4 6" />)}
        {boreholes.map((hole) => {
          const top = topPoint(hole)
          const intervals = hole.intervals.length ? hole.intervals : [{ id: 'axis', from: 0, to: hole.totalDepth, lithology: 'Bilinmiyor', note: '', color: '#6f8396' }]
          return (
            <g key={hole.id}>
              <line x1={top.x} y1={top.y} x2={top.x} y2={top.y + hole.totalDepth * depthScale} stroke="#d8e5ee" strokeWidth="2" opacity="0.35" />
              {intervals.map((interval) => (
                <line
                  key={interval.id}
                  x1={top.x}
                  y1={top.y + interval.from * depthScale}
                  x2={top.x}
                  y2={top.y + interval.to * depthScale}
                  stroke={interval.color}
                  strokeWidth="11"
                  strokeLinecap="butt"
                />
              ))}
              <circle cx={top.x} cy={top.y} r="5.5" fill="#eef8ff" stroke="#1597e5" strokeWidth="2.5" />
              <text x={top.x + 9} y={top.y - 8} fill="#eef7ff" fontSize="12" fontWeight="700">{hole.name}</text>
              <text x={top.x + 9} y={top.y + 7} fill="#8fb4ca" fontSize="9">{hole.elevation.toFixed(1)} m / {hole.totalDepth.toFixed(1)} m</text>
            </g>
          )
        })}
        <text x="72" y="28" fill="#dcecf7" fontSize="13" fontWeight="700">EVREN GIS · Yeraltı 3B Önizleme</text>
        <text x="72" y="47" fill="#7ea6bc" fontSize="10">Görsel ölçek önizleme amaçlıdır; Netcad aktarımında gerçek UTM E/N/Z değerleri kullanılır.</text>
      </svg>
    </div>
  )
}

export default function UndergroundModelFeature() {
  const [open, setOpen] = useState(false)
  const [tab, setTab] = useState<ModelTab>('boreholes')
  const [boreholes, setBoreholes] = useState<Borehole[]>(readModel)
  const [selectedId, setSelectedId] = useState<string | null>(() => readModel()[0]?.id ?? null)
  const [draft, setDraft] = useState<Borehole | null>(() => readModel()[0] ?? null)
  const [status, setStatus] = useState<string>('')
  const fileInputRef = useRef<HTMLInputElement | null>(null)

  const selected = boreholes.find((hole) => hole.id === selectedId) ?? null
  const totalMeters = useMemo(() => boreholes.reduce((sum, hole) => sum + hole.totalDepth, 0), [boreholes])
  const intervalCount = useMemo(() => boreholes.reduce((sum, hole) => sum + hole.intervals.length, 0), [boreholes])
  const issueCount = useMemo(() => boreholes.reduce((sum, hole) => sum + warningsFor(hole).length, 0), [boreholes])

  useEffect(() => saveModel(boreholes), [boreholes])

  useEffect(() => {
    const show = () => {
      setOpen(true)
      setStatus('')
      setDraft(selected ? structuredClone(selected) : boreholes[0] ? structuredClone(boreholes[0]) : null)
    }
    window.addEventListener(OPEN_EVENT, show)
    return () => window.removeEventListener(OPEN_EVENT, show)
  }, [selected, boreholes])

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
    const onClick = (event: MouseEvent) => {
      const target = event.target
      if (!(target instanceof Element)) return
      const button = target.closest<HTMLButtonElement>('button.confirm-delete')
      if (!button || button.textContent?.trim() !== CLEAR_LABEL) return
      localStorage.removeItem(STORAGE_KEY)
      setBoreholes([])
      setSelectedId(null)
      setDraft(null)
    }
    document.addEventListener('click', onClick, true)
    return () => document.removeEventListener('click', onClick, true)
  }, [])

  const selectHole = (hole: Borehole) => {
    setSelectedId(hole.id)
    setDraft(structuredClone(hole))
    setStatus('')
  }

  const newHole = () => {
    const next = blankBorehole(boreholes.length)
    setSelectedId(next.id)
    setDraft(next)
    setStatus('Yeni sondaj kartı hazır. Bilgileri girip Kaydet seçin.')
  }

  const saveDraft = () => {
    if (!draft) return
    const next = { ...draft, updatedAt: Date.now(), intervals: draft.intervals.slice().sort((a, b) => a.from - b.from) }
    setBoreholes((current) => current.some((hole) => hole.id === next.id)
      ? current.map((hole) => hole.id === next.id ? next : hole)
      : [...current, next])
    setSelectedId(next.id)
    setDraft(structuredClone(next))
    setStatus('Sondaj bilgileri kaydedildi.')
  }

  const deleteHole = (id: string) => {
    const remaining = boreholes.filter((hole) => hole.id !== id)
    setBoreholes(remaining)
    const next = remaining[0] ?? null
    setSelectedId(next?.id ?? null)
    setDraft(next ? structuredClone(next) : null)
    setStatus('Sondaj kaydı silindi.')
  }

  const importMapPoints = () => {
    const points = readMapPoints()
    const existing = new Set(boreholes.map((hole) => `${hole.easting.toFixed(1)}:${hole.northing.toFixed(1)}:${hole.zone}`))
    const imported: Borehole[] = []
    points.forEach((point, index) => {
      const lat = Number(point.lat)
      const lng = Number(point.lng)
      try {
        const utm = toUtm(lat, lng)
        const key = `${utm.easting.toFixed(1)}:${utm.northing.toFixed(1)}:${utm.zone}`
        if (existing.has(key)) return
        existing.add(key)
        imported.push({
          ...blankBorehole(boreholes.length + imported.length),
          name: point.name?.trim() || `Sondaj Adayı ${index + 1}`,
          easting: utm.easting,
          northing: utm.northing,
          elevation: 0,
          zone: utm.zone,
          hemisphere: utm.hemisphere,
          totalDepth: 0,
          intervals: [],
          note: point.note || '',
          source: point.source,
        })
      } catch { /* Invalid map points are ignored. */ }
    })
    if (!imported.length) {
      setStatus(points.length ? 'Harita noktaları zaten ekli veya aktarılamadı.' : 'Aktarılabilecek Nokta kaydı / Saha Noktası bulunamadı.')
      return
    }
    setBoreholes((current) => [...current, ...imported])
    setSelectedId(imported[0].id)
    setDraft(structuredClone(imported[0]))
    setStatus(`${imported.length} harita/saha noktası sondaj adayı olarak eklendi. Kot ve derinlikleri tamamlayın.`)
  }

  const updateInterval = (id: string, patch: Partial<LithologyInterval>) => {
    setDraft((current) => current ? {
      ...current,
      intervals: current.intervals.map((interval) => interval.id === id ? { ...interval, ...patch } : interval),
    } : current)
  }

  const addInterval = () => {
    setDraft((current) => {
      if (!current) return current
      const lastTo = current.intervals.reduce((max, interval) => Math.max(max, interval.to), 0)
      const suggestedTo = current.totalDepth > lastTo ? current.totalDepth : lastTo + 10
      return { ...current, intervals: [...current.intervals, blankInterval(lastTo, suggestedTo)] }
    })
  }

  const resetModel = () => {
    if (!window.confirm('3B modeldeki tüm sondaj ve litoloji kayıtları silinsin mi?')) return
    setBoreholes([])
    setSelectedId(null)
    setDraft(null)
    setStatus('3B model kayıtları temizlendi.')
  }

  const downloadCsvFiles = () => {
    downloadBlob(new Blob([boreholeCsv(boreholes)], { type: 'text/csv;charset=utf-8' }), 'evren-netcad-sondajlar.csv')
    window.setTimeout(() => downloadBlob(new Blob([intervalCsv(boreholes)], { type: 'text/csv;charset=utf-8' }), 'evren-netcad-litoloji.csv'), 180)
  }

  const downloadDxf = () => downloadBlob(new Blob([dxfText(boreholes)], { type: 'application/dxf;charset=utf-8' }), 'evren-netcad-sondaj-3d.dxf')

  const downloadPackage = async () => {
    const zip = new JSZip()
    zip.file('netcad-sondajlar.csv', boreholeCsv(boreholes))
    zip.file('netcad-litoloji.csv', intervalCsv(boreholes))
    zip.file('netcad-sondaj-3d.dxf', dxfText(boreholes))
    zip.file('evren-3d-model.json', JSON.stringify({ version: 1, boreholes }, null, 2))
    zip.file('OKU-BENI.txt', [
      'EVREN GIS - NETCAD 3B YERALTI MODEL PAKETI',
      '',
      'netcad-sondajlar.csv : Sondaj agiz koordinatlari, kot, derinlik, su seviyesi ve sicaklik.',
      'netcad-litoloji.csv  : Derinlik araliklari ve mutlak ust/alt Z kotlari.',
      'netcad-sondaj-3d.dxf : Gercek UTM E/N/Z koordinatlarinda sondaj eksenleri ve litoloji segmentleri.',
      'evren-3d-model.json  : Evren GIS icin geri yuklenebilir model yedegi.',
      '',
      'Not: 3B onizleme temsili perspektiftir. DXF/CSV ciktilari girilen gercek koordinat ve kot degerlerini kullanir.',
    ].join('\r\n'))
    const blob = await zip.generateAsync({ type: 'blob', compression: 'DEFLATE', compressionOptions: { level: 6 } })
    downloadBlob(blob, 'evren-netcad-3d-model-paketi.zip')
  }

  const exportJson = () => downloadBlob(new Blob([JSON.stringify({ version: 1, boreholes }, null, 2)], { type: 'application/json' }), 'evren-3d-model-yedek.json')

  const importJson = async (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0]
    event.target.value = ''
    if (!file) return
    try {
      const parsed = JSON.parse(await file.text()) as Partial<StoredModel>
      if (!Array.isArray(parsed.boreholes)) throw new Error('INVALID')
      const next = parsed.boreholes.map(normalizeBorehole)
      setBoreholes(next)
      setSelectedId(next[0]?.id ?? null)
      setDraft(next[0] ? structuredClone(next[0]) : null)
      setStatus(`${next.length} sondaj kaydı yedekten yüklendi.`)
    } catch {
      setStatus('JSON yedek dosyası okunamadı.')
    }
  }

  if (!open) return null

  return (
    <div className="underground-overlay" role="dialog" aria-modal="true" aria-label="3B Yeraltı Modelleme">
      <section className="underground-shell">
        <header className="underground-header">
          <div className="underground-title">
            <span className="underground-title-icon"><Box size={23} /></span>
            <div><small>EVREN GIS · NETCAD HAZIRLIK</small><h2>3B Yeraltı Modelleme</h2></div>
          </div>
          <button type="button" className="underground-close" onClick={() => setOpen(false)} aria-label="3B modeli kapat"><X size={20} /></button>
        </header>

        <div className="underground-stats">
          <span><strong>{boreholes.length}</strong><small>Sondaj</small></span>
          <span><strong>{totalMeters.toFixed(1)} m</strong><small>Toplam derinlik</small></span>
          <span><strong>{intervalCount}</strong><small>Litoloji aralığı</small></span>
          <span className={issueCount ? 'has-issue' : ''}><strong>{issueCount}</strong><small>Kontrol uyarısı</small></span>
        </div>

        <nav className="underground-tabs">
          <button type="button" className={tab === 'boreholes' ? 'is-active' : ''} onClick={() => setTab('boreholes')}><Database size={16} /> Sondajlar</button>
          <button type="button" className={tab === 'preview' ? 'is-active' : ''} onClick={() => setTab('preview')}><Eye size={16} /> 3B Önizleme</button>
          <button type="button" className={tab === 'export' ? 'is-active' : ''} onClick={() => setTab('export')}><FileArchive size={16} /> Netcad Aktarım</button>
        </nav>

        <div className="underground-content">
          {tab === 'boreholes' ? (
            <div className="underground-borehole-layout">
              <aside className="underground-list-pane">
                <div className="underground-pane-actions">
                  <button type="button" onClick={newHole}><Plus size={15} /> Yeni Sondaj</button>
                  <button type="button" onClick={importMapPoints}><MapPin size={15} /> Haritadan Al</button>
                </div>
                <div className="underground-hole-list">
                  {boreholes.map((hole) => {
                    const warnings = warningsFor(hole)
                    return (
                      <button key={hole.id} type="button" className={selectedId === hole.id ? 'is-selected' : ''} onClick={() => selectHole(hole)}>
                        <span className="underground-hole-dot" />
                        <span><strong>{hole.name}</strong><small>{hole.zone}{hole.hemisphere} · {hole.totalDepth.toFixed(1)} m{hole.source ? ` · ${hole.source}` : ''}</small></span>
                        {warnings.length ? <AlertTriangle size={14} className="underground-warning-icon" /> : null}
                      </button>
                    )
                  })}
                  {!boreholes.length ? <div className="underground-list-empty">Henüz sondaj kaydı yok.</div> : null}
                </div>
                <button type="button" className="underground-reset-link" onClick={resetModel}><RotateCcw size={14} /> 3B model verilerini temizle</button>
              </aside>

              <main className="underground-editor-pane">
                {draft ? (
                  <>
                    <div className="underground-editor-heading">
                      <div><strong>{selected ? 'Sondaj Bilgileri' : 'Yeni Sondaj'}</strong><small>Netcad için E/N/Z ve kuyu bilgilerini girin</small></div>
                      <div className="underground-editor-actions">
                        {selected ? <button type="button" className="danger" onClick={() => deleteHole(selected.id)}><Trash2 size={15} /> Sil</button> : null}
                        <button type="button" className="primary" onClick={saveDraft}><Save size={15} /> Kaydet</button>
                      </div>
                    </div>

                    <div className="underground-form-grid">
                      <label className="span-2"><span>Sondaj Adı</span><input value={draft.name} onChange={(event) => setDraft({ ...draft, name: event.target.value })} /></label>
                      <label><span>Doğu E / Easting</span><input inputMode="decimal" value={draft.easting || ''} onChange={(event) => setDraft({ ...draft, easting: finite(event.target.value) })} placeholder="Örn. 482350.25" /></label>
                      <label><span>Kuzey N / Northing</span><input inputMode="decimal" value={draft.northing || ''} onChange={(event) => setDraft({ ...draft, northing: finite(event.target.value) })} placeholder="Örn. 4312450.80" /></label>
                      <label><span>Kot Z (m)</span><input inputMode="decimal" value={draft.elevation || ''} onChange={(event) => setDraft({ ...draft, elevation: finite(event.target.value) })} placeholder="Örn. 1045.5" /></label>
                      <label><span>Toplam Derinlik (m)</span><input inputMode="decimal" value={draft.totalDepth || ''} onChange={(event) => setDraft({ ...draft, totalDepth: Math.max(0, finite(event.target.value)) })} placeholder="Örn. 250" /></label>
                      <label><span>UTM Zon</span><input inputMode="numeric" value={draft.zone} onChange={(event) => setDraft({ ...draft, zone: Math.max(1, Math.min(60, Math.round(finite(event.target.value, 36)))) })} /></label>
                      <label><span>Yarımküre</span><select value={draft.hemisphere} onChange={(event) => setDraft({ ...draft, hemisphere: event.target.value === 'S' ? 'S' : 'N' })}><option value="N">N · Kuzey</option><option value="S">S · Güney</option></select></label>
                      <label><span>Su Seviyesi (m)</span><input inputMode="decimal" value={draft.waterLevel ?? ''} onChange={(event) => setDraft({ ...draft, waterLevel: nullableNumber(event.target.value) })} placeholder="Opsiyonel" /></label>
                      <label><span>Sıcaklık (°C)</span><input inputMode="decimal" value={draft.temperature ?? ''} onChange={(event) => setDraft({ ...draft, temperature: nullableNumber(event.target.value) })} placeholder="Opsiyonel" /></label>
                      <label className="span-2"><span>Not / Kırık / Fay Bilgisi</span><textarea value={draft.note} onChange={(event) => setDraft({ ...draft, note: event.target.value })} placeholder="Sondaj notları, kırık-fay zonu, su gelişi vb." /></label>
                    </div>

                    <div className="underground-lithology-heading"><div><strong>Litoloji Aralıkları</strong><small>Derinlik başlangıç-bitiş ve formasyon bilgileri</small></div><button type="button" onClick={addInterval}><Plus size={14} /> Aralık Ekle</button></div>
                    <div className="underground-intervals">
                      {draft.intervals.map((interval) => (
                        <div className="underground-interval-row" key={interval.id}>
                          <span className="underground-color-chip" style={{ background: interval.color }} />
                          <label><small>Başlangıç</small><input inputMode="decimal" value={interval.from} onChange={(event) => updateInterval(interval.id, { from: Math.max(0, finite(event.target.value)) })} /></label>
                          <label><small>Bitiş</small><input inputMode="decimal" value={interval.to} onChange={(event) => updateInterval(interval.id, { to: Math.max(0, finite(event.target.value)) })} /></label>
                          <label className="lithology"><small>Litoloji</small><select value={interval.lithology} onChange={(event) => {
                            const preset = LITHOLOGY_PRESETS.find((item) => item.name === event.target.value)
                            updateInterval(interval.id, { lithology: event.target.value, color: preset?.color || interval.color })
                          }}>{LITHOLOGY_PRESETS.map((item) => <option key={item.name} value={item.name}>{item.name}</option>)}</select></label>
                          <label className="interval-note"><small>Açıklama</small><input value={interval.note} onChange={(event) => updateInterval(interval.id, { note: event.target.value })} placeholder="Opsiyonel" /></label>
                          <button type="button" className="interval-delete" onClick={() => setDraft({ ...draft, intervals: draft.intervals.filter((item) => item.id !== interval.id) })} aria-label="Litoloji aralığını sil"><Trash2 size={14} /></button>
                        </div>
                      ))}
                      {!draft.intervals.length ? <div className="underground-inline-empty">Litoloji aralığı yok. “Aralık Ekle” ile başlayın.</div> : null}
                    </div>
                    {warningsFor(draft).length ? <div className="underground-validation"><AlertTriangle size={16} /><div><strong>Kontrol edilmesi gerekenler</strong>{warningsFor(draft).map((warning) => <span key={warning}>{warning}</span>)}</div></div> : null}
                  </>
                ) : <div className="underground-empty"><Database size={34} /><strong>Sondaj seçin veya yeni kayıt oluşturun</strong><span>Haritadaki Nokta kayıtları ve Saha Noktaları da başlangıç koordinatı olarak alınabilir.</span></div>}
              </main>
            </div>
          ) : null}

          {tab === 'preview' ? (
            <div className="underground-preview-pane">
              <div className="underground-section-heading"><div><strong>Yeraltı 3B Önizleme</strong><small>Kuyu eksenleri, kot ve litoloji aralıklarını birlikte görün</small></div></div>
              <ThreeDPreview boreholes={boreholes} />
              <div className="underground-legend">
                {LITHOLOGY_PRESETS.map((item) => <span key={item.name}><i style={{ background: item.color }} />{item.name}</span>)}
              </div>
            </div>
          ) : null}

          {tab === 'export' ? (
            <div className="underground-export-pane">
              <div className="underground-export-hero">
                <span><FileArchive size={28} /></span>
                <div><small>NETCAD / NETPROMINE HAZIRLIK</small><h3>3B Model Aktarım Paketi</h3><p>Sondaj ağız koordinatları, litoloji aralıkları ve gerçek UTM E/N/Z geometrisini tek pakette dışa aktarır.</p></div>
              </div>
              <div className="underground-export-grid">
                <button type="button" disabled={!boreholes.length} onClick={() => void downloadPackage()}><FileArchive size={21} /><span><strong>Netcad Paketini İndir</strong><small>CSV + litoloji + 3B DXF + JSON yedek</small></span></button>
                <button type="button" disabled={!boreholes.length} onClick={downloadCsvFiles}><Download size={21} /><span><strong>CSV Dosyaları</strong><small>Sondaj ve litoloji tabloları</small></span></button>
                <button type="button" disabled={!boreholes.length} onClick={downloadDxf}><Box size={21} /><span><strong>3B DXF</strong><small>Gerçek E/N/Z sondaj eksenleri</small></span></button>
                <button type="button" disabled={!boreholes.length} onClick={exportJson}><Save size={21} /><span><strong>Model Yedeği</strong><small>Evren GIS JSON yedeği</small></span></button>
                <button type="button" onClick={() => fileInputRef.current?.click()}><Upload size={21} /><span><strong>Yedek Yükle</strong><small>Daha önce kaydedilmiş JSON model</small></span></button>
              </div>
              <input ref={fileInputRef} className="underground-hidden-input" type="file" accept="application/json,.json" onChange={(event) => void importJson(event)} />
              <div className="underground-export-note"><AlertTriangle size={16} /><div><strong>Model doğruluğu veri doğruluğuna bağlıdır.</strong><span>Evren GIS, girilen sondaj ve litoloji verilerini Netcad’e hazırlar; bilinmeyen yeraltı birimlerini kendiliğinden kesin olarak üretmez.</span></div></div>
              {issueCount ? <div className="underground-validation"><AlertTriangle size={16} /><div><strong>{issueCount} veri kontrol uyarısı var</strong><span>Aktarım öncesi Sondajlar sekmesindeki uyarıları düzeltmeniz önerilir.</span></div></div> : null}
            </div>
          ) : null}
        </div>

        {status ? <div className="underground-status">{status}</div> : null}
      </section>
    </div>
  )
}
