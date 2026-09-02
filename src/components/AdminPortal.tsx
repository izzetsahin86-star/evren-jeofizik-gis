import { useCallback, useEffect, useMemo, useState, type FormEvent } from 'react'
import { CircleMarker, MapContainer, Popup, TileLayer, useMap } from 'react-leaflet'
import {
  AlertTriangle,
  CheckSquare,
  Clock,
  Database,
  Eye,
  EyeOff,
  KeyRound,
  LayoutDashboard,
  List,
  LogOut,
  Map as MapIcon,
  MapPin,
  Navigation,
  RefreshCw,
  Settings,
  ShieldCheck,
  Square,
  Trash2,
  Users,
  X,
} from 'lucide-react'
import './AdminPortal.css'
import './AdminPortalEnhancements.css'

type LocationInfo = {
  country?: string
  region?: string
  city?: string
  latitude?: number | null
  longitude?: number | null
}

type GpsInfo = {
  latitude: number
  longitude: number
  accuracy: number
  grantedAt: string
}

type Visit = {
  id: string
  visitorId: string
  startedAt: string
  lastSeenAt: string
  endedAt: string | null
  durationSeconds: number
  ip: string
  page: string
  language?: string
  timezone?: string
  userAgent?: string
  approximateLocation?: LocationInfo
  gps?: GpsInfo | null
  visitorVisitCount?: number
}

type TabId = 'overview' | 'visits' | 'map' | 'settings'
type DeletePrompt = { mode: 'selected' | 'all'; count: number } | null

type AdminPortalProps = {
  onClose: () => void
}

class ApiError extends Error {
  status: number
  code: string
  payload: Record<string, unknown>

  constructor(status: number, payload: Record<string, unknown>) {
    super(typeof payload.message === 'string' ? payload.message : 'İşlem tamamlanamadı.')
    this.status = status
    this.code = typeof payload.error === 'string' ? payload.error : 'UNKNOWN_ERROR'
    this.payload = payload
  }
}

async function api<T extends Record<string, unknown>>(path: string, options?: RequestInit): Promise<T> {
  const response = await fetch(path, { credentials: 'same-origin', ...options })
  const payload = await response.json().catch(() => ({})) as Record<string, unknown>
  if (!response.ok) throw new ApiError(response.status, payload)
  return payload as T
}

function deviceName(userAgent = '') {
  const mobile = /Android|iPhone|iPad|Mobile/i.test(userAgent)
  let system = 'Bilinmeyen cihaz'
  if (/iPhone/i.test(userAgent)) system = 'iPhone'
  else if (/iPad/i.test(userAgent)) system = 'iPad'
  else if (/Android/i.test(userAgent)) system = 'Android'
  else if (/Windows/i.test(userAgent)) system = 'Windows'
  else if (/Mac OS X/i.test(userAgent)) system = 'macOS'
  else if (/Linux/i.test(userAgent)) system = 'Linux'

  let browser = ''
  if (/Edg\//i.test(userAgent)) browser = 'Edge'
  else if (/CriOS|Chrome\//i.test(userAgent)) browser = 'Chrome'
  else if (/FxiOS|Firefox\//i.test(userAgent)) browser = 'Firefox'
  else if (/Safari\//i.test(userAgent)) browser = 'Safari'
  return `${system}${browser ? ` · ${browser}` : ''}${mobile && system === 'Bilinmeyen cihaz' ? ' · Mobil' : ''}`
}

function locationName(visit: Visit) {
  const values = [visit.approximateLocation?.city, visit.approximateLocation?.region, visit.approximateLocation?.country]
    .filter((value, index, array) => value && array.indexOf(value) === index)
  return values.length ? values.join(' / ') : 'Konum bilinmiyor'
}

function formatDate(value: string) {
  const date = new Date(value)
  if (!Number.isFinite(date.getTime())) return '—'
  return new Intl.DateTimeFormat('tr-TR', {
    dateStyle: 'short',
    timeStyle: 'medium',
  }).format(date)
}

function formatDuration(seconds: number) {
  const safe = Math.max(0, Math.round(Number(seconds) || 0))
  if (safe < 60) return `${safe} sn`
  if (safe < 3600) return `${Math.floor(safe / 60)} dk ${safe % 60} sn`
  return `${Math.floor(safe / 3600)} sa ${Math.floor((safe % 3600) / 60)} dk`
}

function isToday(value: string) {
  const date = new Date(value)
  const now = new Date()
  return date.getFullYear() === now.getFullYear()
    && date.getMonth() === now.getMonth()
    && date.getDate() === now.getDate()
}

function LoginView({
  storageConfigured,
  loading,
  error,
  onLogin,
}: {
  storageConfigured: boolean | null
  loading: boolean
  error: string
  onLogin: (password: string) => Promise<void>
}) {
  const [password, setPassword] = useState('')
  const [visible, setVisible] = useState(false)

  const submit = (event: FormEvent) => {
    event.preventDefault()
    if (password && !loading && storageConfigured !== false) void onLogin(password)
  }

  return (
    <div className="admin-login-card">
      <div className="admin-login-emblem"><ShieldCheck size={32} /></div>
      <div className="admin-login-heading">
        <span>EVREN JEOFİZİK</span>
        <h1>Yönetici Girişi</h1>
        <p>Ziyaret ve izinli konum kayıtları için güvenli yönetim alanı.</p>
      </div>

      {storageConfigured === false ? (
        <div className="admin-alert error">
          <Database size={18} />
          <span><strong>Kayıt alanı bağlı değil</strong>Vercel Private Blob bağlantısı tamamlandığında giriş etkinleşecek.</span>
        </div>
      ) : null}

      <form className="admin-login-form" onSubmit={submit}>
        <label htmlFor="admin-password">Yönetici parolası</label>
        <div className="admin-password-field">
          <KeyRound size={18} />
          <input
            id="admin-password"
            type={visible ? 'text' : 'password'}
            value={password}
            onChange={(event) => setPassword(event.target.value)}
            autoComplete="current-password"
            autoFocus
            placeholder="Parolanızı girin"
            disabled={loading || storageConfigured === false}
          />
          <button type="button" onClick={() => setVisible((value) => !value)} aria-label={visible ? 'Parolayı gizle' : 'Parolayı göster'}>
            {visible ? <EyeOff size={17} /> : <Eye size={17} />}
          </button>
        </div>
        {error ? <p className="admin-form-error" role="alert">{error}</p> : null}
        <button className="admin-primary-button" type="submit" disabled={!password || loading || storageConfigured === false}>
          {loading ? <RefreshCw className="is-spinning" size={18} /> : <ShieldCheck size={18} />}
          {loading ? 'Doğrulanıyor…' : 'Güvenli Giriş'}
        </button>
      </form>

      <div className="admin-login-note">
        <ShieldCheck size={15} />
        <span>Oturum 8 saat sonra otomatik kapanır. Beş hatalı deneme 15 dakika kilit uygular.</span>
      </div>
    </div>
  )
}

function StatCard({ icon, label, value, tone }: { icon: React.ReactNode; label: string; value: number; tone: string }) {
  return (
    <article className={`admin-stat-card ${tone}`}>
      <span>{icon}</span>
      <div><small>{label}</small><strong>{value}</strong></div>
    </article>
  )
}

function VisitTable({
  visits,
  selectable = false,
  selectedIds = new Set<string>(),
  onToggle,
  onToggleAll,
  onShowOnMap,
}: {
  visits: Visit[]
  selectable?: boolean
  selectedIds?: Set<string>
  onToggle?: (id: string) => void
  onToggleAll?: () => void
  onShowOnMap?: (visit: Visit) => void
}) {
  if (!visits.length) return <div className="admin-empty"><List size={30} /><strong>Henüz ziyaret kaydı yok</strong><span>İlk ziyaret geldiğinde burada görünecek.</span></div>
  const allSelected = selectable && visits.every((visit) => selectedIds.has(visit.id))

  return (
    <div className="admin-table-wrap">
      <table className={`admin-visit-table${selectable ? ' is-selectable' : ''}`}>
        <thead>
          <tr>
            {selectable ? (
              <th className="admin-select-column">
                <button type="button" className="admin-check-button" onClick={onToggleAll} aria-label={allSelected ? 'Tüm seçimleri kaldır' : 'Tümünü seç'}>
                  {allSelected ? <CheckSquare size={16} /> : <Square size={16} />}
                </button>
              </th>
            ) : null}
            <th>Zaman</th><th>Konum</th><th>IP</th><th>Cihaz</th><th>GPS</th><th>Süre</th><th>Ziyaret</th>
          </tr>
        </thead>
        <tbody>
          {visits.map((visit) => {
            const selected = selectedIds.has(visit.id)
            return (
              <tr key={visit.id} className={selected ? 'is-selected' : ''}>
                {selectable ? (
                  <td className="admin-select-column">
                    <button type="button" className="admin-check-button" onClick={() => onToggle?.(visit.id)} aria-label={selected ? 'Seçimi kaldır' : 'Ziyareti seç'}>
                      {selected ? <CheckSquare size={16} /> : <Square size={16} />}
                    </button>
                  </td>
                ) : null}
                <td><strong>{formatDate(visit.startedAt)}</strong><small>{visit.page || '/'}</small></td>
                <td><strong>{locationName(visit)}</strong><small>{visit.timezone || 'Saat dilimi yok'}</small></td>
                <td><code>{visit.ip || '—'}</code></td>
                <td><strong>{deviceName(visit.userAgent)}</strong><small>{visit.language || 'Dil yok'}</small></td>
                <td>
                  {visit.gps ? (
                    <div className="admin-gps-cell">
                      <span className="admin-badge success">İzinli · ±{Math.round(visit.gps.accuracy)} m</span>
                      <button type="button" className="admin-map-link" onClick={() => onShowOnMap?.(visit)}>
                        <Navigation size={12} /> Haritada Göster
                      </button>
                    </div>
                  ) : <span className="admin-badge muted">Alınmadı</span>}
                </td>
                <td>{formatDuration(visit.durationSeconds)}</td>
                <td><span className="admin-badge info">{visit.visitorVisitCount || 1} kez</span></td>
              </tr>
            )
          })}
        </tbody>
      </table>
    </div>
  )
}

function MapFocus({ target }: { target: [number, number] | null }) {
  const map = useMap()
  useEffect(() => {
    if (!target) return
    map.flyTo(target, 16, { duration: 0.65 })
    window.setTimeout(() => map.invalidateSize(), 50)
  }, [map, target])
  return null
}

function VisitorMap({ visits, focusedVisitId }: { visits: Visit[]; focusedVisitId: string | null }) {
  const mapped = visits.flatMap((visit) => {
    const latitude = visit.gps?.latitude ?? visit.approximateLocation?.latitude
    const longitude = visit.gps?.longitude ?? visit.approximateLocation?.longitude
    return typeof latitude === 'number' && typeof longitude === 'number'
      ? [{ visit, latitude, longitude, exact: Boolean(visit.gps) }]
      : []
  })
  const focused = focusedVisitId ? mapped.find((item) => item.visit.id === focusedVisitId) : undefined
  const center: [number, number] = focused
    ? [focused.latitude, focused.longitude]
    : mapped.length ? [mapped[0].latitude, mapped[0].longitude] : [39.2, 35.2]
  const focusTarget: [number, number] | null = focused ? [focused.latitude, focused.longitude] : null

  return (
    <div className="admin-map-card">
      <div className="admin-card-heading">
        <div><MapIcon size={18} /><span><strong>Ziyaretçi Haritası</strong><small>{focused ? 'Seçtiğiniz izinli GPS konumuna odaklanıldı.' : 'GPS izni verilen konumlar yeşil, IP yaklaşık konumları mavi.'}</small></span></div>
        <b>{mapped.length} konum</b>
      </div>
      {mapped.length ? (
        <MapContainer center={center} zoom={focused ? 16 : mapped.length === 1 ? 10 : 5} className="admin-visitor-map" zoomControl>
          <TileLayer url="https://{s}.basemaps.cartocdn.com/rastertiles/voyager/{z}/{x}/{y}{r}.png" attribution="© OpenStreetMap © CARTO" />
          <MapFocus target={focusTarget} />
          {mapped.map(({ visit, latitude, longitude, exact }) => {
            const highlighted = visit.id === focusedVisitId
            return (
              <CircleMarker
                key={visit.id}
                center={[latitude, longitude]}
                radius={highlighted ? 11 : exact ? 8 : 6}
                pathOptions={{ color: '#ffffff', weight: highlighted ? 4 : 2, fillColor: exact ? '#10b981' : '#2583dd', fillOpacity: 0.9 }}
              >
                <Popup>
                  <div className="admin-map-popup"><strong>{locationName(visit)}</strong><span>{formatDate(visit.startedAt)}</span><code>{visit.ip}</code><small>{exact ? `İzinli GPS · ±${Math.round(visit.gps!.accuracy)} m` : 'IP tabanlı yaklaşık konum'}</small></div>
                </Popup>
              </CircleMarker>
            )
          })}
        </MapContainer>
      ) : <div className="admin-empty map"><MapPin size={30} /><strong>Haritada gösterilecek konum yok</strong><span>Vercel yaklaşık konum başlıkları veya izinli GPS kaydı geldiğinde noktalar oluşur.</span></div>}
    </div>
  )
}

function PasswordSettings() {
  const [currentPassword, setCurrentPassword] = useState('')
  const [newPassword, setNewPassword] = useState('')
  const [confirmation, setConfirmation] = useState('')
  const [loading, setLoading] = useState(false)
  const [message, setMessage] = useState<{ tone: 'success' | 'error'; text: string } | null>(null)

  const submit = async (event: FormEvent) => {
    event.preventDefault()
    if (newPassword !== confirmation) return setMessage({ tone: 'error', text: 'Yeni parola tekrarları aynı değil.' })
    if (newPassword.length < 14) return setMessage({ tone: 'error', text: 'Yeni parola en az 14 karakter olmalı.' })
    setLoading(true)
    setMessage(null)
    try {
      await api('/api/admin/password', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ currentPassword, newPassword }),
      })
      setCurrentPassword('')
      setNewPassword('')
      setConfirmation('')
      setMessage({ tone: 'success', text: 'Yönetici parolası güvenli biçimde değiştirildi.' })
    } catch (error) {
      const text = error instanceof ApiError && error.code === 'INVALID_CURRENT_PASSWORD'
        ? 'Mevcut parola doğru değil.'
        : error instanceof Error ? error.message : 'Parola değiştirilemedi.'
      setMessage({ tone: 'error', text })
    } finally {
      setLoading(false)
    }
  }

  return (
    <div className="admin-settings-grid">
      <section className="admin-settings-card">
        <div className="admin-card-heading"><div><KeyRound size={18} /><span><strong>Parola Değiştir</strong><small>En az 14 karakter kullanın.</small></span></div></div>
        <form className="admin-settings-form" onSubmit={submit}>
          <label>Mevcut parola<input type="password" autoComplete="current-password" value={currentPassword} onChange={(event) => setCurrentPassword(event.target.value)} /></label>
          <label>Yeni parola<input type="password" autoComplete="new-password" value={newPassword} onChange={(event) => setNewPassword(event.target.value)} /></label>
          <label>Yeni parola tekrar<input type="password" autoComplete="new-password" value={confirmation} onChange={(event) => setConfirmation(event.target.value)} /></label>
          {message ? <p className={`admin-settings-message ${message.tone}`}>{message.text}</p> : null}
          <button className="admin-primary-button" type="submit" disabled={loading || !currentPassword || !newPassword || !confirmation}>{loading ? 'Kaydediliyor…' : 'Parolayı Değiştir'}</button>
        </form>
      </section>
      <section className="admin-settings-card">
        <div className="admin-card-heading"><div><Database size={18} /><span><strong>Veri Güvenliği</strong><small>Yalnızca GitHub + Vercel altyapısı.</small></span></div></div>
        <ul className="admin-security-list">
          <li><ShieldCheck size={17} /><span><strong>Özel kayıt alanı</strong>Veriler herkese açık dosya olarak yayınlanmaz.</span></li>
          <li><MapPin size={17} /><span><strong>İzinli GPS</strong>GPS yalnız kullanıcı Konumum düğmesine basıp izin verdiğinde eklenir.</span></li>
          <li><KeyRound size={17} /><span><strong>Sunucu doğrulaması</strong>Parolanın kendisi kaynak kodunda veya tarayıcıda tutulmaz.</span></li>
        </ul>
      </section>
    </div>
  )
}

function DeleteConfirmation({ prompt, loading, onCancel, onConfirm }: {
  prompt: Exclude<DeletePrompt, null>
  loading: boolean
  onCancel: () => void
  onConfirm: () => void
}) {
  const all = prompt.mode === 'all'
  return (
    <div className="admin-confirm-overlay" role="presentation">
      <div className="admin-confirm-card" role="alertdialog" aria-modal="true" aria-labelledby="delete-title">
        <span className="admin-confirm-icon"><AlertTriangle size={26} /></span>
        <div>
          <h2 id="delete-title">{all ? 'Tüm ziyaret kayıtları silinsin mi?' : `${prompt.count} ziyaret kaydı silinsin mi?`}</h2>
          <p>{all ? 'Bu işlem eski ve yeni format dahil tüm ziyaret loglarını kalıcı olarak siler.' : 'Seçilen ziyaret kayıtları kalıcı olarak silinecek. Bu işlem geri alınamaz.'}</p>
        </div>
        <div className="admin-confirm-actions">
          <button type="button" className="admin-cancel-button" onClick={onCancel} disabled={loading}>Vazgeç</button>
          <button type="button" className="admin-danger-button" onClick={onConfirm} disabled={loading}>
            {loading ? <RefreshCw className="is-spinning" size={16} /> : <Trash2 size={16} />}
            {loading ? 'Siliniyor…' : all ? 'Evet, Tümünü Sil' : 'Seçilenleri Sil'}
          </button>
        </div>
      </div>
    </div>
  )
}

export default function AdminPortal({ onClose }: AdminPortalProps) {
  const [checking, setChecking] = useState(true)
  const [authenticated, setAuthenticated] = useState(false)
  const [storageConfigured, setStorageConfigured] = useState<boolean | null>(null)
  const [loginLoading, setLoginLoading] = useState(false)
  const [loginError, setLoginError] = useState('')
  const [visits, setVisits] = useState<Visit[]>([])
  const [visitsLoading, setVisitsLoading] = useState(false)
  const [visitsError, setVisitsError] = useState('')
  const [days, setDays] = useState(90)
  const [tab, setTab] = useState<TabId>('overview')
  const [selectedIds, setSelectedIds] = useState<Set<string>>(() => new Set())
  const [focusedVisitId, setFocusedVisitId] = useState<string | null>(null)
  const [deletePrompt, setDeletePrompt] = useState<DeletePrompt>(null)
  const [deleteLoading, setDeleteLoading] = useState(false)

  const loadVisits = useCallback(async (period: number) => {
    setVisitsLoading(true)
    setVisitsError('')
    try {
      const payload = await api<{ visits: Visit[] }>(`/api/admin/visits?days=${period}`)
      const nextVisits = Array.isArray(payload.visits) ? payload.visits : []
      setVisits(nextVisits)
      setSelectedIds((current) => {
        const available = new Set(nextVisits.map((visit) => visit.id))
        return new Set(Array.from(current).filter((id) => available.has(id)))
      })
    } catch (error) {
      if (error instanceof ApiError && error.status === 401) setAuthenticated(false)
      else setVisitsError(error instanceof Error ? error.message : 'Ziyaret kayıtları alınamadı.')
    } finally {
      setVisitsLoading(false)
    }
  }, [])

  useEffect(() => {
    let mounted = true
    api<{ authenticated: boolean; storageConfigured: boolean }>('/api/admin/session')
      .then((payload) => {
        if (!mounted) return
        setAuthenticated(Boolean(payload.authenticated))
        setStorageConfigured(Boolean(payload.storageConfigured))
        if (payload.authenticated) void loadVisits(90)
      })
      .catch(() => {
        if (!mounted) return
        setStorageConfigured(null)
        setLoginError('Yönetici servisine ulaşılamadı. Bağlantıyı kontrol edin.')
      })
      .finally(() => { if (mounted) setChecking(false) })
    return () => { mounted = false }
  }, [loadVisits])

  useEffect(() => {
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return
      if (deletePrompt) setDeletePrompt(null)
      else onClose()
    }
    window.addEventListener('keydown', closeOnEscape)
    return () => window.removeEventListener('keydown', closeOnEscape)
  }, [deletePrompt, onClose])

  const login = async (password: string) => {
    setLoginLoading(true)
    setLoginError('')
    try {
      await api('/api/admin/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ password }),
      })
      setAuthenticated(true)
      await loadVisits(days)
    } catch (error) {
      if (error instanceof ApiError && error.code === 'INVALID_PASSWORD') {
        const remaining = Number(error.payload.attemptsRemaining)
        setLoginError(`Parola doğru değil.${Number.isFinite(remaining) ? ` Kalan deneme: ${remaining}` : ''}`)
      } else if (error instanceof ApiError && error.code === 'TOO_MANY_ATTEMPTS') {
        setLoginError('Çok fazla hatalı deneme yapıldı. 15 dakika sonra tekrar deneyin.')
      } else setLoginError(error instanceof Error ? error.message : 'Giriş yapılamadı.')
    } finally {
      setLoginLoading(false)
    }
  }

  const logout = async () => {
    await api('/api/admin/logout', { method: 'POST' }).catch(() => undefined)
    setAuthenticated(false)
    setVisits([])
    setSelectedIds(new Set())
    setFocusedVisitId(null)
    setTab('overview')
  }

  const toggleVisit = (id: string) => {
    setSelectedIds((current) => {
      const next = new Set(current)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }

  const toggleAllVisits = () => {
    setSelectedIds((current) => {
      const allVisibleSelected = visits.length > 0 && visits.every((visit) => current.has(visit.id))
      return allVisibleSelected ? new Set() : new Set(visits.map((visit) => visit.id))
    })
  }

  const showOnMap = (visit: Visit) => {
    if (!visit.gps) return
    setFocusedVisitId(visit.id)
    setTab('map')
  }

  const confirmDelete = async () => {
    if (!deletePrompt || deleteLoading) return
    setDeleteLoading(true)
    setVisitsError('')
    try {
      await api('/api/admin/visits/delete', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(deletePrompt.mode === 'all'
          ? { all: true }
          : { ids: Array.from(selectedIds) }),
      })
      setDeletePrompt(null)
      setSelectedIds(new Set())
      setFocusedVisitId(null)
      await loadVisits(days)
    } catch (error) {
      if (error instanceof ApiError && error.status === 401) setAuthenticated(false)
      else setVisitsError(error instanceof Error ? error.message : 'Ziyaret kayıtları silinemedi.')
      setDeletePrompt(null)
    } finally {
      setDeleteLoading(false)
    }
  }

  const stats = useMemo(() => {
    const now = Date.now()
    const sevenDays = now - 7 * 24 * 60 * 60 * 1000
    const thirtyDays = now - 30 * 24 * 60 * 60 * 1000
    return {
      today: visits.filter((visit) => isToday(visit.startedAt)).length,
      week: visits.filter((visit) => new Date(visit.startedAt).getTime() >= sevenDays).length,
      month: visits.filter((visit) => new Date(visit.startedAt).getTime() >= thirtyDays).length,
      active: visits.filter((visit) => !visit.endedAt && now - new Date(visit.lastSeenAt).getTime() <= 6 * 60 * 1000).length,
    }
  }, [visits])

  const recentVisits = visits.slice(0, 12)
  const tabs: Array<{ id: TabId; label: string; icon: React.ReactNode }> = [
    { id: 'overview', label: 'Özet', icon: <LayoutDashboard size={18} /> },
    { id: 'visits', label: 'Ziyaretler', icon: <List size={18} /> },
    { id: 'map', label: 'Harita', icon: <MapIcon size={18} /> },
    { id: 'settings', label: 'Ayarlar', icon: <Settings size={18} /> },
  ]

  return (
    <div className="admin-portal" role="dialog" aria-modal="true" aria-label="Yönetici paneli">
      <button type="button" className="admin-close" onClick={onClose} aria-label="Yönetici panelini kapat"><X size={21} /></button>
      {checking ? (
        <div className="admin-loading"><RefreshCw className="is-spinning" size={32} /><strong>Güvenli oturum kontrol ediliyor…</strong></div>
      ) : !authenticated ? (
        <LoginView storageConfigured={storageConfigured} loading={loginLoading} error={loginError} onLogin={login} />
      ) : (
        <div className="admin-dashboard">
          <aside className="admin-sidebar">
            <div className="admin-sidebar-brand"><span><ShieldCheck size={23} /></span><div><strong>EVREN JEOFİZİK</strong><small>YÖNETİM MERKEZİ</small></div></div>
            <nav aria-label="Yönetici bölümleri">
              {tabs.map((item) => <button type="button" key={item.id} className={tab === item.id ? 'is-active' : ''} onClick={() => setTab(item.id)}>{item.icon}<span>{item.label}</span></button>)}
            </nav>
            <button type="button" className="admin-logout" onClick={logout}><LogOut size={18} /><span>Güvenli Çıkış</span></button>
          </aside>

          <section className="admin-main">
            <header className="admin-main-header">
              <div><small>YÖNETİCİ PANELİ</small><h1>{tabs.find((item) => item.id === tab)?.label}</h1></div>
              <div className="admin-header-actions">
                <select value={days} onChange={(event) => { const period = Number(event.target.value); setDays(period); void loadVisits(period) }} aria-label="Kayıt dönemi">
                  <option value={7}>Son 7 gün</option><option value={30}>Son 30 gün</option><option value={90}>Son 90 gün</option><option value={180}>Son 180 gün</option>
                </select>
                <button type="button" onClick={() => void loadVisits(days)} disabled={visitsLoading} aria-label="Kayıtları yenile"><RefreshCw className={visitsLoading ? 'is-spinning' : ''} size={18} /></button>
              </div>
            </header>

            <div className="admin-content">
              {visitsError ? <div className="admin-alert error"><Database size={18} /><span><strong>İşlem tamamlanamadı</strong>{visitsError}</span></div> : null}
              {tab === 'overview' ? (
                <>
                  <div className="admin-stats-grid">
                    <StatCard icon={<Users size={21} />} label="Bugün" value={stats.today} tone="cyan" />
                    <StatCard icon={<List size={21} />} label="Bu hafta" value={stats.week} tone="violet" />
                    <StatCard icon={<Clock size={21} />} label="Son 30 gün" value={stats.month} tone="amber" />
                    <StatCard icon={<MapPin size={21} />} label="Şu an aktif" value={stats.active} tone="green" />
                  </div>
                  <section className="admin-data-card">
                    <div className="admin-card-heading"><div><List size={18} /><span><strong>Son Ziyaretler</strong><small>En yeni 12 kayıt</small></span></div><button type="button" onClick={() => setTab('visits')}>Tümünü Gör</button></div>
                    <VisitTable visits={recentVisits} onShowOnMap={showOnMap} />
                  </section>
                </>
              ) : null}
              {tab === 'visits' ? (
                <section className="admin-data-card">
                  <div className="admin-card-heading"><div><Users size={18} /><span><strong>Ziyaret Kayıtları</strong><small>Seçilen dönemde {visits.length} kayıt</small></span></div></div>
                  <div className="admin-selection-toolbar">
                    <div>
                      <CheckSquare size={17} />
                      <span><strong>{selectedIds.size}</strong> kayıt seçili</span>
                    </div>
                    <div className="admin-selection-actions">
                      <button type="button" className="admin-delete-selected" disabled={!selectedIds.size || deleteLoading} onClick={() => setDeletePrompt({ mode: 'selected', count: selectedIds.size })}>
                        <Trash2 size={14} /> Seçilenleri Sil
                      </button>
                      <button type="button" className="admin-delete-all" disabled={!visits.length || deleteLoading} onClick={() => setDeletePrompt({ mode: 'all', count: visits.length })}>
                        <Trash2 size={14} /> Tüm Ziyaretleri Sil
                      </button>
                    </div>
                  </div>
                  <VisitTable visits={visits} selectable selectedIds={selectedIds} onToggle={toggleVisit} onToggleAll={toggleAllVisits} onShowOnMap={showOnMap} />
                </section>
              ) : null}
              {tab === 'map' ? <VisitorMap visits={visits} focusedVisitId={focusedVisitId} /> : null}
              {tab === 'settings' ? <PasswordSettings /> : null}
            </div>
          </section>
        </div>
      )}
      {deletePrompt ? <DeleteConfirmation prompt={deletePrompt} loading={deleteLoading} onCancel={() => setDeletePrompt(null)} onConfirm={() => void confirmDelete()} /> : null}
    </div>
  )
}
