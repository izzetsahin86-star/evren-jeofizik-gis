import { useEffect, useState, type FormEvent } from 'react'
import { MapPin, RefreshCw, Save } from 'lucide-react'
import { applyAdminAccessConfig, getAdminAccessConfig, type AdminAccessConfig, type AdminAccessTarget } from '../adminAccess'

type DraftTarget = {
  id: number
  easting: string
  northing: string
}

type ApiPayload = {
  ok?: boolean
  config?: AdminAccessConfig
  error?: string
  message?: string
}

function draftFromConfig(config: AdminAccessConfig): DraftTarget[] {
  return config.targets.map((target) => ({
    id: target.id,
    easting: String(target.easting),
    northing: String(target.northing),
  }))
}

async function request(path: string, options?: RequestInit) {
  const response = await fetch(path, { credentials: 'same-origin', ...options })
  const payload = await response.json().catch(() => ({})) as ApiPayload
  if (!response.ok) throw new Error(payload.message || 'Koordinat ayarları güncellenemedi.')
  return payload
}

export default function AdminCoordinateSettings() {
  const [targets, setTargets] = useState<DraftTarget[]>(() => draftFromConfig(getAdminAccessConfig()))
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [updatedAt, setUpdatedAt] = useState<string | null>(getAdminAccessConfig().updatedAt)
  const [message, setMessage] = useState<{ tone: 'success' | 'error'; text: string } | null>(null)

  useEffect(() => {
    let mounted = true
    request('/api/admin/access-config')
      .then((payload) => {
        if (!mounted || !payload.config) return
        applyAdminAccessConfig(payload.config)
        setTargets(draftFromConfig(payload.config))
        setUpdatedAt(payload.config.updatedAt)
      })
      .catch((error) => {
        if (!mounted) return
        setMessage({ tone: 'error', text: error instanceof Error ? error.message : 'Koordinatlar alınamadı.' })
      })
      .finally(() => { if (mounted) setLoading(false) })
    return () => { mounted = false }
  }, [])

  const updateTarget = (id: number, key: 'easting' | 'northing', value: string) => {
    setTargets((current) => current.map((target) => target.id === id ? { ...target, [key]: value } : target))
  }

  const submit = async (event: FormEvent) => {
    event.preventDefault()
    const normalized: AdminAccessTarget[] = targets.map((target) => ({
      id: target.id,
      easting: Number(target.easting),
      northing: Number(target.northing),
    }))
    if (normalized.some((target) => !Number.isFinite(target.easting) || !Number.isFinite(target.northing))) {
      setMessage({ tone: 'error', text: 'Üç noktanın Easting ve Northing değerlerini eksiksiz girin.' })
      return
    }

    setSaving(true)
    setMessage(null)
    try {
      const payload = await request('/api/admin/access-config', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ targets: normalized }),
      })
      if (!payload.config) throw new Error('Sunucu yeni koordinatları doğrulayamadı.')
      applyAdminAccessConfig(payload.config)
      setTargets(draftFromConfig(payload.config))
      setUpdatedAt(payload.config.updatedAt)
      setMessage({ tone: 'success', text: 'Gizli giriş koordinatları değiştirildi. Yeni noktalar hemen aktif.' })
    } catch (error) {
      setMessage({ tone: 'error', text: error instanceof Error ? error.message : 'Koordinatlar kaydedilemedi.' })
    } finally {
      setSaving(false)
    }
  }

  return (
    <section className="admin-settings-card">
      <div className="admin-card-heading">
        <div><MapPin size={18} /><span><strong>Gizli Giriş Koordinatları</strong><small>UTM 37S · giriş sırası: Nokta 2 → Nokta 1 → Nokta 3</small></span></div>
      </div>
      <form className="admin-settings-form" onSubmit={submit}>
        {targets.map((target) => (
          <div key={target.id} style={{ display: 'grid', gap: 11 }}>
            <label>
              Nokta {target.id} · Easting
              <input
                type="number"
                min="100000"
                max="900000"
                step="0.01"
                inputMode="decimal"
                value={target.easting}
                onChange={(event) => updateTarget(target.id, 'easting', event.target.value)}
                disabled={loading || saving}
              />
            </label>
            <label>
              Nokta {target.id} · Northing
              <input
                type="number"
                min="0"
                max="10000000"
                step="0.01"
                inputMode="decimal"
                value={target.northing}
                onChange={(event) => updateTarget(target.id, 'northing', event.target.value)}
                disabled={loading || saving}
              />
            </label>
          </div>
        ))}
        {message ? <p className={`admin-settings-message ${message.tone}`}>{message.text}</p> : null}
        <button className="admin-primary-button" type="submit" disabled={loading || saving}>
          {loading || saving ? <RefreshCw className="is-spinning" size={18} /> : <Save size={18} />}
          {loading ? 'Koordinatlar Yükleniyor…' : saving ? 'Kaydediliyor…' : 'Koordinatları Kaydet'}
        </button>
        <small>{updatedAt ? `Son değişiklik: ${new Date(updatedAt).toLocaleString('tr-TR')}` : 'Henüz yönetici tarafından değiştirilmedi.'}</small>
      </form>
    </section>
  )
}
