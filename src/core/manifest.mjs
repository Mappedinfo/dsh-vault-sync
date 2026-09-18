/**
 * Local scan: bounded enumeration, digest computation with an mtime/size cache,
 * and explicit reporting of files that cannot be read or were left out.
 */
import { stat } from 'node:fs/promises'
import { listFiles, mapLimit, pathAllowed, sha256File, toPosixPath } from './util.mjs'

export const DEFAULT_DIGEST_CONCURRENCY = 8
export const DEFAULT_MAX_TOTAL_BYTES = 200 * 1024 * 1024 * 1024

/**
 * @returns {{ files: Array, skipped: Array<{path,reason}>, truncated: boolean, totalBytes: number }}
 */
export async function scanSource(source, {
  previous = {},
  digestConcurrency = DEFAULT_DIGEST_CONCURRENCY,
  maxTotalBytes = DEFAULT_MAX_TOTAL_BYTES,
  onProgress,
} = {}) {
  let absoluteFiles
  try {
    absoluteFiles = await listFiles(source.root)
  } catch (error) {
    if (error?.code === 'ENOENT') return { files: [], skipped: [{ path: source.root, reason: 'missing-root' }], truncated: false, totalBytes: 0 }
    if (error?.code === 'ENOTDIR') return { files: [], skipped: [{ path: source.root, reason: 'not-a-directory' }], truncated: false, totalBytes: 0 }
    throw error
  }

  const candidates = []
  for (const absolute of absoluteFiles) {
    const relPath = toPosixPath(absolute.slice(source.root.length + 1))
    if (!pathAllowed(relPath, { include: source.include, exclude: source.exclude })) continue
    candidates.push({ absolute, relPath })
  }
  candidates.sort((a, b) => (a.relPath < b.relPath ? -1 : a.relPath > b.relPath ? 1 : 0))

  let totalBytes = 0
  let truncated = false
  const skipped = []
  const files = []
  await mapLimit(candidates, digestConcurrency, async candidate => {
    let info
    try {
      info = await stat(candidate.absolute)
    } catch (error) {
      skipped.push({ path: candidate.relPath, reason: `stat:${error.code ?? error.message}` })
      return
    }
    if (info.size > source.maxFileBytes) {
      skipped.push({ path: candidate.relPath, reason: `over-max-file-bytes:${info.size}` })
      return
    }
    if (totalBytes + info.size > maxTotalBytes) {
      truncated = true
      skipped.push({ path: candidate.relPath, reason: 'over-total-bytes' })
      return
    }
    const cached = previous[candidate.relPath]
    let digest
    let digestSource = 'computed'
    if (cached && cached.size === info.size && cached.mtimeMs === info.mtimeMs && typeof cached.digest === 'string') {
      digest = cached.digest
      digestSource = 'index'
    } else {
      try {
        digest = await sha256File(candidate.absolute)
      } catch (error) {
        skipped.push({ path: candidate.relPath, reason: `read:${error.code ?? error.message}` })
        return
      }
    }
    totalBytes += info.size
    files.push({ path: candidate.absolute, relPath: candidate.relPath, size: info.size, mtimeMs: info.mtimeMs, digest, digestSource })
    onProgress?.(files.length, candidates.length)
  })

  files.sort((a, b) => (a.relPath < b.relPath ? -1 : a.relPath > b.relPath ? 1 : 0))
  return { files, skipped, truncated, totalBytes }
}

/** The durable local index the next run compares against. */
export function indexFromManifest(files) {
  const entries = {}
  for (const file of files) entries[file.relPath] = { size: file.size, mtimeMs: file.mtimeMs, digest: file.digest }
  return entries
}
