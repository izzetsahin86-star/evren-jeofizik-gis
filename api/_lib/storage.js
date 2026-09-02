import { BlobPreconditionFailedError, del, get, list, put } from '@vercel/blob'

export class StorageUnavailableError extends Error {
  constructor() {
    super('Vercel Private Blob henüz bu projeye bağlı değil.')
    this.name = 'StorageUnavailableError'
  }
}

export function storageConfigured() {
  return Boolean(
    process.env.BLOB_READ_WRITE_TOKEN
      || process.env.BLOB_STORE_ID,
  )
}

export function assertStorage() {
  if (!storageConfigured()) throw new StorageUnavailableError()
}

export async function readPrivateJson(pathname) {
  assertStorage()
  const result = await get(pathname, { access: 'private', useCache: false })
  if (!result || result.statusCode !== 200 || !result.stream) return null
  const text = await new Response(result.stream).text()
  return {
    data: JSON.parse(text),
    etag: result.blob.etag,
    pathname: result.blob.pathname,
  }
}

export async function writePrivateJson(pathname, value, options = {}) {
  assertStorage()
  return put(pathname, JSON.stringify(value), {
    access: 'private',
    addRandomSuffix: false,
    allowOverwrite: options.allowOverwrite ?? true,
    contentType: 'application/json; charset=utf-8',
    cacheControlMaxAge: 60,
    ...(options.ifMatch ? { ifMatch: options.ifMatch } : {}),
  })
}

function retryableWrite(error) {
  if (error instanceof BlobPreconditionFailedError) return true
  const message = String(error?.message || '').toLowerCase()
  return message.includes('already exists') || message.includes('precondition') || message.includes('etag')
}

export async function mutatePrivateJson(pathname, initialValue, mutate) {
  assertStorage()
  let lastError
  for (let attempt = 0; attempt < 5; attempt += 1) {
    const current = await readPrivateJson(pathname)
    const base = current ? current.data : structuredClone(initialValue)
    const next = await mutate(base)
    if (next === base) return next
    try {
      await writePrivateJson(pathname, next, current
        ? { allowOverwrite: true, ifMatch: current.etag }
        : { allowOverwrite: false })
      return next
    } catch (error) {
      lastError = error
      if (!retryableWrite(error)) throw error
    }
  }
  throw lastError || new Error('Kayıt eşzamanlı güncellemeler nedeniyle yazılamadı.')
}

export async function listPrivate(prefix) {
  assertStorage()
  const blobs = []
  let cursor
  do {
    const page = await list({ prefix, limit: 1000, ...(cursor ? { cursor } : {}) })
    blobs.push(...page.blobs)
    cursor = page.hasMore ? page.cursor : undefined
  } while (cursor && blobs.length < 5000)
  return blobs
}

export async function deletePrivate(pathname) {
  assertStorage()
  await del(pathname)
}

export function storageErrorPayload(error) {
  if (error instanceof StorageUnavailableError) {
    return { status: 503, payload: { ok: false, error: 'STORAGE_NOT_CONFIGURED', message: error.message } }
  }
  console.error('Private storage error', error)
  return {
    status: 503,
    payload: { ok: false, error: 'STORAGE_UNAVAILABLE', message: 'Güvenli kayıt alanına şu anda ulaşılamıyor.' },
  }
}
