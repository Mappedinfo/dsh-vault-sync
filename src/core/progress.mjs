/**
 * Live progress for a running backup.
 *
 * A separate transient file, deliberately not the digest index. The index means
 * "what was successfully backed up last run": it advances per source and only
 * for files that fully succeeded, so reading it mid-run cannot show how far the
 * current run has got. A tree of 422 files once had no visible progress at all
 * because the index only flushed every 250 completed files and the next
 * threshold (500) never arrived.
 *
 * Writes are atomic and throttled: progress is a side channel, so a failure to
 * write it must never disturb the run itself.
 */
import { mkdir, readdir, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { pathExists, readJson, writeJsonAtomic } from './util.mjs'

export const DEFAULT_THROTTLE_MS = 2000
export const DEFAULT_MIN_EVENTS = 25

export function createProgressTracker({ stateDir, runId, throttleMs = DEFAULT_THROTTLE_MS, minEvents = DEFAULT_MIN_EVENTS, now = () => Date.now() } = {}) {
  const dir = join(stateDir, 'progress')
  const path = join(dir, `${runId}.json`)
  let lastWrite = 0
  let eventsSinceWrite = 0
  let closed = false
  let writeFailure
  let writes = 0

  const state = {
    runId,
    status: 'running',
    startedAt: new Date(now()).toISOString(),
    updatedAt: undefined,
    totals: { planned: 0, done: 0, uploaded: 0, versioned: 0, deleted: 0, failed: 0, unchanged: 0, bytes: 0, bytesHuman: undefined },
    sources: [],
    ratePerSec: undefined,
    etaSeconds: undefined,
  }

  const counters = {
    plannedAfterScan: new Map(),
    sourceRows: new Map(),
  }

  function describe(bytes) {
    if (!Number.isFinite(bytes)) return 'unknown'
    const units = ['B', 'KiB', 'MiB', 'GiB', 'TiB']
    let value = bytes
    let unit = 0
    while (value >= 1024 && unit < units.length - 1) { value /= 1024; unit += 1 }
    return `${unit === 0 ? value : value.toFixed(1)} ${units[unit]}`
  }

  /** Written at most once per throttle window, and at least every minEvents. */
  async function persist(force = false) {
    if (closed && !force) return
    const stamp = now()
    eventsSinceWrite += 1
    const due = force || eventsSinceWrite >= minEvents || stamp - lastWrite >= throttleMs
    if (!due) return
    lastWrite = stamp
    eventsSinceWrite = 0
    const elapsed = Math.max(1, (stamp - Date.parse(state.startedAt)) / 1000)
    state.updatedAt = new Date(stamp).toISOString()
    state.totals.bytesHuman = describe(state.totals.bytes)
    if (state.totals.done > 0) {
      state.ratePerSec = Math.round((state.totals.done / elapsed) * 100) / 100
      const remaining = state.totals.planned - state.totals.done
      state.etaSeconds = state.ratePerSec > 0 && remaining > 0 ? Math.round(remaining / state.ratePerSec) : null
    }
    state.sources = [...counters.sourceRows.values()]
    try {
      await mkdir(dir, { recursive: true })
      await writeJsonAtomic(path, state, { mode: 0o600 })
      writes += 1
    } catch (error) {
      // Progress is observability, not correctness: record and carry on.
      writeFailure = error instanceof Error ? error.message : String(error)
    }
  }

  return {
    path,
    get lastWriteFailure() { return writeFailure },
    /** Successful writes so far, so throttling can be asserted directly. */
    get writeCount() { return writes },
    state,

    /** A source's scan finished: its planned file count is now known. */
    async sourceScanned(sourceId, fileCount) {
      counters.plannedAfterScan.set(sourceId, fileCount)
      state.totals.planned += fileCount
      const row = counters.sourceRows.get(sourceId) ?? { id: sourceId, scanned: fileCount, done: 0, failed: 0, bytes: 0, currentFile: undefined }
      row.scanned = fileCount
      counters.sourceRows.set(sourceId, row)
      await persist()
    },

    /** One file finished, successfully or not. */
    async fileDone({ sourceId, relPath, status, bytes }) {
      const row = counters.sourceRows.get(sourceId) ?? { id: sourceId, scanned: 0, done: 0, failed: 0, bytes: 0, currentFile: undefined }
      row.currentFile = relPath
      if (status === 'failed') {
        row.failed += 1
        state.totals.failed += 1
      } else {
        row.done += 1
        state.totals.done += 1
        if (status === 'applied') {
          row.bytes += bytes ?? 0
          state.totals.bytes += bytes ?? 0
        }
      }
      counters.sourceRows.set(sourceId, row)
      await persist()
    },

    async finish(status = 'finished') {
      state.status = status
      state.sources = [...counters.sourceRows.values()]
      // A finished run keeps no progress file: the run record carries the result.
      closed = true
      await persist(true)
      if (status === 'finished') {
        await rm(path, { force: true }).catch(() => {})
        return
      }
      // An interrupted or failed run keeps the file, which is exactly when a
      // reader needs to see how far it got and which file it was on.
    },
  }
}

/** Read every progress file, ordered newest first. Pure local disk reads. */
export async function readProgress(stateDir, { now = () => Date.now(), staleAfterMs = 60_000 } = {}) {
  const dir = join(stateDir, 'progress')
  let names = []
  try { names = await readdir(dir) } catch { return [] }
  const rows = []
  for (const name of names.filter(entry => entry.endsWith('.json')).sort()) {
    const document = await readJson(join(dir, name))
    if (!document) continue
    const alive = await processAlive(document, stateDir)
    rows.push({
      ...document,
      stale: document.status === 'running' && !alive,
    })
  }
  void staleAfterMs
  return rows.sort((a, b) => (a.startedAt < b.startedAt ? 1 : -1))
}

/** A 'running' progress file whose owning run lock is gone is stale. */
async function processAlive(document, stateDir) {
  const lock = await readJson(join(stateDir, 'run.lock'))
  if (!lock?.pid) return false
  try {
    process.kill(lock.pid, 0)
    return true
  } catch {
    return false
  }
}

/** Remove progress files for runs that are no longer active. */
export async function pruneProgress(stateDir, { maxAgeMs = 24 * 60 * 60 * 1000, now = () => Date.now() } = {}) {
  const dir = join(stateDir, 'progress')
  let names = []
  try { names = await readdir(dir) } catch { return 0 }
  let removed = 0
  for (const name of names.filter(entry => entry.endsWith('.json'))) {
    const path = join(dir, name)
    const document = await readJson(path)
    const age = document?.updatedAt ? now() - Date.parse(document.updatedAt) : Infinity
    const active = document?.status === 'running' && (await processAlive(document, stateDir))
    if (!active && age > maxAgeMs) { await rm(path, { force: true }); removed += 1 }
  }
  return removed
}

export { pathExists }
