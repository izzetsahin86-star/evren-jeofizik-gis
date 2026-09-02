import { useEffect, useState } from 'react'
import { Clock, MapPin, Navigation, X } from 'lucide-react'

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

type LocationHistoryItem = {
  visitId: string
  startedAt: string
  lastSeenAt?: string
  endedAt?: string | null
  durationSeconds?: number
  ip?: string
  page?: string
  approximateLocation?: LocationInfo | null
  gps?: GpsInfo | null
}

type DeviceVisit = {
  id: string
  visitorId: string
  startedAt: string
  userAgent?: string
  visitorVisitCount?: number
  locationHistory?: LocationHistoryItem[]
}

function formatDate(value?: string) {
  if (!value) return '—'
  const date = new Date(value)
  if (!Number.isFinite(date.getTime())) return '—'
  return new Intl.DateTimeFormat('tr-TR', { dateStyle: 'short', timeStyle: 'medium' }).format(date)
}

function formatDuration(seconds?: number) {
  const safe = Math.max(0, Math.round(Number(seconds) || 0))
  if (safe < 60) return `${safe} sn`
  if (safe < 3600) return `${Math.floor(safe / 60)} dk ${safe % 60} sn`
  return `${Math.floor(safe / 3600)} sa ${Math.floor((safe % 3600) / 60)} dk`
}

function locationName(location?: LocationInfo | null) {
  const values = [location?.city, location?.region, location?.country]
    .filter((value, index, array) => value && array.indexOf(value) === index)
  return values.length ? values.join(' / ') : 'Konum bilinmiyor'
}

function deviceName(userAgent = '') {
  if (/iPhone/i.test(userAgent)) return 'iPhone'
  if (/iPad/i.test(userAgent)) return 'iPad'
  if (/Android/i.test(userAgent)) return 'Android'
  if (/Windows/i.test(userAgent)) return 'Windows'
  if (/Mac OS X/i.test(userAgent)) return 'macOS'
  if (/Linux/i.test(userAgent)) return 'Linux'
  return 'Bilinmeyen cihaz'
}

async function loadGroupedVisits(days: number) {
  const response = await fetch(`/api/admin/visits?days=${days}`, {
    credentials: 'same-origin',
    cache: 'no-store',
  })
  if (!response.ok) return []
  const payload = await response.json().catch(() => ({})) as { visits?: DeviceVisit[] }
  return Array.isArray(payload.visits) ? payload.visits : []
}

export default function AdminDeviceHistoryFeature() {
  const [active, setActive] = useState(false)
  const [days, setDays] = useState(90)
  const [visits, setVisits] = useState<DeviceVisit[]>([])
  const [selected, setSelected] = useState<DeviceVisit | null>(null)

  useEffect(() => {
    const sync = () => {
      const heading = document.querySelector<HTMLElement>('.admin-main-header h1')?.textContent?.trim()
      const period = Number(document.querySelector<HTMLSelectElement>('.admin-header-actions select')?.value || 90)
      setActive(heading === 'Ziyaretler')
      if (Number.isFinite(period)) setDays(period)
    }
    sync()
    const timer = window.setInterval(sync, 500)
    return () => window.clearInterval(timer)
  }, [])

  useEffect(() => {
    if (!active) return
    let cancelled = false
    const refresh = () => {
      void loadGroupedVisits(days).then((next) => {
        if (!cancelled) setVisits(next)
      }).catch(() => undefined)
    }
    refresh()
    const timer = window.setInterval(refresh, 15_000)
    return () => {
      cancelled = true
      window.clearInterval(timer)
    }
  }, [active, days])

  useEffect(() => {
    if (!active || !visits.length) return

    const decorate = () => {
      const rows = Array.from(document.querySelectorAll<HTMLTableRowElement>('.admin-visit-table.is-selectable tbody tr'))
      rows.forEach((row, index) => {
        if (row.querySelector('.admin-device-history-link')) return
        const visit = visits[index]
        if (!visit) return
        const cells = row.querySelectorAll<HTMLTableCellElement>('td')
        const locationCell = cells[2]
        if (!locationCell) return

        const button = document.createElement('button')
        button.type = 'button'
        button.className = 'admin-device-history-link'
        const count = visit.locationHistory?.length || visit.visitorVisitCount || 1
        button.textContent = `Konum Geçmişi · ${count}`
        button.onclick = () => setSelected(visit)
        locationCell.appendChild(button)
      })
    }

    decorate()
    const timer = window.setInterval(decorate, 650)
    return () => {
      window.clearInterval(timer)
      document.querySelectorAll('.admin-device-history-link').forEach((element) => element.remove())
    }
  }, [active, visits])

  if (!selected) {
    return <style>{`
      .admin-device-history-link{margin-top:5px;min-height:24px;display:inline-flex;align-items:center;padding:0 8px;border:1px solid #c8dff1;border-radius:8px;background:#f4faff;color:#2273aa;font:800 7.5px/1 Inter,system-ui,sans-serif;cursor:pointer;white-space:nowrap}
      .admin-device-history-link:hover{background:#eaf6ff}
    `}</style>
  }

  const history = Array.isArray(selected.locationHistory) ? selected.locationHistory : []

  return (
    <>
      <style>{`
        .admin-device-history-link{margin-top:5px;min-height:24px;display:inline-flex;align-items:center;padding:0 8px;border:1px solid #c8dff1;border-radius:8px;background:#f4faff;color:#2273aa;font:800 7.5px/1 Inter,system-ui,sans-serif;cursor:pointer;white-space:nowrap}.admin-device-history-link:hover{background:#eaf6ff}
        .admin-history-overlay{position:fixed;inset:0;z-index:5600;display:grid;place-items:center;padding:18px;background:rgba(5,13,25,.6);backdrop-filter:blur(8px)}
        .admin-history-card{width:min(720px,calc(100vw - 28px));max-height:min(82vh,760px);display:grid;grid-template-rows:auto minmax(0,1fr);overflow:hidden;border:1px solid rgba(255,255,255,.72);border-radius:22px;background:#fff;box-shadow:0 30px 90px rgba(2,8,23,.38);font-family:Inter,system-ui,sans-serif}
        .admin-history-head{display:flex;align-items:center;justify-content:space-between;gap:14px;padding:17px 18px;border-bottom:1px solid #e7edf2;background:linear-gradient(180deg,#fff,#f8fbfd)}
        .admin-history-title{display:flex;align-items:center;gap:11px;min-width:0}.admin-history-title>span{width:38px;height:38px;display:grid;place-items:center;border-radius:12px;background:#eaf6ff;color:#2479b2}.admin-history-title div{min-width:0}.admin-history-title strong,.admin-history-title small{display:block}.admin-history-title strong{color:#243246;font-size:14px}.admin-history-title small{margin-top:3px;color:#78879a;font-size:8.5px}
        .admin-history-close{width:34px;height:34px;display:grid;place-items:center;border:1px solid #dce5ec;border-radius:10px;background:#fff;color:#67778a;cursor:pointer}
        .admin-history-list{overflow:auto;padding:12px;background:#f5f8fb}
        .admin-history-item{display:grid;grid-template-columns:minmax(0,1.4fr) minmax(0,1fr) auto;gap:12px;align-items:center;padding:12px 13px;border:1px solid #e0e8ef;border-radius:14px;background:#fff;box-shadow:0 4px 14px rgba(31,52,73,.04)}.admin-history-item+.admin-history-item{margin-top:8px}
        .admin-history-main,.admin-history-location{min-width:0}.admin-history-main strong,.admin-history-main small,.admin-history-location strong,.admin-history-location small{display:block;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.admin-history-main strong{color:#2b394c;font-size:9.5px}.admin-history-main small,.admin-history-location small{margin-top:4px;color:#8694a5;font-size:7.5px}.admin-history-location strong{color:#40546a;font-size:8.5px}
        .admin-history-gps{display:grid;justify-items:end;gap:4px}.admin-history-gps span{display:inline-flex;align-items:center;gap:4px;padding:4px 7px;border-radius:999px;background:#eaf9f3;color:#087d57;font-size:7.5px;font-weight:850}.admin-history-gps code{color:#607286;font-size:7px}.admin-history-gps.is-approx span{background:#edf5fb;color:#3474a3}
        .admin-history-empty{padding:36px;text-align:center;color:#8290a1;font-size:10px}
        @media(max-width:680px){.admin-history-card{max-height:88vh}.admin-history-item{grid-template-columns:1fr}.admin-history-gps{justify-items:start}.admin-history-main strong,.admin-history-location strong{font-size:10px}}
      `}</style>
      <div className="admin-history-overlay" role="presentation" onClick={(event) => { if (event.target === event.currentTarget) setSelected(null) }}>
        <section className="admin-history-card" role="dialog" aria-modal="true" aria-label="Cihaz konum geçmişi">
          <header className="admin-history-head">
            <div className="admin-history-title">
              <span><Navigation size={19} /></span>
              <div><strong>Cihaz Konum Geçmişi</strong><small>{deviceName(selected.userAgent)} · {history.length || selected.visitorVisitCount || 1} giriş kaydı</small></div>
            </div>
            <button type="button" className="admin-history-close" onClick={() => setSelected(null)} aria-label="Konum geçmişini kapat"><X size={17} /></button>
          </header>
          <div className="admin-history-list">
            {history.length ? history.map((item) => {
              const approximate = item.approximateLocation
              const approxCoordinates = typeof approximate?.latitude === 'number' && typeof approximate?.longitude === 'number'
                ? `${approximate.latitude.toFixed(5)}, ${approximate.longitude.toFixed(5)}`
                : null
              return (
                <article className="admin-history-item" key={item.visitId}>
                  <div className="admin-history-main">
                    <strong><Clock size={12} /> {formatDate(item.startedAt)}</strong>
                    <small>{item.page || '/'} · {formatDuration(item.durationSeconds)} · IP {item.ip || '—'}</small>
                  </div>
                  <div className="admin-history-location">
                    <strong><MapPin size={11} /> {locationName(approximate)}</strong>
                    <small>{approxCoordinates || 'IP yaklaşık koordinatı yok'}</small>
                  </div>
                  {item.gps ? (
                    <div className="admin-history-gps">
                      <span><Navigation size={11} /> GPS izinli · ±{Math.round(item.gps.accuracy)} m</span>
                      <code>{item.gps.latitude.toFixed(6)}, {item.gps.longitude.toFixed(6)}</code>
                    </div>
                  ) : (
                    <div className="admin-history-gps is-approx"><span>GPS alınmadı</span></div>
                  )}
                </article>
              )
            }) : <div className="admin-history-empty">Bu cihaz için konum geçmişi bulunamadı.</div>}
          </div>
        </section>
      </div>
    </>
  )
}
