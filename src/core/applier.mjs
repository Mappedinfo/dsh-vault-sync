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
import { mapLimit } from './util.mjs'

export function createApplier({
  backend,
  backendForSource,
  layout,
  runId,
  sink = () => {},
  maxTempKeysToPrune = 100000,
  publishStrategy = 'direct',
  concurrency = 8,
  archiveFailure = 'warn',
  settingsForSource,
  shouldStop = () => false,
  onProgress = () => {},
} = {}) {
  const failures = []
  let stoppedByRequest = false
  const transportFor = source => (backendForSource ? backendForSource(source) : backend)
  const settingsOf = source => (settingsForSource ? settingsForSource(source) : { concurrency, archiveFailure })

  async function applyItem(item, transport = backend, settings = { archiveFailure }) {
    switch (item.action) {
      case 'skip':
        return { ...item, status: 'skipped' }
      case 'version': {
        const existing = await transport.head(item.key)
        if (!existing) return { ...item, status: 'skipped', note: 'source-already-absent' }
        try {
          await transport.copy(item.key, item.versionKey)
          return { ...item, status: 'applied' }
        } catch (error) {
          if (settings.archiveFailure === 'fail') throw error
          // The historical copy could not be written. Report it, but let the
          // paired upload proceed: losing one archived revision is far less bad
          // than leaving the current file unbacked-up.
          return { ...item, status: 'warning', warning: error instanceof Error ? error.message : String(error) }
        }
      }
      case 'delete': {
        const existing = await transport.head(item.key)
        if (existing) await transport.remove(item.key)
        return { ...item, status: existing ? 'applied' : 'skipped', note: existing ? undefined : 'already-absent' }
      }
      case 'upload': {
        if (!item.localPath) throw new BackendError(`upload item ${item.relPath} has no local path`, { operation: 'upload' })
        // Direct publish: one PUT to the final key, then verify what landed.
        // This avoids depending on server-side CopyObject, which some links and
        // intermediaries handle unreliably, at the cost of a short window where
        // an interrupted transfer could leave a partial object at the final key.
        // The verification below is what closes that window: a size or digest
        // mismatch fails the item, so the next run re-uploads it.
        if (publishStrategy === 'direct') {
          await transport.putFile(item.key, item.localPath, { size: item.size, digest: item.digest })
          const landed = await transport.head(item.key)
          if (!landed || (landed.size !== undefined && landed.size !== item.size)) {
            throw new BackendError(`published object ${item.key} is missing or short`, { operation: 'verify', key: item.key, retryable: true })
          }
          if (landed.digest && landed.digest !== item.digest) {
            throw new BackendError(`published object ${item.key} has digest ${landed.digest}, expected ${item.digest}`, { operation: 'verify', key: item.key })
          }
          return { ...item, status: 'applied', verified: Boolean(landed.digest) }
        }
        const tempKey = layout.tempKey(runId, item.remoteName, item.relPath)
        await transport.putFile(tempKey, item.localPath, { size: item.size, digest: item.digest })
        const written = await transport.head(tempKey)
        if (!written || (written.size !== undefined && written.size !== item.size)) {
          throw new BackendError(`upload verification failed for ${tempKey}`, { operation: 'verify', key: tempKey, retryable: true })
        }
        if (written.digest && written.digest !== item.digest) {
          throw new BackendError(`upload digest mismatch for ${tempKey}`, { operation: 'verify', key: tempKey })
        }
        await transport.copy(tempKey, item.key)
        await transport.remove(tempKey)
        const landed = await transport.head(item.key)
        if (!landed || (landed.size !== undefined && landed.size !== item.size)) {
          throw new BackendError(`published object ${item.key} is missing or short`, { operation: 'verify', key: item.key, retryable: true })
        }
        return { ...item, status: 'applied' }
      }
      default:
        throw new BackendError(`unknown action ${item.action}`, { operation: 'apply' })
    }
  }

  /**
   * Work is grouped per path and the groups run with bounded concurrency.
   *
   * Concurrency is per *file*, never within one: a file's own items keep their
   * planner order, so the archive copy of a replaced version still happens
   * before the new content is published. Files are independent of each other,
   * so overlapping them is safe and is what makes a large library feasible:
   * every request on a tunnelled link costs seconds of setup latency, and
   * running them in series multiplies that by the file count.
   *
   * The bound comes from the source's effective settings, so a collection of
   * large objects can run at a lower concurrency than a tree of small ones in
   * the same round: parallelism that helps many small files starves a few big
   * ones sharing one uplink.
   */
  async function applySource(source, items, { onItem, onGroup } = {}) {
    const groups = []
    const byPath = new Map()
    for (const item of items) {
      const key = item.relPath ?? ''
      if (!byPath.has(key)) { const group = []; byPath.set(key, group); groups.push(group) }
      byPath.get(key).push(item)
    }

    const settings = settingsOf(source)
    const transport = transportFor(source)
    const limit = settings.concurrency === 'auto' ? concurrency : (settings.concurrency ?? concurrency)
    let stopped = false
    const perGroup = await mapLimit(groups, limit, async group => {
      // Checked before claiming a group, never inside one: a file's own
      // archive-then-publish order must run to completion.
      if (stopped) return []
      if (shouldStop()) { stopped = true; stoppedByRequest = true; return [] }
      const results = []
      for (const item of group) {
        const enriched = { ...item, sourceId: source.id, remoteName: source.remote, localPath: item.localPath ?? source.filePaths?.get(item.relPath) }
        try {
          const result = await applyItem(enriched, transport, settings)
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
      onGroup?.(group, results)
      return results
    })
    const flat = perGroup.flat()
    if (stopped) stoppedByRequest = true
    onProgress({ source, settings, planned: groups.length, completed: flat.length, stopped })
    return flat
  }

  async function pruneTempKeys(remoteEntries, transport = backend) {
    const stale = (remoteEntries ?? [])
      .filter(entry => entry.key.startsWith(`${layout.tempRoot}/`))
      .filter(entry => entry.key.slice(layout.tempRoot.length + 1).split('/')[0] !== runId)
      .slice(0, maxTempKeysToPrune)
    const pruned = []
    for (const entry of stale) {
      try {
        await transport.remove(entry.key)
        pruned.push(entry.key)
      } catch { /* reported again next run */ }
    }
    return pruned
  }

  return {
    applyItem,
    applySource,
    pruneTempKeys,
    failures,
    /** True once a stop was requested and observed between groups. */
    get stopped() { return stoppedByRequest },
  }
}
