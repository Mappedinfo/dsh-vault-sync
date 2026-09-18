/** Synthetic-resource helpers shared by the test suite. */
import { createServer } from 'node:http'
import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'

export async function tempDir(prefix = 'vault-sync-test-') {
  return mkdtemp(join(tmpdir(), prefix))
}

export async function writeFiles(root, files) {
  for (const [relPath, content] of Object.entries(files)) {
    const target = join(root, relPath)
    await mkdir(dirname(target), { recursive: true })
    await writeFile(target, content)
  }
  return root
}

export async function cleanup(...dirs) {
  for (const dir of dirs) if (dir) await rm(dir, { recursive: true, force: true })
}

export const digestOf = value => createHash('sha256').update(value).digest('hex')

/** A filesystem-shaped config for tests; never touches the network. */
export function filesystemConfig({ stateDir, remoteRoot, sources }) {
  return {
    version: 1,
    stateDir,
    localRuns: 50,
    remote: {
      type: 'filesystem',
      root: remoteRoot,
      currentPrefix: 'current',
      versionsPrefix: 'versions',
      tempPrefix: 'incoming',
      concurrency: 16,
      retries: 0,
      timeoutSeconds: 30,
      allowRemoteDelete: true,
    },
    sources: sources.map(source => ({
      include: [],
      exclude: [],
      maxFileBytes: 512 * 1024 * 1024,
      required: false,
      kind: 'directory',
      ...source,
    })),
  }
}

/**
 * In-process S3-compatible server for the native SigV4 transport.
 * Implements ListObjectsV2 (with pagination), HeadObject, GetObject, PutObject,
 * CopyObject and DeleteObject, records every incoming Authorization header, and
 * can inject failures so retry behaviour is observable.
 */
export async function startFakeS3({ pageSize = 1000, bucket = 'test-bucket' } = {}) {
  const objects = new Map()
  const requests = []
  let failNext = 0
  let failWhen = null
  const server = createServer(async (req, res) => {
    const chunks = []
    for await (const chunk of req) chunks.push(chunk)
    const body = Buffer.concat(chunks)
    const url = new URL(req.url, 'http://127.0.0.1')
    const key = decodeURIComponent(url.pathname.replace(new RegExp(`^/${bucket}/?`), ''))
    requests.push({ method: req.method, path: url.pathname, query: Object.fromEntries(url.searchParams), key, authorization: req.headers.authorization, sha256: req.headers['x-amz-content-sha256'], meta: req.headers['x-amz-meta-sha256'], copySource: req.headers['x-amz-copy-source'] })
    const injected = (failNext > 0) || (typeof failWhen === 'function' && failWhen(req.method, key) === true)
    if (injected) {
      if (failNext > 0) failNext -= 1
      res.writeHead(503, { 'content-type': 'application/xml' })
      res.end('<Error><Code>SlowDown</Code><Message>injected</Message></Error>')
      return
    }
    if (req.method === 'GET' && url.searchParams.get('list-type') === '2') {
      const prefix = url.searchParams.get('prefix') ?? ''
      const limit = Number(url.searchParams.get('max-keys') ?? pageSize)
      const all = [...objects.entries()].filter(([name]) => name.startsWith(prefix)).sort((a, b) => (a[0] < b[0] ? -1 : 1))
      const contents = all.slice(0, limit).map(([name, object]) => `<Contents><Key>${name}</Key><Size>${object.body.length}</Size><ETag>&quot;${object.etag}&quot;</ETag><LastModified>2026-01-01T00:00:00.000Z</LastModified></Contents>`).join('')
      const truncated = all.length > limit
      res.writeHead(200, { 'content-type': 'application/xml' })
      res.end(`<?xml version="1.0"?><ListBucketResult><IsTruncated>${truncated}</IsTruncated>${contents}${truncated ? `<NextContinuationToken>${contents.length}</NextContinuationToken>` : ''}</ListBucketResult>`)
      return
    }
    if (req.method === 'HEAD') {
      const object = objects.get(key)
      if (!object) { res.writeHead(404); res.end(); return }
      res.writeHead(200, { 'content-length': String(object.body.length), etag: `"${object.etag}"`, ...(object.meta ? { 'x-amz-meta-sha256': object.meta } : {}) })
      res.end()
      return
    }
    if (req.method === 'GET') {
      const object = objects.get(key)
      if (!object) { res.writeHead(404, { 'content-type': 'application/xml' }); res.end('<Error><Code>NoSuchKey</Code></Error>'); return }
      res.writeHead(200, { 'content-length': String(object.body.length) })
      res.end(object.body)
      return
    }
    if (req.method === 'PUT' && req.headers['x-amz-copy-source']) {
      const source = decodeURIComponent(String(req.headers['x-amz-copy-source']).replace(new RegExp(`^/${bucket}/`), ''))
      const object = objects.get(source)
      if (!object) {
        res.writeHead(404, { 'content-type': 'application/xml' })
        res.end('<Error><Code>NoSuchKey</Code><Message>copy source missing</Message></Error>')
        return
      }
      const directive = req.headers['x-amz-metadata-directive']
      // Real S3/OSS defaults CopyObject to COPY, which carries user metadata
      // (including x-amz-meta-sha256) to the destination.
      objects.set(key, directive === 'REPLACE'
        ? { ...object, meta: req.headers['x-amz-meta-sha256'] }
        : { ...object })
      res.writeHead(200, { 'content-type': 'application/xml' })
      res.end('<CopyObjectResult><ETag>&quot;' + object.etag + '&quot;</ETag></CopyObjectResult>')
      return
    }
    if (req.method === 'PUT') {
      objects.set(key, { body, etag: createHash('md5').update(body).digest('hex'), meta: req.headers['x-amz-meta-sha256'] })
      res.writeHead(200, { etag: `"${objects.get(key).etag}"` })
      res.end()
      return
    }
    if (req.method === 'DELETE') {
      objects.delete(key)
      res.writeHead(204)
      res.end()
      return
    }
    res.writeHead(405)
    res.end()
  })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  const { port } = server.address()
  return {
    endpoint: `http://127.0.0.1:${port}`,
    bucket,
    objects,
    requests,
    failNext: count => { failNext = count },
    failWhen: predicate => { failWhen = predicate },
    close: () => new Promise(resolve => server.close(resolve)),
    keyOf: key => objects.get(key),
    keys: () => [...objects.keys()].sort(),
  }
}
