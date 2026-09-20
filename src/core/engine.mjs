/** Engine facade: scan -> plan -> apply -> verify -> restore. */
import { createFilesystemBackend } from '../backends/filesystem.mjs'
import { createRcloneBackend } from '../backends/rclone.mjs'
import { createS3Backend } from '../backends/s3.mjs'
import { assertBackend, createLayout } from './backend.mjs'
import { effectiveSourceSettings } from './config.mjs'
import { resolveCredentials } from './credentials.mjs'
import { createJournal } from './journal.mjs'
import { indexFromManifest, scanSource } from './manifest.mjs'
import { createApplier } from './applier.mjs'
import { createProgressTracker, pruneProgress, readProgress } from './progress.mjs'
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
  const creds = credentials ?? await resolveCredentials({ configDir: config.credentialsFile ? undefined : config.stateDir, filePath: config.credentialsFile, env })
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

/**
 * Build one transport per distinct transfer policy, plus a factory the engine
 * uses lazily for any policy it meets later. Sources that do not override
 * timeoutSeconds or retries all resolve to the same policy and therefore share
 * a single instance, so a deployment with no overrides still creates exactly one
 * transport.
 */
export async function createBackends(config, { credentials, env = process.env } = {}) {
  const resolved = credentials ?? await resolveCredentials({
    configDir: config.credentialsFile ? undefined : config.stateDir,
    filePath: config.credentialsFile,
    env,
  })
  const created = new Map()
  const build = async settings => {
    const remote = { ...config.remote, timeoutSeconds: settings.timeoutSeconds, retries: settings.retries }
    const { backend, engine, notes } = await createBackend({ ...config, remote }, { credentials: resolved, env })
    return { backend, engine, notes }
  }
  const bySource = new Map()
  const notes = new Set()
  let engineKind
  for (const source of config.sources) {
    const settings = effectiveSourceSettings(source, config.remote)
    const key = `${settings.timeoutSeconds}:${settings.retries}`
    if (!created.has(key)) created.set(key, await build(settings))
    const built = created.get(key)
    bySource.set(source.id, built.backend)
    for (const note of built.notes ?? []) notes.add(note)
    engineKind ??= built.engine
  }
  return {
    backends: bySource,
    backendFactory: settings => {
      // The factory is synchronous by contract; reuse an already built policy or
      // build it once more for a policy the eager pass did not see.
      const key = `${settings.timeoutSeconds}:${settings.retries}`
      if (created.has(key)) return created.get(key).backend
      throw new Error(`transport policy ${key} was not prepared; build it eagerly with createBackends`)
    },
    engine: engineKind,
    notes: [...notes],
  }
}

export function createEngine({
  config,
  backend,
  backends,
  backendFactory,
  journal = createJournal({ stateDir: config.stateDir, localRuns: config.localRuns }),
  now = () => new Date(),
  onProgress,
} = {}) {
  const settingsFor = source => effectiveSourceSettings(source, config.remote)
  const layout = createLayout(config.remote)

  // A transport only carries its timeout and retry budget; the key layout, the
  // credentials and the endpoint are identical for every source. So a deployment
  // with no per-source overrides resolves every source to the same policy and
  // therefore to the very same instance, and behaves exactly as it did before
  // per-source transports existed. A source that promises large files can raise
  // its own timeout without affecting the small-file sources in the same run.
  const shared = backend
  if (shared) assertBackend(shared)
  const cache = new Map()
  // A source inherits the shared transport unless it explicitly overrides one of
  // the two settings a transport is built from. Deciding that from the source's
  // own fields (rather than from resolved equality) keeps the rule easy to state
  // and impossible to get wrong when two sources happen to share values.
  const overridesTransport = source => source.timeoutSeconds !== undefined || source.retries !== undefined
  if (!backendFactory && !backends) {
    // Nothing can build a second transport, so a source's timeout or retry
    // override cannot be honoured. Refuse up front rather than silently falling
    // back to the shared instance, which would hide a misconfiguration behind a
    // slow or failing run.
    const overriding = config.sources.filter(overridesTransport)
    if (overriding.length > 0) {
      throw new Error(`sources ${overriding.map(source => source.id).join(', ')} override timeoutSeconds/retries but no backendFactory was supplied; pass backends or a backendFactory so each source gets its own transport`)
    }
    if (shared) for (const source of config.sources) cache.set(source.id, shared)
  } else if (backends) {
    for (const [sourceId, instance] of backends) {
      const source = config.sources.find(entry => entry.id === sourceId)
      if (!source) continue
      assertBackend(instance)
      cache.set(source.id, instance)
    }
  } else if (shared) {
    for (const source of config.sources) if (!overridesTransport(source)) cache.set(source.id, shared)
  }

  const backendFor = source => {
    const cached = cache.get(source.id)
    if (cached) return cached
    if (!backendFactory) throw new Error(`source ${source.id} overrides timeoutSeconds/retries but no backend factory was supplied`)
    const created = backendFactory(settingsFor(source))
    assertBackend(created)
    cache.set(source.id, created)
    return created
  }

  const firstBackend = () => {
    if (config.sources.length > 0) return backendFor(config.sources[0])
    if (shared) return shared
    throw new Error('no sources are configured, so there is no transport to use')
  }

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
      // One source must not take the round down with it. A source can fail on its
      // own transport (an unreachable endpoint, an expired credential, a listing
      // that keeps timing out) while the others are perfectly healthy, and the
      // healthy ones should still be backed up. The failure is recorded on the
      // source so it is impossible to miss in the report.
      try {
        const prefix = layout.currentPrefix(source.remote)
        const listing = await backendFor(source).list(prefix)
        tempKeys += listing.filter(entry => entry.key.startsWith(`${layout.tempRoot}/`)).length
        const previous = (await journal.readIndex(source.id)).entries ?? {}
        const settings = settingsFor(source)
        const result = planSource({
          files: scan.files,
          remote: listing,
          layout,
          remoteName: source.remote,
          previous,
          stamp: stamp ?? versionStamp(now()),
          allowRemoteDelete: settings.allowRemoteDelete,
        })
        entries[source.id] = {
          source,
          scan,
          listing,
          previous,
          settings,
          remoteDelete: settings.allowRemoteDelete,
          ...result,
        }
      } catch (error) {
        entries[source.id] = {
          source,
          scan,
          settings: settingsFor(source),
          remoteDelete: settingsFor(source).allowRemoteDelete,
          items: [],
          stats: { local: scan.files.length, remoteListed: 0, upload: 0, version: 0, delete: 0, skip: 0, unchanged: 0, remoteOnly: 0, unchangedUnverified: 0, bytesToUpload: 0 },
          error: error instanceof Error ? error.message : String(error),
        }
      }
    }
    const summary = summarizePlan(Object.values(entries).map(entry => ({
      id: entry.source.id,
      root: entry.source.root,
      remote: entry.source.remote,
      files: entry.scan.files,
      skipped: entry.scan.skipped,
      stats: entry.stats,
    }))).map((row, index) => {
      const entry = Object.values(entries)[index]
      return { ...row, remoteDelete: entry.remoteDelete, effective: entry.settings, ...(entry.error ? { error: entry.error } : {}) }
    })
    return { entries, summary, totals: totalStats(summary), tempKeys }
  }

  async function run({ only, dryRun = false, sink, control = {} } = {}) {
    const stamp = versionStamp(now())
    const runId = newRunId(now())
    const shouldStop = typeof control.shouldStop === 'function' ? control.shouldStop : () => false
    return journal.lock(async () => {
      const planned = await plan({ only, stamp })
      const runRecord = {
        runId,
        stamp,
        dryRun,
        engine: firstBackend()?.describe?.().kind,
        startedAt: new Date().toISOString(),
        sources: planned.summary,
      }
      if (dryRun) return { runId, dryRun: true, plan: planned, record: runRecord }

      const runPath = await journal.beginRun(runRecord)
      await pruneProgress(config.stateDir)
      const tracker = createProgressTracker({ stateDir: config.stateDir, runId, now: () => now().getTime() })
      // The planned count is only known after each source is scanned.
      for (const entry of Object.values(planned.entries)) {
        await tracker.sourceScanned(entry.source.id, entry.scan.files.length)
      }
      const applier = createApplier({
        backend,
        backendForSource: backendFor,
        settingsForSource: settingsFor,
        layout,
        runId,
        sink,
        publishStrategy: config.remote.publishStrategy,
        concurrency: config.remote.concurrency,
        archiveFailure: config.remote.archiveFailure,
        shouldStop,
      })
      const perSource = []
      let tempPruned = []
      try {
        // Dead-run temp keys live under the temp prefix, which is not inside any
        // source prefix, so cleaning them needs its own listing. It is scoped to
        // that prefix instead of listing the whole bucket, which matters when the
        // bucket holds tens of thousands of objects.
        let tempListing = []
        try { tempListing = await firstBackend().list(layout.tempRoot) } catch { tempListing = [] }
        tempPruned = await applier.pruneTempKeys(tempListing, firstBackend())
        for (const entry of Object.values(planned.entries)) {
          const source = entry.source
          const scan = entry.scan
          // Planning failed for this source, so there is nothing to apply. Its
          // health is reported through perSource[].error below.
          if (entry.error) {
            perSource.push({
              id: source.id,
              remote: source.remote,
              root: source.root,
              scanned: scan.files.length,
              skippedLocal: scan.skipped,
              uploaded: 0, versioned: 0, deleted: 0, unchanged: 0, bytesUploaded: 0,
              failed: [],
              archiveWarnings: [],
              error: entry.error,
            })
            await journal.updateRun(runId, { sources: perSource, tempPruned: tempPruned.length })
            continue
          }
          const filePaths = new Map(scan.files.map(file => [file.relPath, file.path]))
          // Persist the digest index as work completes, not only at the end of a
          // source. A run that dies at 99% (a hung proxy, a lost link, a reboot)
          // would otherwise restart by re-hashing the whole tree, because the
          // index never advanced. Every callback writes the same complete-file
          // map, so a partially finished run still records durable progress.
          const indexEntries = {}
          const completed = new Set()
          // The configured source travels through with its own fields intact:
          // the applier resolves this source's effective transfer policy from it,
          // so a flattened copy without the overrides would silently fall back to
          // the remote defaults.
          const results = await applier.applySource({ ...source, filePaths }, entry.items, {
            onItem: item => {
              // Every finished file advances progress, including failures: the
              // point of the file is to answer "how far has this got", and a run
              // stuck retrying one object must be visible as such.
              void tracker.fileDone({ sourceId: source.id, relPath: item.relPath, status: item.status, bytes: item.size })
            },
            onGroup: (group, groupResults) => {
              const relPath = group[0]?.relPath
              if (!relPath) return
              const failed = groupResults.some(result => result.status === 'failed')
              if (!failed) {
                completed.add(relPath)
                const file = scan.files.find(entry => entry.relPath === relPath)
                if (file) indexEntries[relPath] = { size: file.size, mtimeMs: file.mtimeMs, digest: file.digest }
              }
              if (completed.size % 250 === 0) void journal.writeIndex(source.id, { ...indexEntries })
            },
          })
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
            archiveWarnings: results.filter(item => item.status === 'warning').map(item => ({ relPath: item.relPath, versionKey: item.versionKey, warning: item.warning })),
            ...(entry.error ? { error: entry.error } : {}),
          })
          // The index advances only for a source whose work fully succeeded, so a
          // partial run never claims a failed file is already backed up. A source
          // whose planning failed is recorded with its error and its index is left
          // alone, so the next run retries it from a known state. A stopped run is
          // the same case: the files it never reached were not uploaded, so
          // advancing to the full scan would claim work that did not happen.
          const stoppedHere = applier.stopped
          if (failed.length === 0 && !entry.error && !stoppedHere) await journal.writeIndex(source.id, nextIndex(scan.files))
          await journal.updateRun(runId, { sources: perSource, tempPruned: tempPruned.length })
          if (applier.stopped) {
            // Stop scheduling new sources too: the point of a graceful stop is to
            // land a consistent record, not to keep spending the link.
            const remaining = Object.values(planned.entries).filter(item => !perSource.some(row => row.id === item.source.id))
            for (const item of remaining) {
              perSource.push({
                id: item.source.id,
                remote: item.source.remote,
                root: item.source.root,
                scanned: item.scan.files.length,
                skippedLocal: item.scan.skipped,
                uploaded: 0, versioned: 0, deleted: 0, unchanged: 0, bytesUploaded: 0,
                failed: [],
                archiveWarnings: [],
                pending: true,
              })
            }
            break
          }
        }
        const totals = totalStats(perSource)
        const prunedRuns = await journal.pruneRuns()
        // A source that failed to plan counts as a failed item so the round is
        // reported as partial rather than as a clean success.
        totals.failed += perSource.filter(row => row.error).length
        totals.pending = perSource.filter(row => row.pending).length
        // A requested stop outranks a partial result: "interrupted" tells a reader
        // the round was cut short on purpose, not that something went wrong.
        const interrupted = applier.stopped || shouldStop()
        totals.interrupted = interrupted
        await journal.updateRun(runId, {
          status: interrupted ? 'interrupted' : (totals.failed > 0 ? 'partial' : 'ok'),
          finishedAt: new Date().toISOString(),
          totals,
          tempPruned: tempPruned.length,
          prunedRuns,
        })
        await tracker.finish(interrupted ? 'interrupted' : (totals.failed > 0 ? 'partial' : 'finished'))
        return { runId, stamp, runPath, progressPath: tracker.path, interrupted, engine: firstBackend().describe(), tempPruned, perSource, totals, record: await journal.readRun(runId) }
      } catch (error) {
        await journal.updateRun(runId, { status: 'failed', finishedAt: new Date().toISOString(), error: error instanceof Error ? error.message : String(error) })
        // Keep the progress file on failure: this is exactly when a reader needs
        // to know how far the run got and which file it was on.
        await tracker.finish('failed').catch(() => {})
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
      const transport = backendFor(source)
      const listing = await transport.list(prefix)
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
          try { digest = (await transport.head(entry.key))?.digest } catch { digest = undefined }
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
    const transport = backendFor(source)
    for (const entry of await transport.list(versionsPrefix)) {
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
    const head = await transport.head(currentKey)
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

  /**
   * @param {boolean} [options.remote] also list each remote prefix. A listing
   *   is cheap per call but proportional to the object count, so the local view
   *   (index + run ledger) is the default and costs nothing beyond disk reads.
   */
  async function status({ runs = 10, remote = false } = {}) {
    const recent = await journal.listRuns(runs)
    const sources = await Promise.all(config.sources.map(async source => {
      const index = await journal.readIndex(source.id)
      const entries = Object.values(index.entries ?? {})
      const bytes = entries.reduce((sum, entry) => sum + (entry.size ?? 0), 0)
      const row = {
        id: source.id,
        root: source.root,
        remote: source.remote,
        indexed: entries.length,
        indexedBytes: bytes,
        indexedBytesHuman: formatBytes(bytes),
        lastIndexedAt: index.updatedAt,
      }
      if (remote) {
        const listing = await backendFor(source).list(layout.currentPrefix(source.remote))
        row.remoteObjects = listing.filter(entry => !entry.key.startsWith(`${layout.tempRoot}/`)).length
      }
      return row
    }))
    // Progress is read from disk, so a caller can watch a long run without
    // touching the remote: a listing is billed and proportional to object count.
    const progress = await readProgress(config.stateDir)
    return { engine: firstBackend().describe(), stateDir: config.stateDir, remoteListed: remote, sources, runs: recent, progress }
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
      totals.archiveWarnings = (totals.archiveWarnings ?? 0) + (Array.isArray(entry.archiveWarnings) ? entry.archiveWarnings.length : 0)
      totals.bytesUploaded += entry.bytesUploaded ?? entry.bytesToUpload ?? 0
    }
    totals.bytesUploadedHuman = formatBytes(totals.bytesUploaded)
    return totals
  }

  return {
    config,
    backend,
    layout,
    progress: () => readProgress(config.stateDir),
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
