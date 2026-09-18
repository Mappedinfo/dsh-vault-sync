/**
 * Executor for planner output.
 *
 * Crash safety comes from ordering, never from a rollback:
 *   1. archive the replaced or deleted version into versions/<date>/... (server-side copy);
 *   2. upload the new content to a run-scoped temp key and verify size and digest;
 *   3. server-side copy temp -> current, then delete the temp key.
 * A crash between 1 and 3 can only leave a recoverable version copy plus a
 * missing current key; the next run re-uploads that file. Temp keys from dead
 * runs are pruned explicitly and counted in the run record.
 */
import { BackendError } from './backend.mjs'

export function createApplier({ backend, layout, runId, sink = () => {}, maxTempKeysToPrune = 100000 } = {}) {
  const failures = []

  async function applyItem(item) {
    switch (item.action) {
      case 'skip':
        return { ...item, status: 'skipped' }
      case 'version': {
        const existing = await backend.head(item.key)
        if (!existing) return { ...item, status: 'skipped', note: 'source-already-absent' }
        await backend.copy(item.key, item.versionKey)
        return { ...item, status: 'applied' }
      }
      case 'delete': {
        const existing = await backend.head(item.key)
        if (existing) await backend.remove(item.key)
        return { ...item, status: existing ? 'applied' : 'skipped', note: existing ? undefined : 'already-absent' }
      }
      case 'upload': {
        const tempKey = layout.tempKey(runId, item.remoteName, item.relPath)
        if (!item.localPath) throw new BackendError(`upload item ${item.relPath} has no local path`, { operation: 'upload' })
        await backend.putFile(tempKey, item.localPath, { size: item.size, digest: item.digest })
        const written = await backend.head(tempKey)
        if (!written || (written.size !== undefined && written.size !== item.size)) {
          throw new BackendError(`upload verification failed for ${tempKey}`, { operation: 'verify', key: tempKey, retryable: true })
        }
        if (written.digest && written.digest !== item.digest) {
          throw new BackendError(`upload digest mismatch for ${tempKey}`, { operation: 'verify', key: tempKey })
        }
        await backend.copy(tempKey, item.key)
        await backend.remove(tempKey)
        const landed = await backend.head(item.key)
        if (!landed || (landed.size !== undefined && landed.size !== item.size)) {
          throw new BackendError(`published object ${item.key} is missing or short`, { operation: 'verify', key: item.key, retryable: true })
        }
        return { ...item, status: 'applied' }
      }
      default:
        throw new BackendError(`unknown action ${item.action}`, { operation: 'apply' })
    }
  }

  /** One source runs serially so archive-before-overwrite ordering always holds. */
  async function applySource(source, items, { onItem } = {}) {
    const results = []
    for (const item of items) {
      const enriched = { ...item, sourceId: source.id, remoteName: source.remote, localPath: item.localPath ?? source.filePaths?.get(item.relPath) }
      try {
        const result = await applyItem(enriched)
        results.push(result)
        sink(result)
        onItem?.(result)
      } catch (error) {
        const failure = { ...enriched, status: 'failed', error: error instanceof Error ? error.message : String(error), retryable: Boolean(error?.retryable) }
        failures.push(failure)
        results.push(failure)
        sink(failure)
        onItem?.(failure)
      }
    }
    return results
  }

  async function pruneTempKeys(remoteEntries) {
    const stale = (remoteEntries ?? [])
      .filter(entry => entry.key.startsWith(`${layout.tempRoot}/`))
      .filter(entry => entry.key.slice(layout.tempRoot.length + 1).split('/')[0] !== runId)
      .slice(0, maxTempKeysToPrune)
    const pruned = []
    for (const entry of stale) {
      try {
        await backend.remove(entry.key)
        pruned.push(entry.key)
      } catch { /* reported again next run */ }
    }
    return pruned
  }

  return { applyItem, applySource, pruneTempKeys, failures }
}
