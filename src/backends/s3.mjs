/**
 * Minimal S3-compatible client with hand-rolled AWS SigV4 signing.
 * Targets Alibaba Cloud OSS's S3-compatible API and works with any S3
 * endpoint. Only the operations the engine needs: ListObjectsV2, HeadObject,
 * PutObject, CopyObject, DeleteObject, GetObject.
 */
import { createHash, createHmac } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { BackendError } from '../core/backend.mjs'

export const UNSIGNED_PAYLOAD = 'UNSIGNED-PAYLOAD'
export const EMPTY_SHA256 = createHash('sha256').update('').digest('hex')

export function sha256Hex(value) {
  return createHash('sha256').update(value).digest('hex')
}

function hmac(key, value, encoding) {
  return createHmac('sha256', key).update(value).digest(encoding)
}

/** Encode one S3 object key for a URI path while keeping '/' separators. */
export function encodeKey(key) {
  return key
    .split('/')
    .map(segment => encodeURIComponent(segment).replace(/[!'()*]/g, char => `%${char.charCodeAt(0).toString(16).toUpperCase()}`))
    .join('/')
}

export function amzTimestamps(now = new Date()) {
  const iso = now.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '')
  return { amz: iso, short: iso.slice(0, 8) }
}

export function canonicalQueryString(params = {}) {
  return Object.entries(params)
    .filter(([, value]) => value !== undefined && value !== null && value !== '')
    .map(([key, value]) => [encodeURIComponent(key), encodeURIComponent(String(value))])
    .sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : a[1] < b[1] ? -1 : 1))
    .map(([key, value]) => `${key}=${value}`)
    .join('&')
}

/**
 * Build the SigV4 Authorization header. Exported so the implementation can be
 * pinned against the AWS-published signature test vectors.
 */
export function signRequest({
  method,
  path,
  query = {},
  headers = {},
  payloadHash = EMPTY_SHA256,
  accessKeyId,
  secretAccessKey,
  sessionToken,
  region = 'us-east-1',
  service = 's3',
  now = new Date(),
}) {
  const { amz, short } = amzTimestamps(now)
  // Header names are lowercased; values are only whitespace-normalized, never
  // case-folded: folding the payload hash changes the signature.
  const lowered = {}
  for (const [key, value] of Object.entries(headers)) {
    lowered[key.toLowerCase()] = String(value).trim().replace(/\s+/g, ' ')
  }
  // Only explicit request headers plus x-amz-date are signed. The payload hash
  // enters the canonical request as its own component; it becomes a signed
  // header only when the caller actually sends x-amz-content-sha256.
  const present = { ...lowered, 'x-amz-date': amz }
  if (sessionToken) present['x-amz-security-token'] = sessionToken
  const names = Object.keys(present).sort()
  const canonicalHeaders = `${names.map(name => `${name}:${present[name]}`).join('\n')}\n`
  const signedHeaders = names.join(';')
  const canonicalRequest = [method.toUpperCase(), path, canonicalQueryString(query), canonicalHeaders, signedHeaders, payloadHash].join('\n')
  const scope = `${short}/${region}/${service}/aws4_request`
  const stringToSign = ['AWS4-HMAC-SHA256', amz, scope, sha256Hex(canonicalRequest)].join('\n')
  const signingKey = hmac(hmac(hmac(hmac(`AWS4${secretAccessKey}`, short), region), service), 'aws4_request')
  const signature = hmac(signingKey, stringToSign, 'hex')
  // `present` holds lowercase wire headers; the Authorization header is added
  // once under its canonical name so nothing overwrites it.
  const wire = { ...present }
  delete wire.authorization
  return {
    authorization: `AWS4-HMAC-SHA256 Credential=${accessKeyId}/${scope}, SignedHeaders=${signedHeaders}, Signature=${signature}`,
    headers: { ...wire, Authorization: `AWS4-HMAC-SHA256 Credential=${accessKeyId}/${scope}, SignedHeaders=${signedHeaders}, Signature=${signature}` },
    canonicalRequest,
    stringToSign,
    signature,
    scope,
  }
}

function xmlText(text, tag) {
  const match = new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`).exec(text)
  if (!match) return undefined
  return match[1]
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, '&')
}

function errorFromXml(text, fallback) {
  const code = xmlText(text, 'Code')
  const message = xmlText(text, 'Message')
  if (code || message) return `${code ?? 'S3Error'}${message ? `: ${message}` : ''}`
  return fallback
}

/**
 * Transport-level failures (a VPN tunnel or flaky link dropping a connection)
 * are retryable even though no HTTP response was ever received. Without this,
 * a TUN-mode reconnect aborts the whole run instead of backing off.
 */
export function isTransportFailure(error) {
  const code = error?.cause?.code ?? error?.code
  const message = String(error?.cause?.message ?? error?.message ?? '')
  return /UND_ERR_CONNECT_TIMEOUT|UND_ERR_SOCKET|UND_ERR_HEADERS_TIMEOUT|UND_ERR_BODY_TIMEOUT|ECONNRESET|ECONNREFUSED|ETIMEDOUT|EPIPE|ENETUNREACH|EHOSTUNREACH|EAI_AGAIN|socket hang up|fetch failed/i.test(`${code ?? ''} ${message}`)
}

/**
 * HTTP-level failures worth retrying. SignatureDoesNotMatch belongs here: when
 * the request is tunnelled through a VPN, an intermediary can corrupt it in
 * flight, and OSS then reports a signature mismatch for a request whose
 * signature is identical to one that just succeeded. Retrying is harmless
 * (the signature is either right or it is not) and turns a dead run into a
 * recovered one. Terminal conditions such as InvalidAccessKeyId are excluded.
 */
export function isRetryableHttpFailure(status, code) {
  if (status >= 500 || status === 429 || status === 408) return true
  return /SignatureDoesNotMatch|RequestTimeTooSkewed|ServiceUnavailable|InternalError|OperationTimeout|RequestTimeout/i.test(String(code ?? ''))
}

export function createS3Backend({
  accessKeyId,
  accessKeySecret,
  sessionToken,
  endpoint,
  region = 'us-east-1',
  bucket,
  forcePathStyle = false,
  retries = 5,
  timeoutSeconds = 300,
  maxListingKeys = 200000,
  pageSize = 1000,
  fetchImpl = globalThis.fetch,
  now = () => new Date(),
} = {}) {
  if (!accessKeyId || !accessKeySecret) throw new BackendError('S3 backend needs accessKeyId and accessKeySecret', { operation: 'validate' })
  if (!endpoint || !bucket) throw new BackendError('S3 backend needs endpoint and bucket', { operation: 'validate' })
  const base = new URL(endpoint.includes('://') ? endpoint : `https://${endpoint}`)
  const host = () => (forcePathStyle ? base.host : `${bucket}.${base.host}`)
  const pathFor = key => {
    const encoded = key ? `/${encodeKey(key)}` : ''
    return forcePathStyle ? `/${bucket}${encoded}` : (encoded || '/')
  }
  const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))
  const urlFor = (path, query) => {
    const qs = canonicalQueryString(query)
    return `${base.protocol}//${host()}${path}${qs ? `?${qs}` : ''}`
  }
  const authorize = ({ method, path, query, headers, payloadHash }) => signRequest({
    method, path, query, headers, payloadHash, accessKeyId, secretAccessKey: accessKeySecret, sessionToken, region, service: 's3', now: now(),
  })

  async function withRetry(operation, key, fn) {
    let lastError
    for (let attempt = 0; attempt <= retries; attempt += 1) {
      try {
        return await fn(attempt)
      } catch (error) {
        lastError = error
        const retryable = (error instanceof BackendError && error.retryable) || isTransportFailure(error)
        if (!retryable || attempt === retries) throw error
        await sleep(Math.min(30_000, 500 * 2 ** attempt))
      }
    }
    throw lastError
  }

  async function bodyRequest({ method, key = '', query = {}, headers = {}, payloadHash = EMPTY_SHA256, expectBody = true }) {
    const path = pathFor(key)
    // x-amz-content-sha256 is sent (and therefore signed) on every request, so
    // OSS/S3 can reject a body that does not match the declared hash.
    const signed = authorize({ method, path, query, headers: { host: host(), 'x-amz-content-sha256': payloadHash, ...headers }, payloadHash })
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), timeoutSeconds * 1000)
    let response
    try {
      response = await fetchImpl(urlFor(path, query), { method, headers: signed.headers, signal: controller.signal })
    } catch (error) {
      const cause = error?.cause ?? error
      throw new BackendError(`${method} ${key || '/'} transport error: ${cause?.message ?? error.message}`, { operation: method, key, retryable: isTransportFailure(error), cause: error })
    } finally {
      clearTimeout(timer)
    }
    const text = expectBody ? await response.text() : ''
    if (!response.ok) {
      const code = xmlText(text, 'Code')
      throw new BackendError(`${method} ${key || '/'} -> ${response.status} ${errorFromXml(text, response.statusText)}`, { operation: method, key, retryable: isRetryableHttpFailure(response.status, code) })
    }
    return { response, text }
  }

  return {
    describe: () => ({ kind: 's3', detail: `${bucket} @ ${base.host}`, capabilities: { serverSideCopy: true, metadata: true, digest: 'sha256+x-amz-meta-sha256' } }),

    async list(prefix = '') {
      const out = []
      let token
      let pages = 0
      do {
        const query = { 'list-type': '2', prefix: prefix || undefined, 'continuation-token': token, 'max-keys': String(pageSize) }
        const { text } = await withRetry('list', prefix, () => bodyRequest({ method: 'GET', query }))
        for (const match of text.matchAll(/<Contents>([\s\S]*?)<\/Contents>/g)) {
          const block = match[1]
          const lastModified = xmlText(block, 'LastModified')
          out.push({
            key: xmlText(block, 'Key') ?? '',
            size: Number(xmlText(block, 'Size') ?? 0),
            etag: (xmlText(block, 'ETag') ?? '').replace(/"/g, ''),
            mtimeMs: lastModified ? Date.parse(lastModified) : undefined,
          })
          if (out.length > maxListingKeys) throw new BackendError(`listing exceeded ${maxListingKeys} keys under ${prefix}`, { operation: 'list' })
        }
        token = /<IsTruncated>true<\/IsTruncated>/.test(text) ? xmlText(text, 'NextContinuationToken') : undefined
        pages += 1
        if (pages > 10000) throw new BackendError('listing exceeded 10000 pages', { operation: 'list' })
      } while (token)
      return out
    },

    async head(key) {
      try {
        const { response } = await withRetry('head', key, () => bodyRequest({ method: 'HEAD', key, expectBody: false }))
        const digest = response.headers.get('x-amz-meta-sha256') ?? undefined
        const lastModified = response.headers.get('last-modified')
        return {
          key,
          size: Number(response.headers.get('content-length') ?? 0),
          mtimeMs: lastModified ? Date.parse(lastModified) : undefined,
          etag: response.headers.get('etag')?.replace(/"/g, ''),
          digest,
          digestSource: digest ? 'metadata' : undefined,
        }
      } catch (error) {
        if (error instanceof BackendError && /-> 404/.test(error.message)) return undefined
        throw error
      }
    },

    async putFile(key, localPath, { size, digest, contentType = 'application/octet-stream' } = {}) {
      return withRetry('put', key, async () => {
        const path = pathFor(key)
        const headers = {
          host: host(),
          'content-type': contentType,
          'content-length': String(size),
          'x-amz-content-sha256': UNSIGNED_PAYLOAD,
          ...(digest ? { 'x-amz-meta-sha256': digest } : {}),
        }
        const signed = authorize({ method: 'PUT', path, headers, payloadHash: UNSIGNED_PAYLOAD })
        const stream = createReadStream(localPath)
        const controller = new AbortController()
        const timer = setTimeout(() => controller.abort(), timeoutSeconds * 1000)
        let response
        try {
          response = await fetchImpl(urlFor(path, {}), { method: 'PUT', headers: signed.headers, body: stream, duplex: 'half', signal: controller.signal })
        } catch (error) {
          stream.destroy()
          const cause = error?.cause ?? error
          throw new BackendError(`put ${key} transport error: ${cause?.message ?? error.message}`, { operation: 'put', key, retryable: isTransportFailure(error), cause: error })
        } finally {
          clearTimeout(timer)
        }
        if (!response.ok) {
          const text = await response.text().catch(() => '')
          throw new BackendError(`put ${key} -> ${response.status} ${errorFromXml(text, response.statusText)}`, { operation: 'put', key, retryable: isRetryableHttpFailure(response.status, xmlText(text, 'Code')) })
        }
        return { key, size, digest }
      })
    },

    async copy(fromKey, toKey) {
      return withRetry('copy', toKey, async () => {
        const path = pathFor(toKey)
        const headers = { host: host(), 'x-amz-copy-source': `/${bucket}/${encodeKey(fromKey)}` }
        const signed = authorize({ method: 'PUT', path, headers, payloadHash: EMPTY_SHA256 })
        const response = await fetchImpl(urlFor(path, {}), { method: 'PUT', headers: signed.headers })
        const text = await response.text().catch(() => '')
        if (!response.ok) {
          throw new BackendError(`copy ${fromKey} -> ${toKey} -> ${response.status} ${errorFromXml(text, response.statusText)}`, { operation: 'copy', key: toKey, retryable: isRetryableHttpFailure(response.status, xmlText(text, 'Code')) })
        }
        const code = xmlText(text, 'Code')
        if (code) throw new BackendError(`copy ${fromKey} -> ${toKey} rejected: ${errorFromXml(text, code)}`, { operation: 'copy', key: toKey, retryable: isRetryableHttpFailure(200, code) })
      })
    },

    async remove(key) {
      return withRetry('delete', key, async () => { await bodyRequest({ method: 'DELETE', key, expectBody: false }) })
    },

    async readText(key) {
      const { text } = await withRetry('get', key, () => bodyRequest({ method: 'GET', key }))
      return text
    },
  }
}
