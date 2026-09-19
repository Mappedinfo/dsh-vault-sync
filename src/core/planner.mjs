/**
 * Pure planner: local manifest + remote state + previous index -> ordered work.
 * No I/O happens here, so every branch is unit-testable on synthetic inputs.
 */
export function indexRemote(entries) {
  const map = new Map()
  for (const entry of entries ?? []) map.set(entry.key, entry)
  return map
}

/**
 * @param {object} input
 * @param {Array} input.files             local manifest rows ({ relPath, size, digest })
 * @param {Array} input.remote            remote listing rows ({ key, size, digest? })
 * @param {object} input.layout           key layout from createLayout()
 * @param {string} input.remoteName       source.remote prefix segment
 * @param {object} input.previous         previous local index ({ relPath: { digest, size } })
 * @param {string} input.stamp            backup date stamp (YYYY-MM-DD)
 * @param {boolean} input.allowRemoteDelete
 */
export function planSource({ files, remote, layout, remoteName, previous = {}, stamp, allowRemoteDelete = true }) {
  const remoteByKey = indexRemote(remote)
  const currentPrefix = `${layout.currentPrefix(remoteName)}/`
  const tempRoot = `${layout.tempRoot}/`
  const items = []
  const localKeys = new Set()

  for (const file of files ?? []) {
    const key = layout.currentKey(remoteName, file.relPath)
    localKeys.add(key)
    const existing = remoteByKey.get(key)
    const prior = previous[file.relPath]
    if (!existing) {
      items.push({
        action: 'upload',
        relPath: file.relPath,
        key,
        size: file.size,
        digest: file.digest,
        reason: prior ? 'remote-missing-despite-index' : 'new-file',
      })
      continue
    }
    const sameSize = existing.size === file.size
    const sameDigest = Boolean(existing.digest) && existing.digest === file.digest
    const digestDisagrees = Boolean(existing.digest) && existing.digest !== file.digest
    const managed = Boolean(prior)
    // A one-way backup must not destroy a good copy because it could not prove
    // it was identical. Content differs only when the size changed or when the
    // transport reports a digest that disagrees. When the transport cannot
    // report digests (rclone remote, or an object written by another tool) a
    // same-size file is left in place and reported as unverified rather than
    // claimed as identical, and never re-uploaded on every run.
    if (sameSize && !digestDisagrees) {
      items.push({
        action: 'skip',
        relPath: file.relPath,
        key,
        size: file.size,
        digest: file.digest,
        remoteDigest: existing.digest,
        verified: sameDigest,
        reason: sameDigest ? 'digest-match' : 'size-match-unverified',
      })
      continue
    }
    items.push({
      action: 'version',
      relPath: file.relPath,
      key,
      size: existing.size,
      digest: existing.digest,
      versionKey: layout.versionKey(stamp, remoteName, file.relPath),
      reason: digestDisagrees ? (managed ? 'local-modified' : 'content-differs') : 'size-changed',
    })
    items.push({ action: 'upload', relPath: file.relPath, key, size: file.size, digest: file.digest, reason: 'replaced-remote' })
  }

  for (const entry of remote ?? []) {
    if (!entry.key.startsWith(currentPrefix)) continue
    if (entry.key.startsWith(tempRoot)) continue
    const relPath = entry.key.slice(currentPrefix.length)
    if (!relPath) continue
    if (localKeys.has(entry.key)) continue
    if (previous[relPath]) {
      // The local file was deleted (or renamed) since the last successful run.
      if (allowRemoteDelete) {
        items.push({ action: 'version', relPath, key: entry.key, size: entry.size, digest: entry.digest, versionKey: layout.versionKey(stamp, remoteName, relPath), reason: 'local-deleted' })
        items.push({ action: 'delete', relPath, key: entry.key, size: entry.size, digest: entry.digest, reason: 'local-deleted' })
      } else {
        // Append-only source: the local file is gone but its remote copy is
        // history and stays. Reported so the reader can see it was noticed.
        items.push({ action: 'skip', relPath, key: entry.key, size: entry.size, remoteOnly: true, reason: 'local-deleted-keep-remote' })
      }
      continue
    }
    items.push({ action: 'skip', relPath, key: entry.key, size: entry.size, remoteOnly: true, reason: 'remote-only-unmanaged' })
  }

  const skipped = items.filter(item => item.action === 'skip')
  const stats = {
    local: (files ?? []).length,
    remoteListed: (remote ?? []).length,
    upload: items.filter(item => item.action === 'upload').length,
    version: items.filter(item => item.action === 'version').length,
    delete: items.filter(item => item.action === 'delete').length,
    // `unchanged` means a local file whose mirrored copy is up to date. It uses
    // the same name and meaning as the run report, so plan and run agree.
    unchanged: skipped.filter(item => item.remoteOnly !== true).length,
    skip: skipped.length,
    remoteOnly: skipped.filter(item => item.remoteOnly === true).length,
    unchangedUnverified: skipped.filter(item => item.remoteOnly !== true && item.verified === false).length,
    bytesToUpload: items.filter(item => item.action === 'upload').reduce((sum, item) => sum + (item.size ?? 0), 0),
  }
  return { items, stats }
}

/** The index the next run compares against: exactly the local manifest. */
export function nextIndex(files) {
  const entries = {}
  for (const file of files ?? []) {
    if (file.relPath) entries[file.relPath] = { size: file.size, mtimeMs: file.mtimeMs, digest: file.digest }
  }
  return entries
}

/**
 * Flatten one source's plan into a report row. Explicit keys are written after
 * the spread so a stats field can never overwrite the source identity.
 */
export function summarizePlan(sources) {
  return sources.map(source => ({
    ...source.stats,
    id: source.id,
    root: source.root,
    remote: source.remote,
    scanned: source.files.length,
    skippedLocal: source.skipped.length,
  }))
}

/** Temp keys left behind by runs that are no longer active. */
export function orphanTempKeys(remoteKeys, layout, activeRunId) {
  const root = `${layout.tempRoot}/`
  return (remoteKeys ?? []).filter(entry => {
    if (!entry.key.startsWith(root)) return false
    const owner = entry.key.slice(root.length).split('/')[0]
    return Boolean(owner) && owner !== activeRunId
  })
}

/** Deterministic even sampling for bounded verification. */
export function sampleEvenly(items, sample) {
  if (!Number.isSafeInteger(sample) || sample <= 0 || items.length <= sample) return [...items]
  const step = items.length / sample
  const out = []
  for (let i = 0; i < sample; i += 1) out.push(items[Math.floor(i * step)])
  return out
}
