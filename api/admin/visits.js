import { hasAdminSession } from '../_lib/admin-auth.js'
import { allowMethods, sendJson } from '../_lib/http.js'
import { storageErrorPayload } from '../_lib/storage.js'
import { listVisits } from '../_lib/visits.js'

export default async function handler(req, res) {
  if (!allowMethods(req, res, ['GET'])) return
  if (!await hasAdminSession(req)) return sendJson(res, 401, { ok: false, error: 'UNAUTHORIZED' })
  try {
    const visits = await listVisits(req.query?.days)
    sendJson(res, 200, { ok: true, visits, generatedAt: new Date().toISOString() })
  } catch (error) {
    const failure = storageErrorPayload(error)
    sendJson(res, failure.status, failure.payload)
  }
}
