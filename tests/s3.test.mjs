/**
 * Native SigV4 transport against an in-process S3-compatible server. This is
 * what proves the OSS path end to end: signing, streaming upload, server-side
 * copy for versioning, paginated listing, deletes, retries and error mapping.
 * No real bucket or credential is involved.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { join } from 'node:path'
import { mkdir } from 'node:fs/promises'
import { createS3Backend } from '../src/backends/s3.mjs'
import { createEngine } from '../src/core/engine.mjs'
import { cleanup, startFakeS3, tempDir, writeFiles } from './helpers.mjs'

const CREDENTIALS = { accessKeyId: 'AKIDEXAMPLE', accessKeySecret: 'wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY', region: 'cn-hangzhou' }

function configFor({ endpoint, bucket, stateDir, root }) {
  return {
    version: 1,
    stateDir,
    localRuns: 50,
    remote: {
      type: 'oss',
      engine: 'native',
      endpoint,
      bucket,
      region: 'cn-hangzhou',
      currentPrefix: 'current',
      versionsPrefix: 'versions',
      tempPrefix: 'incoming',
      concurrency: 4,
      retries: 2,
      timeoutSeconds: 10,
      allowRemoteDelete: true,
    },
    sources: [{ id: 'papers', kind: 'directory', root, remote: 'papers', include: [], exclude: [], maxFileBytes: 1048576, required: false }],
  }
}

async function s3Harness({ pageSize = 1000, retries = 2 } = {}) {
  const server = await startFakeS3({ pageSize })
  const root = await tempDir('vault-s3-')
  const library = join(root, 'library')
  await mkdir(library, { recursive: true })
  const config = configFor({ endpoint: server.endpoint, bucket: server.bucket, stateDir: join(root, 'state'), root: library })
  const backend = createS3Backend({ ...CREDENTIALS, endpoint: server.endpoint, bucket: server.bucket, forcePathStyle: true, retries, timeoutSeconds: 10 })
  const engine = createEngine({ config, backend, now: () => new Date('2026-05-06T00:00:00Z') })
  return { server, root, library, config, backend, engine }
}

test('every request is signed with the expected SigV4 shape', async () => {
  const h = await s3Harness()
  try {
    await writeFiles(h.library, { 'a.pdf': 'alpha' })
    await h.engine.run({})
    assert.ok(h.server.requests.length >= 2)
    for (const request of h.server.requests) {
      assert.match(request.authorization ?? '', /^AWS4-HMAC-SHA256 Credential=AKIDEXAMPLE\/\d{8}\/cn-hangzhou\/s3\/aws4_request, SignedHeaders=[a-z0-9;-]+, Signature=[0-9a-f]{64}$/)
      const signedHeaders = /SignedHeaders=([a-z0-9;-]+)/.exec(request.authorization)[1].split(';')
      assert.ok(signedHeaders.includes('host'), `host must be signed: ${signedHeaders.join(',')}`)
      // Every request except a server-side CopyObject declares its payload hash.
      if (!request.copySource) assert.match(request.authorization, /x-amz-content-sha256/)
    }
  } finally {
    await h.server.close()
    await cleanup(h.root)
  }
})

test('uploads land under current/ and carry the sha256 object metadata', async () => {
  const h = await s3Harness()
  try {
    await writeFiles(h.library, { '2024/a.pdf': 'alpha', 'nested/deep/b.pdf': 'beta' })
    const result = await h.engine.run({})
    assert.equal(result.totals.upload, 2)
    assert.deepEqual(h.server.keys(), ['current/papers/2024/a.pdf', 'current/papers/nested/deep/b.pdf'])
    const put = h.server.requests.filter(request => request.method === 'PUT' && !request.copySource)
    assert.equal(put.length, 2)
    for (const request of put) assert.match(request.meta ?? '', /^[0-9a-f]{64}$/)
  } finally {
    await h.server.close()
    await cleanup(h.root)
  }
})

test('a modified file is archived by server-side copy and re-uploaded directly', async () => {
  const h = await s3Harness()
  try {
    await writeFiles(h.library, { 'a.pdf': 'one' })
    await h.engine.run({})
    await writeFiles(h.library, { 'a.pdf': 'two-longer' })
    const result = await h.engine.run({})
    assert.equal(result.totals.version, 1)
    assert.deepEqual(h.server.keys(), ['current/papers/a.pdf', 'versions/2026-05-06/papers/a.pdf'])
    assert.equal(h.server.keyOf('versions/2026-05-06/papers/a.pdf').body.toString(), 'one')
    assert.equal(h.server.keyOf('current/papers/a.pdf').body.toString(), 'two-longer')
    const copies = h.server.requests.filter(request => Boolean(request.copySource))
    // Archive only: the replacement content is uploaded straight to its final
    // key, so publishing never depends on CopyObject.
    assert.equal(copies.length, 1, 'exactly one archive copy is expected')
    assert.equal(copies[0].copySource, '/test-bucket/current/papers/a.pdf')
    assert.equal(copies[0].key, 'versions/2026-05-06/papers/a.pdf')
    const gets = h.server.requests.filter(request => request.method === 'GET' && !request.query['list-type'])
    assert.equal(gets.length, 0, 'no object is downloaded to archive a version')
  } finally {
    await h.server.close()
    await cleanup(h.root)
  }
})

test('publishStrategy=temp-copy stages through incoming/ and publishes server-side', async () => {
  const h = await s3Harness()
  try {
    h.config.remote.publishStrategy = 'temp-copy'
    const { createEngine: makeEngine } = await import('../src/core/engine.mjs')
    const engine = makeEngine({ config: h.config, backend: h.backend, now: () => new Date('2026-05-06T00:00:00Z') })
    await writeFiles(h.library, { 'a.pdf': 'alpha' })
    const result = await engine.run({})
    assert.equal(result.totals.upload, 1)
    assert.deepEqual(h.server.keys(), ['current/papers/a.pdf'])
    const copies = h.server.requests.filter(request => Boolean(request.copySource))
    assert.equal(copies.length, 1)
    assert.ok(copies[0].copySource.startsWith('/test-bucket/incoming/'))
    assert.equal(copies[0].key, 'current/papers/a.pdf')
    assert.deepEqual(h.server.keys().filter(k => k.startsWith('incoming/')), [], 'the staged object is removed after publishing')
  } finally {
    await h.server.close()
    await cleanup(h.root)
  }
})

test('no temporary objects survive a successful publish', async () => {
  const h = await s3Harness()
  try {
    await writeFiles(h.library, { 'a.pdf': 'alpha' })
    await h.engine.run({})
    assert.deepEqual(h.server.keys().filter(key => key.startsWith('incoming/')), [])
  } finally {
    await h.server.close()
    await cleanup(h.root)
  }
})

test('listing paginates instead of silently truncating', async () => {
  const h = await s3Harness({ pageSize: 2 })
  try {
    const files = {}
    for (let i = 0; i < 7; i += 1) files[`p${i}.pdf`] = `payload-${i}`
    await writeFiles(h.library, files)
    const result = await h.engine.run({})
    assert.equal(result.totals.upload, 7)
    const listing = await h.backend.list('current/papers')
    assert.equal(listing.length, 7)
    const listRequests = h.server.requests.filter(request => request.query['list-type'] === '2')
    assert.ok(listRequests.length > 1, 'expected at least two list pages')
  } finally {
    await h.server.close()
    await cleanup(h.root)
  }
})

test('transient 503s are retried and the run still succeeds', async () => {
  const h = await s3Harness()
  try {
    await writeFiles(h.library, { 'a.pdf': 'alpha' })
    h.server.failNext(1)
    const result = await h.engine.run({})
    assert.equal(result.totals.failed, 0)
    assert.equal(result.totals.upload, 1)
  } finally {
    await h.server.close()
    await cleanup(h.root)
  }
})

test('an unrecoverable server error surfaces as a failed item, not a crash', async () => {
  const h = await s3Harness({ retries: 0 })
  try {
    await writeFiles(h.library, { 'a.pdf': 'alpha' })
    // Fail every object upload, but keep listing and metadata requests healthy,
    // so the failure is attributable to one file rather than to the transport.
    // Fail the publish PUT (the direct path writes straight to current/).
    h.server.failWhen((method, key) => method === 'PUT' && key.startsWith('current/'))
    const result = await h.engine.run({})
    assert.equal(result.totals.failed, 1)
    assert.equal(result.record.status, 'partial')
    assert.match(result.perSource[0].failed[0].error, /503|SlowDown/)
  } finally {
    await h.server.close()
    await cleanup(h.root)
  }
})

test('a missing copy source is reported as a clear error', async () => {
  const h = await s3Harness()
  try {
    await assert.rejects(
      () => h.backend.copy('current/papers/absent.pdf', 'versions/2026-05-06/papers/absent.pdf'),
      /NoSuchKey|copy source missing/,
    )
    assert.equal(await h.backend.head('current/papers/absent.pdf'), undefined)
  } finally {
    await h.server.close()
    await cleanup(h.root)
  }
})

test('verify over the S3 transport matches stored metadata digests', async () => {
  const h = await s3Harness()
  try {
    await writeFiles(h.library, { 'a.pdf': 'alpha', 'b.pdf': 'beta' })
    await h.engine.run({})
    const verified = await h.engine.verify({})
    assert.equal(verified.ok, true)
    assert.equal(verified.checked, 2)
    assert.equal(verified.sources[0].digestUnavailable, 0)
  } finally {
    await h.server.close()
    await cleanup(h.root)
  }
})

test('a transport-level failure is retried instead of aborting the run', async () => {
  // A VPN tunnel or flaky link drops the connection before any HTTP response:
  // no HTTP status exists, so the retry decision must come from the error shape.
  const { isTransportFailure } = await import('../src/backends/s3.mjs')
  assert.equal(isTransportFailure({ cause: { code: 'UND_ERR_CONNECT_TIMEOUT' } }), true)
  assert.equal(isTransportFailure({ cause: { code: 'ECONNRESET' } }), true)
  assert.equal(isTransportFailure(new Error('fetch failed')), true)
  assert.equal(isTransportFailure({ cause: { code: 'CERT_HAS_EXPIRED' } }), false)

  const server = await startFakeS3()
  const root = await tempDir('vault-transport-')
  try {
    const library = join(root, 'library')
    await mkdir(library, { recursive: true })
    await writeFiles(library, { 'a.pdf': 'alpha' })
    let attempts = 0
    const flakyFetch = async (url, init) => {
      attempts += 1
      if (attempts === 1) {
        const error = new TypeError('fetch failed')
        error.cause = { code: 'UND_ERR_CONNECT_TIMEOUT', message: 'Connect Timeout Error' }
        throw error
      }
      return globalThis.fetch(url, init)
    }
    const config = configFor({ endpoint: server.endpoint, bucket: server.bucket, stateDir: join(root, 'state'), root: library })
    const backend = createS3Backend({ ...CREDENTIALS, endpoint: server.endpoint, bucket: server.bucket, forcePathStyle: true, retries: 2, timeoutSeconds: 10, fetchImpl: flakyFetch })
    const engine = createEngine({ config, backend, now: () => new Date('2026-05-06T00:00:00Z') })
    const result = await engine.run({})
    assert.equal(result.totals.failed, 0, 'a dropped connection must be retried, not reported as a file failure')
    assert.equal(result.totals.upload, 1)
    assert.ok(attempts > 1)
  } finally {
    await server.close()
    await cleanup(root)
  }
})

test('a signature mismatch is retried, but a bad credential is not', async () => {
  // A VPN tunnel can corrupt a request in flight; OSS then reports a signature
  // mismatch for a request whose signature is fine. That is recoverable.
  // A genuinely wrong AccessKey is not, and must fail fast.
  const { isRetryableHttpFailure } = await import('../src/backends/s3.mjs')
  assert.equal(isRetryableHttpFailure(403, 'SignatureDoesNotMatch'), true)
  assert.equal(isRetryableHttpFailure(403, 'RequestTimeTooSkewed'), true)
  assert.equal(isRetryableHttpFailure(503, 'ServiceUnavailable'), true)
  assert.equal(isRetryableHttpFailure(403, 'InvalidAccessKeyId'), false)
  assert.equal(isRetryableHttpFailure(403, 'AccessDenied'), false)
  assert.equal(isRetryableHttpFailure(404, 'NoSuchKey'), false)
})

test('a transient signature failure during copy is retried and the run survives', async () => {
  const server = await startFakeS3()
  const root = await tempDir('vault-sigretry-')
  try {
    const library = join(root, 'library')
    await mkdir(library, { recursive: true })
    await writeFiles(library, { 'a.pdf': 'alpha' })
    let injected = 0
    const flakyFetch = async (url, init) => {
      // Fail the first copy with a signature mismatch, then behave normally.
      if (init?.method === 'PUT' && String(url).includes('/current/') && injected === 0) {
        injected += 1
        return new Response('<Error><Code>SignatureDoesNotMatch</Code><Message>injected</Message></Error>', { status: 403, headers: { 'content-type': 'application/xml' } })
      }
      return globalThis.fetch(url, init)
    }
    const config = configFor({ endpoint: server.endpoint, bucket: server.bucket, stateDir: join(root, 'state'), root: library })
    const backend = createS3Backend({ ...CREDENTIALS, endpoint: server.endpoint, bucket: server.bucket, forcePathStyle: true, retries: 3, timeoutSeconds: 10, fetchImpl: flakyFetch })
    const engine = createEngine({ config, backend, now: () => new Date('2026-05-06T00:00:00Z') })
    const result = await engine.run({})
    assert.equal(injected, 1, 'the injected failure should have been attempted')
    assert.equal(result.totals.failed, 0, 'the retry should have published the object')
    assert.equal(result.totals.upload, 1)
  } finally {
    await server.close()
    await cleanup(root)
  }
})
