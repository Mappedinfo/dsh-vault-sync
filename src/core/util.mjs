/** Bounded, dependency-free helpers shared by the sync core. */
import { createHash } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { chmod, mkdir, open, readFile, readdir, rename, rm, stat, writeFile } from 'node:fs/promises'
import { dirname, join, posix, sep } from 'node:path'

export const MIB = 1024 * 1024
export const GIB = 1024 * MIB

/** Run identifier: sortable stamp plus entropy. Never a security boundary. */
export function newRunId(now = new Date()) {
  const stamp = now.toISOString().replace(/[-:.TZ]/g, '').slice(0, 14)
  const rand = Math.random().toString(36).slice(2, 8)
  return `${stamp}-${rand}`
}

/** UTC date folder used by versioned backups (YYYY-MM-DD). */
export function versionStamp(now = new Date()) {
  return now.toISOString().slice(0, 10)
}

export async function pathExists(path) {
  try { await stat(path); return true } catch { return false }
}

export async function readJson(path) {
  try {
    return JSON.parse(await readFile(path, 'utf8'))
  } catch (error) {
    if (error?.code === 'ENOENT') return undefined
    throw new Error(`cannot read JSON ${path}: ${error.message}`)
  }
}

/** Atomic write: temp file in the same directory, fsync'd content, then rename. */
async function atomicWrite(path, data, mode) {
  await mkdir(dirname(path), { recursive: true })
  const tmp = `${path}.tmp-${process.pid}-${Date.now()}`
  const handle = await open(tmp, 'w', mode)
  try {
    await handle.writeFile(data)
    await handle.sync()
  } finally {
    await handle.close()
  }
  await chmod(tmp, mode)
  await rename(tmp, path)
}

export async function writeJsonAtomic(path, value, { mode = 0o600 } = {}) {
  await atomicWrite(path, `${JSON.stringify(value, null, 2)}\n`, mode)
}

export async function writeTextAtomic(path, text, { mode = 0o644 } = {}) {
  await atomicWrite(path, text, mode)
}

/** Cross-process advisory lock via exclusive create; stale locks are reclaimed. */
export async function withLock(lockPath, fn, { staleMs = 6 * 60 * 60 * 1000 } = {}) {
  await mkdir(dirname(lockPath), { recursive: true })
  let handle
  try {
    handle = await open(lockPath, 'wx', 0o600)
    await handle.writeFile(JSON.stringify({ pid: process.pid, at: new Date().toISOString() }))
  } catch (error) {
    if (error?.code !== 'EEXIST') throw error
    let stale = false
    try {
      const info = JSON.parse(await readFile(lockPath, 'utf8'))
      const age = Date.now() - Date.parse(info.at ?? 0)
      stale = !Number.isFinite(age) || age > staleMs
    } catch { stale = true }
    if (!stale) throw new Error(`another vault-sync run holds ${lockPath}`)
    await rm(lockPath, { force: true })
    return withLock(lockPath, fn, { staleMs })
  }
  try {
    return await fn()
  } finally {
    await handle.close().catch(() => {})
    await rm(lockPath, { force: true }).catch(() => {})
  }
}

export async function sha256File(path, { highWaterMark = MIB } = {}) {
  const hash = createHash('sha256')
  for await (const chunk of createReadStream(path, { highWaterMark })) hash.update(chunk)
  return hash.digest('hex')
}

export function sha256Text(text) {
  return createHash('sha256').update(text).digest('hex')
}

export function toPosixPath(value) {
  return value.split(sep).join(posix.sep)
}

export function joinKey(...parts) {
  return parts
    .filter(part => part !== undefined && part !== null && part !== '')
    .map(part => String(part).replace(/^\/+|\/+$/g, ''))
    .filter(Boolean)
    .join('/')
}

/** Run tasks with a hard concurrency ceiling; results keep input order. */
export async function mapLimit(items, limit, worker) {
  const list = [...items]
  const results = new Array(list.length)
  if (list.length === 0) return results
  let cursor = 0
  const size = Math.max(1, Math.min(Math.floor(limit) || 1, list.length))
  const runners = Array.from({ length: size }, async () => {
    for (;;) {
      const index = cursor++
      if (index >= list.length) return
      results[index] = await worker(list[index], index)
    }
  })
  await Promise.all(runners)
  return results
}

/** Glob (** , * , ?) to an anchored RegExp. */
export function globToRegExp(pattern) {
  const normalized = toPosixPath(pattern)
  let out = ''
  for (let i = 0; i < normalized.length; i += 1) {
    const char = normalized[i]
    if (char === '*') {
      if (normalized[i + 1] === '*') {
        const slashAfter = normalized[i + 2] === '/'
        out += slashAfter ? '(?:.*/)?' : '.*'
        i += slashAfter ? 2 : 1
        continue
      }
      out += '[^/]*'
      continue
    }
    if (char === '?') { out += '[^/]'; continue }
    out += char.replace(/[.+^${}()|[\]\\]/g, '\\$&')
  }
  return new RegExp(`^${out}$`)
}

/** Exclude always wins; include (when present) narrows the set first. */
export function pathAllowed(relPath, { include = [], exclude = [] } = {}) {
  const rel = toPosixPath(relPath)
  if (include.length > 0 && !include.some(pattern => globToRegExp(pattern).test(rel))) return false
  for (const pattern of exclude) if (globToRegExp(pattern).test(rel)) return false
  return true
}

export function defaultStateHome(env = process.env) {
  const home = env.DSH_HOME?.trim()
  if (home) return join(home, 'vault-sync')
  return join(env.HOME ?? process.cwd(), '.dsh', 'vault-sync')
}

export function formatBytes(bytes) {
  if (!Number.isFinite(bytes)) return 'unknown'
  const units = ['B', 'KiB', 'MiB', 'GiB', 'TiB']
  let value = bytes
  let unit = 0
  while (value >= 1024 && unit < units.length - 1) { value /= 1024; unit += 1 }
  return `${unit === 0 ? value : value.toFixed(1)} ${units[unit]}`
}

export function redact(value) {
  if (typeof value !== 'string' || value.length === 0) return value
  if (value.length <= 8) return '***'
  return `${value.slice(0, 4)}***${value.slice(-2)}`
}

/** Recursively replace likely secrets so any report can be printed safely. */
export function redactDeep(value, keyPattern = /(secret|password|token|credential|accesskey)/i) {
  if (Array.isArray(value)) return value.map(item => redactDeep(item, keyPattern))
  if (value && typeof value === 'object') {
    const out = {}
    for (const [key, entry] of Object.entries(value)) {
      out[key] = keyPattern.test(key) ? redact(String(entry)) : redactDeep(entry, keyPattern)
    }
    return out
  }
  return value
}

export async function listFiles(dir) {
  const out = []
  const walk = async current => {
    const entries = await readdir(current, { withFileTypes: true })
    for (const entry of entries) {
      const full = join(current, entry.name)
      if (entry.isDirectory()) await walk(full)
      else if (entry.isFile()) out.push(full)
    }
  }
  await walk(dir)
  return out
}
