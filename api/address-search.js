export default async function handler(req, res) {
  const query = String(req.query?.q || '').trim()
  if (query.length < 3) {
    res.status(200).json({ features: [] })
    return
  }

  const params = new URLSearchParams({
    q: query,
    limit: String(Math.min(8, Math.max(1, Number(req.query?.limit) || 8))),
  })

  const lat = Number(req.query?.lat)
  const lon = Number(req.query?.lon)
  const zoom = Number(req.query?.zoom)
  if (Number.isFinite(lat) && Number.isFinite(lon)) {
    params.set('lat', String(lat))
    params.set('lon', String(lon))
  }
  if (Number.isFinite(zoom)) params.set('zoom', String(Math.max(1, Math.min(18, Math.round(zoom)))))

  try {
    const upstream = await fetch(`https://photon.komoot.io/api/?${params.toString()}`, {
      headers: {
        Accept: 'application/json',
        'User-Agent': 'Evren-Jeofizik-GIS/1.0',
      },
    })

    if (!upstream.ok) {
      res.status(502).json({ features: [], error: `Photon ${upstream.status}` })
      return
    }

    const payload = await upstream.json()
    res.setHeader('Cache-Control', 's-maxage=60, stale-while-revalidate=300')
    res.status(200).json(payload)
  } catch {
    res.status(502).json({ features: [], error: 'Arama hizmetine ulaşılamadı.' })
  }
}
