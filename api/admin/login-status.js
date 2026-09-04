import { loginRateStatus, MAX_LOGIN_ATTEMPTS } from '../_lib/admin-auth.js'
import { allowMethods, isSameOrigin, sendJson } from '../_lib/http.js'
import { storageErrorPayload } from '../_lib/storage.js'

export default async function handler(req, res) {
  if (!allowMethods(req, res, ['GET'])) return
  if (!isSameOrigin(req)) return sendJson(res, 403, { ok: false, error: 'ORIGIN_REJECTED' })

  res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate')

  try {
    const status = await loginRateStatus(req)
    sendJson(res, 200, {
      ok: true,
      blocked: Boolean(status.blocked),
      attemptsRemaining: Math.max(0, MAX_LOGIN_ATTEMPTS - Number(status.attempts || 0)),
      retryAfter: status.blocked ? Math.max(1, Number(status.retryAfter || 0)) : 0,
    })
  } catch (error) {
    const failure = storageErrorPayload(error)
    sendJson(res, failure.status, failure.payload)
  }
}
