/**
 * Local-filesystem remote: the reference transport and the test harness.
 * It reproduces the OSS transport semantics exactly (versioned backups,
 * in-flight temp keys, digest metadata) with no network access, so the whole
 * engine can be exercised end to end on synthetic data.
 */
import { copyFile, mkdir, readFile, rm, stat } from 'node:fs/promises'
import { dirname, join, relative, sep } from 'node:path'
import { assertSafeKey, BackendError } from '../core/backend.mjs'
import { listFiles, pathExists, readJson, sha256File, toPosixPath, writeJsonAtomic } from '../core/util.mjs'

export const META_FILE = '.vault-sync-meta.json'

export function createFilesystemBackend({ root }) {
  const metaPath = join(root, META_FILE)
  const resolve = key => {
    assertSafeKey(key)
    return join(root, key.split('/').join(sep))
  }
  let metaCache

  const loadMeta = async () => {
    if (!metaCache) metaCache = (await readJson(metaPath)) ?? { objects: {} }
    if (!metaCache.objects) metaCache.objects = {}
    return metaCache
  }
  const saveMeta = async () => { await writeJsonAtomic(metaPath, metaCache, { mode: 0o600 }) }
  const digestFor = (meta, key, size) => {
    const recorded = meta.objects[key]
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
      const meta = await loadMeta()
      const normalized = prefix.replace(/^\/+|\/+$/g, '')
      const out = []
      for (const absolute of all) {
        const key = toPosixPath(relative(root, absolute))
        if (key === META_FILE) continue
        if (normalized && key !== normalized && !key.startsWith(`${normalized}/`)) continue
        const info = await stat(absolute)
        const digest = digestFor(meta, key, info.size)
        out.push({ key, size: info.size, mtimeMs: info.mtimeMs, digest, digestSource: digest ? 'metadata' : undefined })
      }
      return out
    },

    async head(key) {
      const target = resolve(key)
      if (!(await pathExists(target))) return undefined
      const info = await stat(target)
      const meta = await loadMeta()
      const digest = digestFor(meta, key, info.size)
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
      const meta = await loadMeta()
      meta.objects[key] = { size: info.size, digest: digest ?? (await sha256File(target)), at: new Date().toISOString() }
      await saveMeta()
      return { key, size: info.size, digest: meta.objects[key].digest }
    },

    async copy(fromKey, toKey) {
      const source = resolve(fromKey)
      const target = resolve(toKey)
      if (!(await pathExists(source))) throw new BackendError(`copy source missing: ${fromKey}`, { operation: 'copy', key: fromKey })
      await mkdir(dirname(target), { recursive: true })
      await copyFile(source, target)
      const meta = await loadMeta()
      if (meta.objects[fromKey]) {
        meta.objects[toKey] = { ...meta.objects[fromKey], at: new Date().toISOString() }
        await saveMeta()
      }
    },

    async remove(key) {
      await rm(resolve(key), { force: true })
      const meta = await loadMeta()
      if (meta.objects[key]) { delete meta.objects[key]; await saveMeta() }
    },

    async readText(key) {
      return readFile(resolve(key), 'utf8')
    },
  }
}
