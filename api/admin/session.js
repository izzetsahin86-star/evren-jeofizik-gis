import { allowMethods, sendJson } from '../_lib/http.js'
import { hasAdminSession } from '../_lib/admin-auth.js'
import { storageConfigured } from '../_lib/storage.js'

export default async function handler(req, res) {
  if (!allowMethods(req, res, ['GET'])) return
  sendJson(res, 200, {
    ok: true,
    authenticated: await hasAdminSession(req),
    storageConfigured: storageConfigured(),
  })
}
