import { hasAdminSession } from '../_lib/admin-auth.js'
import { AccessConfigValidationError, readAdminAccessConfig, saveAdminAccessConfig } from '../_lib/access-config.js'
import { allowMethods, isSameOrigin, readBody, sendJson } from '../_lib/http.js'
import { storageErrorPayload } from '../_lib/storage.js'

export default async function handler(req, res) {
  if (!allowMethods(req, res, ['GET', 'POST'])) return
  if (!isSameOrigin(req)) return sendJson(res, 403, { ok: false, error: 'ORIGIN_REJECTED' })
  if (!await hasAdminSession(req)) return sendJson(res, 401, { ok: false, error: 'UNAUTHORIZED' })

  try {
    if (req.method === 'GET') {
      const config = await readAdminAccessConfig()
      return sendJson(res, 200, { ok: true, config })
    }

    const body = readBody(req)
    const config = await saveAdminAccessConfig(body?.targets)
    return sendJson(res, 200, { ok: true, config })
  } catch (error) {
    if (error instanceof AccessConfigValidationError) {
      return sendJson(res, 400, { ok: false, error: 'INVALID_ACCESS_COORDINATES', message: error.message })
    }
    const failure = storageErrorPayload(error)
    return sendJson(res, failure.status, failure.payload)
  }
}
