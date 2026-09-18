/** Engine facade: scan -> plan -> apply -> verify -> restore. */
import { createFilesystemBackend } from '../backends/filesystem.mjs'
import { createRcloneBackend } from '../backends/rclone.mjs'
import { createS3Backend } from '../backends/s3.mjs'
import { assertBackend, createLayout } from './backend.mjs'
import { resolveCredentials } from './credentials.mjs'
import { createJournal } from './journal.mjs'
import { indexFromManifest, scanSource } from './manifest.mjs'
import { createApplier } from './applier.mjs'
import { nextIndex, planSource, sampleEvenly, summarizePlan } from './planner.mjs'
import { formatBytes, newRunId, versionStamp } from './util.mjs'

const RCLONE_NOTE = 'rclone transport: digest metadata is unavailable, so unchanged-but-unverified files are reported as size-match-unverified'

/** Resolve the configured transport and say which engine was chosen, and why. */
export async function createBackend(config, { credentials, env = process.env } = {}) {
  const remote = config.remote
  if (remote.type === 'filesystem') {
    return { backend: createFilesystemBackend({ root: remote.root }), engine: 'filesystem', notes: [] }
  }
  if (remote.type === 'rclone') {
    if (!remote.rcloneRemote) throw new Error('remote.type=rclone requires remote.rcloneRemote')
    return {
      backend: createRcloneBackend({ remote: remote.rcloneRemote, binary: remote.rcloneBinary, timeoutSeconds: remote.timeoutSeconds, retries: remote.retries }),
      engine: 'rclone',
      notes: [RCLONE_NOTE],
    }
  }
  const creds = credentials ?? await resolveCredentials({ configDir: config.stateDir, env })
  const rcloneRemote = remote.rcloneRemote ?? creds.rcloneRemote
  if (remote.engine === 'rclone' || (remote.engine === 'auto' && rcloneRemote)) {
    if (!rcloneRemote) throw new Error('remote.engine=rclone but no rclone remote name is configured')
    return {
      backend: createRcloneBackend({ remote: rcloneRemote, binary: remote.rcloneBinary, timeoutSeconds: remote.timeoutSeconds, retries: remote.retries }),
      engine: 'rclone',
      notes: [RCLONE_NOTE],
    }
  }
  const missing = []
  if (!(remote.bucket ?? creds.bucket)) missing.push('bucket')
  if (!(remote.endpoint ?? creds.endpoint)) missing.push('endpoint')
  if (!creds.accessKeyId) missing.push('accessKeyId')
  if (!creds.accessKeySecret) missing.push('accessKeySecret')
  if (missing.length) {
    const error = new Error(`OSS remote is not configured: missing ${missing.join(', ')}. Put them in ${creds.envFilePath} (mode 0600) or the environment.`)
    error.code = 'REMOTE_NOT_CONFIGURED'
    error.missing = missing
    throw error
  }
  return {
    backend: createS3Backend({
      accessKeyId: creds.accessKeyId,
      accessKeySecret: creds.accessKeySecret,
      sessionToken: creds.sessionToken,
      endpoint: remote.endpoint ?? creds.endpoint,
      region: remote.region ?? creds.region ?? 'us-east-1',
      bucket: remote.bucket ?? creds.bucket,
      retries: remote.retries,
      timeoutSeconds: remote.timeoutSeconds,
    }),
    engine: 'native-s3',
    notes: [],
  }
}

export function createEngine({ config, backend, journal = createJournal({ stateDir: config.stateDir, localRuns: config.localRuns }), now = () => new Date(), onProgress } = {}) {
  assertBackend(backend)
  const layout = createLayout(config.remote)

  const selectSources = only => {
    if (!only || only.length === 0) return config.sources
    const wanted = new Set(only)
    const unknown = [...wanted].filter(id => !config.sources.some(source => source.id === id))
    if (unknown.length) throw new Error(`unknown source id(s): ${unknown.join(', ')}`)
    return config.sources.filter(source => wanted.has(source.id))
  }

  async function scanAll(sources) {
    const out = []
    for (const source of sources) {
      const index = await journal.readIndex(source.id)
      const scan = await scanSource(source, {
        previous: index.entries ?? {},
        onProgress: onProgress ? (done, total) => onProgress({ phase: 'scan', sourceId: source.id, done, total }) : undefined,
      })
      out.push({ source, scan })
    }
    return out
  }

  /** Read-only planning. Never writes to the remote or to the library. */
  async function plan({ only, stamp } = {}) {
    const sources = selectSources(only)
    const scanned = await scanAll(sources)
    const entries = {}
    let tempKeys = 0
    for (const { source, scan } of scanned) {
      const prefix = layout.currentPrefix(source.remote)
      const listing = await backend.list(prefix)
      tempKeys += listing.filter(entry => entry.key.startsWith(`${layout.tempRoot}/`)).length
      const previous = (await journal.readIndex(source.id)).entries ?? {}
      const result = planSource({
        files: scan.files,
        remote: listing,
        layout,
        remoteName: source.remote,
        previous,
        stamp: stamp ?? versionStamp(now()),
        allowRemoteDelete: config.remote.allowRemoteDelete,
      })
      entries[source.id] = { source, scan, listing, previous, ...result }
    }
    const summary = summarizePlan(Object.values(entries).map(entry => ({
      id: entry.source.id,
      root: entry.source.root,
      remote: entry.source.remote,
      files: entry.scan.files,
      skipped: entry.scan.skipped,
      stats: entry.stats,
    })))
    return { entries, summary, totals: totalStats(summary), tempKeys }
  }

  async function run({ only, dryRun = false, sink } = {}) {
    const stamp = versionStamp(now())
    const runId = newRunId(now())
    return journal.lock(async () => {
      const planned = await plan({ only, stamp })
      const runRecord = {
        runId,
        stamp,
        dryRun,
        engine: backend.describe?.().kind,
        startedAt: new Date().toISOString(),
        sources: planned.summary,
      }
      if (dryRun) return { runId, dryRun: true, plan: planned, record: runRecord }

      const runPath = await journal.beginRun(runRecord)
      const applier = createApplier({ backend, layout, runId, sink })
      const perSource = []
      let tempPruned = []
      try {
        // One root listing covers temp-key cleanup and an object count for the
        // run record; a transport that cannot list the root still syncs.
        let rootListing = []
        try { rootListing = await backend.list('') } catch { rootListing = [] }
        tempPruned = await applier.pruneTempKeys(rootListing)
        for (const entry of Object.values(planned.entries)) {
          const source = entry.source
          const scan = entry.scan
          const filePaths = new Map(scan.files.map(file => [file.relPath, file.path]))
          const results = await applier.applySource({ id: source.id, remote: source.remote, filePaths }, entry.items)
          const applied = results.filter(result => result.status === 'applied')
          const failed = results.filter(result => result.status === 'failed')
          perSource.push({
            id: source.id,
            remote: source.remote,
            root: source.root,
            scanned: scan.files.length,
            skippedLocal: scan.skipped,
            uploaded: applied.filter(item => item.action === 'upload').length,
            versioned: applied.filter(item => item.action === 'version').length,
            deleted: applied.filter(item => item.action === 'delete').length,
            unchanged: results.filter(item => item.action === 'skip' && !item.remoteOnly).length,
            bytesUploaded: applied.filter(item => item.action === 'upload').reduce((sum, item) => sum + (item.size ?? 0), 0),
            failed: failed.map(item => ({ relPath: item.relPath, action: item.action, error: item.error, retryable: item.retryable })),
          })
          // The index advances only for a source whose work fully succeeded, so a
          // partial run never claims a failed file is already backed up.
          if (failed.length === 0) await journal.writeIndex(source.id, nextIndex(scan.files))
          await journal.updateRun(runId, { sources: perSource, tempPruned: tempPruned.length })
        }
        const totals = totalStats(perSource)
        const prunedRuns = await journal.pruneRuns()
        await journal.updateRun(runId, {
          status: totals.failed > 0 ? 'partial' : 'ok',
          finishedAt: new Date().toISOString(),
          totals,
          tempPruned: tempPruned.length,
          prunedRuns,
        })
        return { runId, stamp, runPath, engine: backend.describe(), tempPruned, perSource, totals, record: await journal.readRun(runId) }
      } catch (error) {
        await journal.updateRun(runId, { status: 'failed', finishedAt: new Date().toISOString(), error: error instanceof Error ? error.message : String(error) })
        throw error
      }
    })
  }

  /** Compare local content against the mirrored copy. */
  async function verify({ only, sample } = {}) {
    const sources = selectSources(only)
    const report = []
    let checked = 0
    for (const source of sources) {
      const prefix = `${layout.currentPrefix(source.remote)}/`
      const listing = await backend.list(prefix)
      const remoteByPath = new Map()
      for (const entry of listing) if (entry.key.startsWith(prefix)) remoteByPath.set(entry.key.slice(prefix.length), entry)
      const index = (await journal.readIndex(source.id)).entries ?? {}
      const scan = await scanSource(source, { previous: index })
      const sampleFiles = sampleEvenly(scan.files, sample)
      const missing = []
      const sizeMismatch = []
      const digestMismatch = []
      let digestUnavailable = 0
      for (const file of sampleFiles) {
        checked += 1
        const entry = remoteByPath.get(file.relPath)
        if (!entry) { missing.push(file.relPath); continue }
        if (entry.size !== file.size) { sizeMismatch.push({ relPath: file.relPath, local: file.size, remote: entry.size }); continue }
        // A bucket listing carries no user metadata, so ask the object directly
        // before reporting a file as unverifiable.
        let digest = entry.digest
        if (!digest) {
          try { digest = (await backend.head(entry.key))?.digest } catch { digest = undefined }
        }
        if (digest) {
          if (digest !== file.digest) digestMismatch.push({ relPath: file.relPath, local: file.digest, remote: digest })
        } else digestUnavailable += 1
      }
      const localPaths = new Set(scan.files.map(file => file.relPath))
      const remoteOnly = [...remoteByPath.keys()].filter(relPath => !localPaths.has(relPath))
      report.push({
        id: source.id,
        remote: source.remote,
        root: source.root,
        local: scan.files.length,
        remoteTotal: remoteByPath.size,
        checked: sampleFiles.length,
        missing,
        sizeMismatch,
        digestMismatch,
        digestUnavailable,
        remoteOnly: remoteOnly.slice(0, 50),
        remoteOnlyCount: remoteOnly.length,
        unreadable: scan.skipped,
        ok: missing.length === 0 && sizeMismatch.length === 0 && digestMismatch.length === 0,
      })
    }
    return { checked, sources: report, ok: report.every(entry => entry.ok) }
  }

  /** Locate a current object or a dated archived version. */
  async function restore({ sourceId, relPath, stamp }) {
    const source = config.sources.find(entry => entry.id === sourceId)
    if (!source) throw new Error(`unknown source id: ${sourceId}`)
    if (typeof relPath !== 'string' || !relPath) throw new Error('relPath is required')
    const currentKey = layout.currentKey(source.remote, relPath)
    const versionsPrefix = `${layout.versionsRoot}/`
    const candidates = []
    for (const entry of await backend.list(versionsPrefix)) {
      if (!entry.key.startsWith(versionsPrefix)) continue
      const rest = entry.key.slice(versionsPrefix.length)
      const [restStamp, restRemote, ...tail] = rest.split('/')
      if (restRemote !== source.remote || tail.join('/') !== relPath) continue
      candidates.push({ key: entry.key, kind: 'version', stamp: restStamp, size: entry.size })
    }
    candidates.sort((a, b) => (a.stamp < b.stamp ? 1 : -1))
    if (stamp) {
      const exact = candidates.filter(candidate => candidate.stamp === stamp)
      if (exact.length === 0) {
        throw new Error(`no archived version of ${sourceId}:${relPath} dated ${stamp} (available: ${candidates.map(c => c.stamp).join(', ') || 'none'})`)
      }
      return { sourceId, relPath, chose: exact[0], currentKey, candidates, note: 'copy the reported key with `rclone copy` or `ossutil cp`; this plugin never downloads by itself' }
    }
    const head = await backend.head(currentKey)
    return {
      sourceId,
      relPath,
      currentKey,
      currentPresent: Boolean(head),
      currentSize: head?.size,
      candidates,
      note: 'pass --stamp YYYY-MM-DD to pin a version; copy a reported key with rclone copy or ossutil cp',
    }
  }

  async function status({ runs = 10 } = {}) {
    const [recent, listings] = await Promise.all([
      journal.listRuns(runs),
      Promise.all(config.sources.map(async source => {
        const index = await journal.readIndex(source.id)
        const listing = await backend.list(layout.currentPrefix(source.remote))
        const entries = Object.values(index.entries ?? {})
        const bytes = entries.reduce((sum, entry) => sum + (entry.size ?? 0), 0)
        return {
          id: source.id,
          root: source.root,
          remote: source.remote,
          indexed: entries.length,
          indexedBytes: bytes,
          indexedBytesHuman: formatBytes(bytes),
          remoteObjects: listing.filter(entry => !entry.key.startsWith(`${layout.tempRoot}/`)).length,
          lastIndexedAt: index.updatedAt,
        }
      })),
    ])
    return { engine: backend.describe(), stateDir: config.stateDir, sources: listings, runs: recent }
  }

  function totalStats(list) {
    const totals = { scanned: 0, upload: 0, version: 0, delete: 0, unchanged: 0, skippedLocal: 0, failed: 0, bytesUploaded: 0 }
    for (const entry of list) {
      totals.scanned += entry.scanned ?? entry.local ?? 0
      totals.upload += entry.uploaded ?? entry.upload ?? 0
      totals.version += entry.versioned ?? entry.version ?? 0
      totals.delete += entry.deleted ?? entry.delete ?? 0
      totals.unchanged += entry.unchanged ?? 0
      const skippedLocal = entry.skippedLocal
      totals.skippedLocal += Array.isArray(skippedLocal) ? skippedLocal.length : (skippedLocal ?? 0)
      totals.failed += Array.isArray(entry.failed) ? entry.failed.length : (entry.failed ?? 0)
      totals.bytesUploaded += entry.bytesUploaded ?? entry.bytesToUpload ?? 0
    }
    totals.bytesUploadedHuman = formatBytes(totals.bytesUploaded)
    return totals
  }

  return {
    config,
    backend,
    layout,
    journal,
    plan,
    run,
    verify,
    restore,
    status,
    totalStats,
    writeIndex: (id, entries) => journal.writeIndex(id, entries),
    indexFromManifest,
  }
}

export { formatBytes, indexFromManifest, planSource, scanSource }
