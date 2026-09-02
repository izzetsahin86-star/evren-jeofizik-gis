import { readAdminAccessConfig } from './_lib/access-config.js'
import { allowMethods, sendJson } from './_lib/http.js'

export default async function handler(req, res) {
  if (!allowMethods(req, res, ['GET'])) return
  const config = await readAdminAccessConfig()
  sendJson(res, 200, { ok: true, config })
}
