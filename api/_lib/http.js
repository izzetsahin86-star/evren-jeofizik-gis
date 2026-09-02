export function sendJson(res, status, payload) {
  res.setHeader('Cache-Control', 'private, no-store, max-age=0')
  res.setHeader('Content-Type', 'application/json; charset=utf-8')
  res.setHeader('X-Content-Type-Options', 'nosniff')
  res.status(status).json(payload)
}

export function allowMethods(req, res, methods) {
  if (methods.includes(req.method)) return true
  res.setHeader('Allow', methods.join(', '))
  sendJson(res, 405, { ok: false, error: 'METHOD_NOT_ALLOWED' })
  return false
}

export function isSameOrigin(req) {
  const fetchSite = String(req.headers['sec-fetch-site'] || '').toLowerCase()
  if (fetchSite === 'cross-site') return false

  const origin = req.headers.origin
  if (!origin) return true
  const host = String(req.headers['x-forwarded-host'] || req.headers.host || '').split(',')[0].trim()
  try {
    return new URL(String(origin)).host === host
  } catch {
    return false
  }
}

export function readBody(req) {
  if (!req.body) return {}
  if (typeof req.body === 'object' && !Buffer.isBuffer(req.body)) return req.body
  try {
    return JSON.parse(Buffer.isBuffer(req.body) ? req.body.toString('utf8') : String(req.body))
  } catch {
    return {}
  }
}

export function clientIp(req) {
  const forwarded = String(req.headers['x-forwarded-for'] || '').split(',')[0].trim()
  return forwarded || String(req.headers['x-real-ip'] || req.socket?.remoteAddress || 'unknown')
}

export function limitedText(value, maximum = 240) {
  return typeof value === 'string' ? value.trim().slice(0, maximum) : ''
}

export function finiteNumber(value, minimum, maximum) {
  const number = Number(value)
  return Number.isFinite(number) && number >= minimum && number <= maximum ? number : null
}

export function decodeHeader(value) {
  const text = limitedText(value, 160)
  if (!text) return ''
  try {
    return decodeURIComponent(text)
  } catch {
    return text
  }
}
