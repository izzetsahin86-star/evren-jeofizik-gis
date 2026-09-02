import { clearAdminCookie, clearAdminSession } from '../_lib/admin-auth.js'
import { allowMethods, isSameOrigin, sendJson } from '../_lib/http.js'

export default async function handler(req, res) {
  if (!allowMethods(req, res, ['POST'])) return
  if (!isSameOrigin(req)) return sendJson(res, 403, { ok: false, error: 'ORIGIN_REJECTED' })
  await clearAdminSession(req)
  clearAdminCookie(req, res)
  sendJson(res, 200, { ok: true })
}
