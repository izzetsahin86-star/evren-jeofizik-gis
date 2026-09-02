import { allowMethods, isSameOrigin, readBody, sendJson } from '../_lib/http.js'
import { storageErrorPayload } from '../_lib/storage.js'
import { gpsUpdate, updateVisit } from '../_lib/visits.js'

export default async function handler(req, res) {
  if (!allowMethods(req, res, ['POST'])) return
  if (!isSameOrigin(req)) return sendJson(res, 403, { ok: false, error: 'ORIGIN_REJECTED' })
  const body = readBody(req)
  const gps = gpsUpdate(body)
  if (!gps) return sendJson(res, 400, { ok: false, error: 'INVALID_LOCATION' })
  try {
    const updated = await updateVisit(body, (visit) => ({
      ...visit,
      gps,
      lastSeenAt: gps.grantedAt,
    }))
    sendJson(res, updated ? 200 : 404, { ok: updated, error: updated ? undefined : 'VISIT_NOT_FOUND' })
  } catch (error) {
    const failure = storageErrorPayload(error)
    sendJson(res, failure.status, failure.payload)
  }
}
