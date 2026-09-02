import { allowMethods, isSameOrigin, readBody, sendJson } from '../_lib/http.js'
import { storageErrorPayload } from '../_lib/storage.js'
import { createVisit, VisitRateLimitError } from '../_lib/visits.js'

export default async function handler(req, res) {
  if (!allowMethods(req, res, ['POST'])) return
  if (!isSameOrigin(req)) return sendJson(res, 403, { ok: false, error: 'ORIGIN_REJECTED' })
  try {
    const session = await createVisit(req, readBody(req))
    sendJson(res, 201, { ok: true, ...session })
  } catch (error) {
    if (error instanceof VisitRateLimitError) return sendJson(res, 429, { ok: false, error: 'VISIT_RATE_LIMITED' })
    const failure = storageErrorPayload(error)
    sendJson(res, failure.status, failure.payload)
  }
}
