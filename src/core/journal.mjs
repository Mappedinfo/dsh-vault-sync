/**
 * Durable run journal and local digest index. Everything is owner-only and
 * crash-safe (atomic replace), so an interrupted run can be audited and resumed.
 */
import { mkdir, readdir, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { readJson, withLock, writeJsonAtomic } from './util.mjs'

export function createJournal({ stateDir, localRuns = 200 }) {
  const runsDir = join(stateDir, 'runs')
  const indexDir = join(stateDir, 'index')
  const lockPath = join(stateDir, 'run.lock')
  const indexPath = sourceId => join(indexDir, `${sourceId}.json`)

  return {
    stateDir,
    runsDir,
    lockPath,

    lock: (fn, options) => withLock(lockPath, fn, options),

    async beginRun(record) {
      await mkdir(runsDir, { recursive: true })
      const path = join(runsDir, `${record.runId}.json`)
      await writeJsonAtomic(path, { status: 'running', startedAt: new Date().toISOString(), ...record })
      return path
    },

    async updateRun(runId, patch) {
      const path = join(runsDir, `${runId}.json`)
      const current = (await readJson(path)) ?? { runId }
      await writeJsonAtomic(path, { ...current, ...patch })
    },

    readRun: runId => readJson(join(runsDir, `${runId}.json`)),

    async listRuns(limit = 20) {
      let names = []
      try { names = await readdir(runsDir) } catch { return [] }
      const ids = names
        .filter(name => name.endsWith('.json') && !name.includes('.tmp-'))
        .map(name => name.slice(0, -5))
        .sort()
        .reverse()
        .slice(0, Math.max(1, Math.min(limit, 200)))
      const out = []
      for (const id of ids) out.push(await readJson(join(runsDir, `${id}.json`)))
      return out.filter(Boolean)
    },

    async pruneRuns() {
      let names = []
      try { names = await readdir(runsDir) } catch { return 0 }
      const ids = names
        .filter(name => name.endsWith('.json') && !name.includes('.tmp-'))
        .map(name => name.slice(0, -5))
        .sort()
        .reverse()
      const extra = ids.slice(localRuns)
      for (const id of extra) await rm(join(runsDir, `${id}.json`), { force: true })
      return extra.length
    },

    async readIndex(sourceId) {
      return (await readJson(indexPath(sourceId))) ?? { sourceId, entries: {} }
    },

    async writeIndex(sourceId, entries) {
      await writeJsonAtomic(indexPath(sourceId), { sourceId, updatedAt: new Date().toISOString(), entries })
    },
  }
}
