import { hasAdminSession } from '../../_lib/admin-auth.js'
import { allowMethods, isSameOrigin, readBody, sendJson } from '../../_lib/http.js'
import { storageErrorPayload } from '../../_lib/storage.js'
import { deleteAllVisits, deleteVisitsByIds } from '../../_lib/visits.js'

export default async function handler(req, res) {
  if (!allowMethods(req, res, ['POST'])) return
  if (!isSameOrigin(req)) return sendJson(res, 403, { ok: false, error: 'ORIGIN_REJECTED' })
  if (!await hasAdminSession(req)) return sendJson(res, 401, { ok: false, error: 'UNAUTHORIZED' })

  const body = readBody(req)
  try {
    if (body?.all === true) {
      const result = await deleteAllVisits()
      return sendJson(res, 200, { ok: true, mode: 'all', ...result })
    }
    const ids = Array.isArray(body?.ids) ? body.ids : []
    if (!ids.length) return sendJson(res, 400, { ok: false, error: 'NO_VISITS_SELECTED' })
    const result = await deleteVisitsByIds(ids)
    sendJson(res, 200, { ok: true, mode: 'selected', ...result })
  } catch (error) {
    const failure = storageErrorPayload(error)
    sendJson(res, failure.status, failure.payload)
  }
}
