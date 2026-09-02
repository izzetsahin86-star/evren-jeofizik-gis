import crypto from 'node:crypto'
import { clientIp } from './http.js'
import { deletePrivate, readPrivateJson, writePrivateJson } from './storage.js'

const COOKIE_NAME = 'evren_admin_session'
const SESSION_SECONDS = 8 * 60 * 60
const INITIAL_PASSWORD = {
  version: 1,
  salt: 'd168d2aeed81ecf59541db5da818f947',
  hash: 'ad77c2fc5e277990a6d1f19edcfe5fba87764424ce94b58c5740ef86e1661d62206ac368d161c39ebc8dbe81003d72e79f311ea74165dcf37214f2c38c0fcad9',
  updatedAt: null,
}
const PASSWORD_PATH = 'evren-admin/config/password.json'

function passwordHash(password, salt) {
  return crypto.scryptSync(password, salt, 64)
}

function safeEqual(left, right) {
  try {
    const a = Buffer.isBuffer(left) ? left : Buffer.from(left, 'hex')
    const b = Buffer.isBuffer(right) ? right : Buffer.from(right, 'hex')
    return a.length === b.length && crypto.timingSafeEqual(a, b)
  } catch {
    return false
  }
}

async function passwordConfig() {
  const saved = await readPrivateJson(PASSWORD_PATH)
  const data = saved?.data
  if (data && typeof data.salt === 'string' && typeof data.hash === 'string') return data
  return INITIAL_PASSWORD
}

export async function verifyAdminPassword(password) {
  if (typeof password !== 'string' || password.length < 1 || password.length > 256) return false
  const config = await passwordConfig()
  return safeEqual(passwordHash(password, config.salt), config.hash)
}

export async function changeAdminPassword(password) {
  const salt = crypto.randomBytes(16).toString('hex')
  const config = {
    version: 1,
    salt,
    hash: passwordHash(password, salt).toString('hex'),
    updatedAt: new Date().toISOString(),
  }
  await writePrivateJson(PASSWORD_PATH, config)
  return config.updatedAt
}

function parseCookies(req) {
  return String(req.headers.cookie || '')
    .split(';')
    .map((part) => part.trim().split('='))
    .reduce((cookies, [name, ...value]) => {
      if (name) cookies[name] = value.join('=')
      return cookies
    }, {})
}

function sessionPath(token) {
  const digest = crypto.createHash('sha256').update(token).digest('hex')
  return 'evren-admin/sessions/' + digest + '.json'
}

function sessionToken(req) {
  const token = parseCookies(req)[COOKIE_NAME]
  return typeof token === 'string' && /^[A-Za-z0-9_-]{43}$/.test(token) ? token : null
}

export async function createAdminSession() {
  const token = crypto.randomBytes(32).toString('base64url')
  const issuedAt = Date.now()
  await writePrivateJson(sessionPath(token), {
    issuedAt,
    expiresAt: issuedAt + SESSION_SECONDS * 1000,
  }, { allowOverwrite: false })
  return token
}

export async function hasAdminSession(req) {
  const token = sessionToken(req)
  if (!token) return false
  try {
    const stored = await readPrivateJson(sessionPath(token))
    return Number.isFinite(stored?.data?.expiresAt) && stored.data.expiresAt > Date.now()
  } catch {
    return false
  }
}

export async function clearAdminSession(req) {
  const token = sessionToken(req)
  if (!token) return
  try {
    await deletePrivate(sessionPath(token))
  } catch {
    // Süresi geçmiş veya daha önce kapatılmış oturum olabilir.
  }
}

function secureRequest(req) {
  const protocol = String(req.headers['x-forwarded-proto'] || '').split(',')[0].trim()
  return protocol === 'https' || Boolean(process.env.VERCEL)
}

export function setAdminCookie(req, res, session) {
  const secure = secureRequest(req) ? '; Secure' : ''
  res.setHeader('Set-Cookie', COOKIE_NAME + '=' + session + '; Path=/; HttpOnly; SameSite=Strict; Max-Age=' + SESSION_SECONDS + secure)
}

export function clearAdminCookie(req, res) {
  const secure = secureRequest(req) ? '; Secure' : ''
  res.setHeader('Set-Cookie', COOKIE_NAME + '=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0' + secure)
}

function ratePath(req) {
  const digest = crypto.createHash('sha256').update(clientIp(req)).digest('hex')
  return 'evren-admin/rate-limit/' + digest + '.json'
}

export async function loginRateStatus(req) {
  const path = ratePath(req)
  const stored = await readPrivateJson(path)
  const data = stored?.data
  if (!data || typeof data !== 'object') return { blocked: false, attempts: 0, windowStartedAt: 0, path }
  const blockedUntil = Number(data.blockedUntil || 0)
  if (blockedUntil > Date.now()) {
    return { blocked: true, attempts: Number(data.attempts || 0), windowStartedAt: Number(data.windowStartedAt || 0), retryAfter: Math.ceil((blockedUntil - Date.now()) / 1000), path }
  }
  const windowStartedAt = Number(data.windowStartedAt || 0)
  if (Date.now() - windowStartedAt > 15 * 60 * 1000) return { blocked: false, attempts: 0, windowStartedAt: 0, path }
  return { blocked: false, attempts: Number(data.attempts || 0), windowStartedAt, path }
}

export async function recordLoginFailure(req, status) {
  const attempts = status.attempts + 1
  const now = Date.now()
  const blockedUntil = attempts >= 5 ? now + 15 * 60 * 1000 : 0
  await writePrivateJson(status.path, {
    attempts,
    windowStartedAt: status.windowStartedAt || now,
    lastAttemptAt: now,
    blockedUntil,
  })
  return { attempts, blockedUntil }
}

export async function clearLoginFailures(req) {
  try {
    await deletePrivate(ratePath(req))
  } catch {
    // Daha önce başarısız giriş yoksa silinecek kayıt bulunmayabilir.
  }
}
