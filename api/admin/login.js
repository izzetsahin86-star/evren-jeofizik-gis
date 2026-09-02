import { clearLoginFailures, createAdminSession, loginRateStatus, MAX_LOGIN_ATTEMPTS, recordLoginFailure, setAdminCookie, verifyAdminPassword } from '../_lib/admin-auth.js'
import { allowMethods, isSameOrigin, readBody, sendJson } from '../_lib/http.js'
import { storageErrorPayload } from '../_lib/storage.js'

export default async function handler(req, res) {
  if (!allowMethods(req, res, ['POST'])) return
  if (!isSameOrigin(req)) return sendJson(res, 403, { ok: false, error: 'ORIGIN_REJECTED' })
  try {
    const rate = await loginRateStatus(req)
    if (rate.blocked) {
      res.setHeader('Retry-After', String(rate.retryAfter))
      return sendJson(res, 429, { ok: false, error: 'TOO_MANY_ATTEMPTS', retryAfter: rate.retryAfter })
    }

    const password = String(readBody(req)?.password || '')
    if (!await verifyAdminPassword(password)) {
      const failure = await recordLoginFailure(req, rate)
      return sendJson(res, 401, {
        ok: false,
        error: 'INVALID_PASSWORD',
        attemptsRemaining: Math.max(0, MAX_LOGIN_ATTEMPTS - failure.attempts),
      })
    }

    const session = await createAdminSession()
    await clearLoginFailures(req)
    setAdminCookie(req, res, session)
    sendJson(res, 200, { ok: true })
  } catch (error) {
    const failure = storageErrorPayload(error)
    sendJson(res, failure.status, failure.payload)
  }
}
