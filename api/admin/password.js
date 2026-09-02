import { changeAdminPassword, hasAdminSession, verifyAdminPassword } from '../_lib/admin-auth.js'
import { allowMethods, isSameOrigin, readBody, sendJson } from '../_lib/http.js'
import { storageErrorPayload } from '../_lib/storage.js'

export default async function handler(req, res) {
  if (!allowMethods(req, res, ['POST'])) return
  if (!isSameOrigin(req)) return sendJson(res, 403, { ok: false, error: 'ORIGIN_REJECTED' })
  if (!await hasAdminSession(req)) return sendJson(res, 401, { ok: false, error: 'UNAUTHORIZED' })
  const body = readBody(req)
  const currentPassword = String(body?.currentPassword || '')
  const newPassword = String(body?.newPassword || '')
  if (newPassword.length < 14 || newPassword.length > 256) {
    return sendJson(res, 400, { ok: false, error: 'WEAK_PASSWORD' })
  }
  try {
    if (!await verifyAdminPassword(currentPassword)) {
      return sendJson(res, 401, { ok: false, error: 'INVALID_CURRENT_PASSWORD' })
    }
    const updatedAt = await changeAdminPassword(newPassword)
    sendJson(res, 200, { ok: true, updatedAt })
  } catch (error) {
    const failure = storageErrorPayload(error)
    sendJson(res, failure.status, failure.payload)
  }
}
