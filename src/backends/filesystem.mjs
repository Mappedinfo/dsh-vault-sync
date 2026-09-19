/**
 * Local-filesystem remote: the reference transport and the test harness.
 * It reproduces the OSS transport's semantics (versioned backups, in-flight
 * temp keys, digest metadata) with no network access, so the whole engine can
 * be exercised end to end on synthetic data.
 *
 * Metadata lives in one sidecar document per remote, so every change is a
 * read-modify-write that runs inside a per-path queue: the applier uploads
 * several files at once and concurrent writers would otherwise each persist a
 * document missing the other's entry.
 */
import { copyFile, mkdir, readFile, rm, stat } from 'node:fs/promises'
import { dirname, join, relative, sep } from 'node:path'
import { assertSafeKey, BackendError } from '../core/backend.mjs'
import { listFiles, pathExists, readJson, sha256File, toPosixPath, writeJsonAtomic } from '../core/util.mjs'

export const META_FILE = '.vault-sync-meta.json'

const writeQueues = new Map()
function enqueueWrite(path, task) {
  const previous = writeQueues.get(path) ?? Promise.resolve()
  const next = previous.then(task, task)
  writeQueues.set(path, next.catch(() => {}))
  return next
}

export function createFilesystemBackend({ root }) {
  const metaPath = join(root, META_FILE)
  const resolve = key => {
    assertSafeKey(key)
    return join(root, key.split('/').join(sep))
  }

  /** Read the shared metadata document, returning the objects map. */
  const loadMeta = async () => {
    const document = (await readJson(metaPath)) ?? { objects: {} }
    return document.objects ?? {}
  }

  /** Read-modify-write of the shared document, serialized per remote. */
  const updateMeta = mutate => enqueueWrite(metaPath, async () => {
    const document = (await readJson(metaPath)) ?? { objects: {} }
    if (!document.objects) document.objects = {}
    mutate(document.objects)
    await writeJsonAtomic(metaPath, document, { mode: 0o600 })
    return document.objects
  })

  const digestFor = (objects, key, size) => {
    const recorded = objects[key]
    return recorded && recorded.size === size && typeof recorded.digest === 'string' ? recorded.digest : undefined
  }

  return {
    describe: () => ({ kind: 'filesystem', detail: root, capabilities: { serverSideCopy: true, metadata: true, digest: 'sha256' } }),

    async list(prefix = '') {
      if (!(await pathExists(root))) return []
      let all
      try {
        all = await listFiles(root)
      } catch (error) {
        throw new BackendError(`list failed: ${error.message}`, { operation: 'list' })
      }
      const objects = await loadMeta()
      const normalized = prefix.replace(/^\/+|\/+$/g, '')
      const out = []
      for (const absolute of all) {
        const key = toPosixPath(relative(root, absolute))
        if (key === META_FILE) continue
        if (normalized && key !== normalized && !key.startsWith(`${normalized}/`)) continue
        const info = await stat(absolute)
        const digest = digestFor(objects, key, info.size)
        out.push({ key, size: info.size, mtimeMs: info.mtimeMs, digest, digestSource: digest ? 'metadata' : undefined })
      }
      return out
    },

    async head(key) {
      const target = resolve(key)
      if (!(await pathExists(target))) return undefined
      const info = await stat(target)
      const digest = digestFor(await loadMeta(), key, info.size)
      return { key, size: info.size, mtimeMs: info.mtimeMs, digest, digestSource: digest ? 'metadata' : undefined }
    },

    async putFile(key, localPath, { size, digest } = {}) {
      const target = resolve(key)
      try {
        await mkdir(dirname(target), { recursive: true })
        await copyFile(localPath, target)
      } catch (error) {
        throw new BackendError(`putFile ${key} failed: ${error.message}`, { operation: 'putFile', key, retryable: true })
      }
      const info = await stat(target)
      if (Number.isFinite(size) && info.size !== size) {
        throw new BackendError(`putFile ${key} size mismatch: wrote ${info.size}, expected ${size}`, { operation: 'putFile', key })
      }
      const resolved = digest ?? (await sha256File(target))
      await updateMeta(objects => {
        objects[key] = { size: info.size, digest: resolved, at: new Date().toISOString() }
      })
      return { key, size: info.size, digest: resolved }
    },

    async copy(fromKey, toKey) {
      const source = resolve(fromKey)
      const target = resolve(toKey)
      if (!(await pathExists(source))) throw new BackendError(`copy source missing: ${fromKey}`, { operation: 'copy', key: fromKey })
      await mkdir(dirname(target), { recursive: true })
      await copyFile(source, target)
      const recorded = (await loadMeta())[fromKey]
      if (recorded) {
        await updateMeta(objects => { objects[toKey] = { ...recorded, at: new Date().toISOString() } })
      }
    },

    async remove(key) {
      await rm(resolve(key), { force: true })
      await updateMeta(objects => { delete objects[key] })
    },

    async readText(key) {
      return readFile(resolve(key), 'utf8')
    },
  }
}
