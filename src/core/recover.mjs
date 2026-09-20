/**
 * Rebuild local data from the remote mirror.
 *
 * This is the other half of a backup. Without it the mirror can only be read
 * with external tools, which is exactly what it is meant to make unnecessary on
 * a new machine.
 *
 * Two rules keep it from destroying what is already on disk:
 *   1. Nothing is ever deleted at the target. A target that already has files is
 *      merged into, not replaced.
 *   2. Every download lands in a sibling `.part` file, is verified against the
 *      digest the mirror recorded, and only then is renamed into place. An
 *      interrupted or corrupt download leaves no trace at the destination.
 */
import { createHash } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { mkdir, rename, rm, stat } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { mapLimit } from './util.mjs'

export const DEFAULT_RECOVER_CONCURRENCY = 4
/** Objects whose disposition is decided without any remote call beyond the listing. */
export function isUnsafeRelativePath(relPath) {
  if (typeof relPath !== 'string' || relPath.length === 0) return true
  if (relPath.startsWith('/') || /^[A-Za-z]:/.test(relPath) || relPath.includes('\\')) return true
  if (relPath.includes('\u0000')) return true
  return relPath.split('/').some(segment => segment === '' || segment === '.' || segment === '..')
}

async function sha256OfFile(path) {
  const hash = createHash('sha256')
  for await (const chunk of createReadStream(path)) hash.update(chunk)
  return hash.digest('hex')
}

/**
 * Decide what would be written for one source. Pure with respect to the remote:
 * it reads the listing it is given and stats the target directory.
 *
 * @param {object} input
 * @param {object} input.source        configured source (its `remote` names the prefix)
 * @param {object} input.layout        key layout
 * @param {Array}  input.listing       remote rows under the source prefix
 * @param {string} input.target        absolute destination root
 * @param {boolean} [input.force]      re-download even when the local digest matches
 * @param {number} [input.concurrency] bound on the stat/digest comparisons
 */
export async function planRecoverSource({ source, layout, listing, target, force = false, concurrency = 8 }) {
  const prefix = `${layout.currentPrefix(source.remote)}/`
  const candidates = []
  const unsafe = []
  const seen = new Map()

  for (const entry of listing ?? []) {
    if (!entry.key.startsWith(prefix)) continue
    if (entry.key.startsWith(`${layout.tempRoot}/`)) continue
    const relPath = entry.key.slice(prefix.length)
    if (!relPath) continue
    if (isUnsafeRelativePath(relPath)) { unsafe.push({ key: entry.key, reason: 'unsafe-relative-path' }); continue }
    // The destination mirrors the remote layout exactly, source prefix included.
    // Dropping the prefix would let two sources claim the same local path and
    // silently overwrite each other, and it would reconstruct a tree that does
    // not match where the files came from.
    const outPath = `${source.remote}/${relPath}`
    if (isUnsafeRelativePath(outPath)) { unsafe.push({ key: entry.key, reason: 'unsafe-relative-path' }); continue }
    // Two objects mapping to one local path would silently overwrite each other.
    const clash = seen.get(outPath)
    if (clash && clash !== entry.key) { unsafe.push({ key: entry.key, reason: `collides-with ${clash}` }); continue }
    seen.set(outPath, entry.key)
    candidates.push({ ...entry, relPath, outPath, localPath: join(target, ...outPath.split('/')) })
  }

  const items = await mapLimit(candidates, concurrency, async entry => {
    let existing
    try { existing = await stat(entry.localPath) } catch { existing = undefined }
    if (!existing) return { ...entry, action: 'download', reason: 'missing-locally' }
    if (existing.isDirectory()) return { ...entry, action: 'skip', reason: 'local-path-is-a-directory' }
    if (existing.size !== entry.size) return { ...entry, action: 'download', reason: 'size-differs' }
    if (force) return { ...entry, action: 'download', reason: 'forced' }
    // Size alone cannot prove equality when the listing carries no digest, so the
    // local file is hashed and compared against what the mirror recorded.
    if (!entry.digest) return { ...entry, action: 'skip', reason: 'same-size-no-digest-to-compare' }
    const localDigest = await sha256OfFile(entry.localPath)
    return localDigest === entry.digest
      ? { ...entry, action: 'skip', reason: 'digest-match' }
      : { ...entry, action: 'download', reason: 'digest-differs' }
  })

  const stats = {
    remote: candidates.length,
    download: items.filter(item => item.action === 'download').length,
    skip: items.filter(item => item.action === 'skip').length,
    unsafe: unsafe.length,
    bytes: items.filter(item => item.action === 'download').reduce((sum, item) => sum + (item.size ?? 0), 0),
  }
  return { items, unsafe, stats }
}

/**
 * Write the planned items. Bounded, resumable by construction (a completed file
 * is renamed into place and will be skipped by the next plan) and stop-aware.
 */
export async function applyRecover(source, items, {
  backend,
  target,
  sink = () => {},
  shouldStop = () => false,
  concurrency = DEFAULT_RECOVER_CONCURRENCY,
  onArchived = 'fail',
} = {}) {
  const results = []
  const toWrite = items.filter(item => item.action === 'download')
  let stopped = false
  const perItem = await mapLimit(toWrite, concurrency, async item => {
    if (stopped) return []
    if (shouldStop()) { stopped = true; return [] }
    let written
    try {
      await mkdir(dirname(item.localPath), { recursive: true })
      written = await backend.downloadFile(item.key, item.localPath, { expectedDigest: item.digest })
      // Verify here as well, not only inside the transport. The destination is
      // what is being rebuilt: if a transport could not compare digests, bytes
      // that do not match the mirror would otherwise be renamed into place and
      // reported as a successful recovery.
      if (item.digest && written.digest && written.digest !== item.digest) {
        await rm(written.localPath, { force: true })
        return [{ ...item, status: 'corrupt', error: `digest ${written.digest} != recorded ${item.digest}` }]
      }
      // Compare the size as well, so a truncated body is caught even when the
      // transport could not check anything.
      if (item.size !== undefined && written.size !== item.size) {
        await rm(written.localPath, { force: true })
        return [{ ...item, status: 'corrupt', error: `size ${written.size} != expected ${item.size}` }]
      }
      await rename(written.localPath, item.localPath)
      return [{ ...item, status: 'downloaded', bytes: written.size }]
    } catch (error) {
      // Whatever was half-written belongs to the run, not to the destination, so
      // it is removed on every failure path: a partial file must never survive a
      // failure, and the destination must never hold unverified bytes.
      if (written?.localPath) await rm(written.localPath, { force: true }).catch(() => {})
      await rm(`${item.localPath}.part-${process.pid}`, { force: true }).catch(() => {})
      const kind = error?.kind
      // An archived object cannot be read until OSS thaws it. Surviving that
      // silently would leave a half-recovered tree that looks complete, so the
      // default is to stop and say so rather than report success.
      if (kind === 'archived') {
        if (onArchived === 'fail') throw error
        const row = { ...item, status: 'archived', error: error.message }
        sink(row)
        return [row]
      }
      // The bytes on the wire did not match the mirror. That is a corrupt
      // download, not a transport hiccup, so it is not retried blindly.
      if (kind === 'digest-mismatch') {
        const row = { ...item, status: 'corrupt', error: error.message }
        sink(row)
        return [row]
      }
      const failure = { ...item, status: 'failed', error: error instanceof Error ? error.message : String(error) }
      sink(failure)
      return [failure]
    }
  })
  for (const batch of perItem) for (const row of batch ?? []) results.push(row)
  const summary = {
    id: source.id,
    target,
    planned: items.length,
    downloaded: results.filter(row => row.status === 'downloaded').length,
    skipped: items.filter(item => item.action === 'skip').length,
    archived: results.filter(row => row.status === 'archived').length,
    corrupt: results.filter(row => row.status === 'corrupt').length,
    failed: results.filter(row => row.status === 'failed').length,
    bytes: results.filter(row => row.status === 'downloaded').reduce((sum, row) => sum + (row.bytes ?? 0), 0),
    stopped,
  }
  return { results, summary }
}

export { sha256OfFile }
