import { clearLoginFailures, createAdminSession, loginRateStatus, MAX_LOGIN_ATTEMPTS, recordLoginFailure, setAdminCookie, verifyAdminPassword } from '../_lib/admin-auth.js'
import { allowMethods, isSameOrigin, readBody, sendJson } from '../_lib/http.js'
import { storageErrorPayload } from '../_lib/storage.js'

const LOGIN_TIMEOUT_MS = 9_000

class AdminLoginTimeoutError extends Error {
  constructor(step) {
    super(`Yönetici giriş servisi zamanında yanıt vermedi: ${step}`)
    this.name = 'AdminLoginTimeoutError'
    this.step = step
  }
}

async function withinLoginDeadline(startedAt, step, operation) {
  const remaining = Math.max(250, LOGIN_TIMEOUT_MS - (Date.now() - startedAt))
  let timer
  try {
    return await Promise.race([
      Promise.resolve().then(operation),
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new AdminLoginTimeoutError(step)), remaining)
      }),
    ])
  } finally {
    if (timer) clearTimeout(timer)
  }
}

export default async function handler(req, res) {
  if (!allowMethods(req, res, ['POST'])) return
  if (!isSameOrigin(req)) return sendJson(res, 403, { ok: false, error: 'ORIGIN_REJECTED' })

  const startedAt = Date.now()
  try {
    const rate = await withinLoginDeadline(startedAt, 'rate-limit', () => loginRateStatus(req))
    if (rate.blocked) {
      res.setHeader('Retry-After', String(rate.retryAfter))
      return sendJson(res, 429, { ok: false, error: 'TOO_MANY_ATTEMPTS', retryAfter: rate.retryAfter })
    }

    const password = String(readBody(req)?.password || '')
    const validPassword = await withinLoginDeadline(startedAt, 'password', () => verifyAdminPassword(password))
    if (!validPassword) {
      const failure = await withinLoginDeadline(startedAt, 'failure-write', () => recordLoginFailure(req, rate))
      return sendJson(res, 401, {
        ok: false,
        error: 'INVALID_PASSWORD',
        attemptsRemaining: Math.max(0, MAX_LOGIN_ATTEMPTS - failure.attempts),
      })
    }

    const session = await withinLoginDeadline(startedAt, 'session-write', () => createAdminSession())
    setAdminCookie(req, res, session)
    sendJson(res, 200, { ok: true })

    // Başarılı giriş cevabını, başarısız-deneme kaydını silme işlemi yüzünden bekletme.
    void clearLoginFailures(req).catch((error) => {
      console.warn('Admin login failure counter cleanup could not complete.', error)
    })
  } catch (error) {
    if (error instanceof AdminLoginTimeoutError) {
      console.error('Admin login storage timeout', { step: error.step })
      return sendJson(res, 503, {
        ok: false,
        error: 'LOGIN_SERVICE_TIMEOUT',
        message: 'Yönetici giriş servisi zamanında yanıt vermedi. Lütfen tekrar deneyin.',
      })
    }
    const failure = storageErrorPayload(error)
    sendJson(res, failure.status, failure.payload)
  }
}
