/**
 * Per-source transport tuning. One set of values cannot serve both a tree of
 * notebook-sized files and a collection of large objects: this deployment lost
 * 65 large uploads to a client timeout that had been tuned for small files.
 *
 * Two settings build a transport (timeoutSeconds, retries); concurrency is a
 * scheduling decision handled by the applier. The tests below pin that split,
 * because getting it wrong is what silently ignored the override.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { join } from 'node:path'
import { normalizeConfig } from '../src/core/config.mjs'
import { createEngine } from '../src/core/engine.mjs'
import { createFilesystemBackend } from '../src/backends/filesystem.mjs'
import { cleanup, filesystemConfig, tempDir, writeFiles } from './helpers.mjs'

/** Build a filesystem transport that records peaks, keyed to a source. */
function instrumentedFactory(root, peaks, { delayMs = 0 } = {}) {
  return () => {
    const backend = createFilesystemBackend({ root })
    const state = { active: 0, peak: 0, sourceId: undefined }
    return {
      describe: () => backend.describe(),
      list: (...args) => backend.list(...args),
      head: (...args) => backend.head(...args),
      copy: (...args) => backend.copy(...args),
      remove: (...args) => backend.remove(...args),
      readText: (...args) => backend.readText(...args),
      async putFile(key, localPath, options) {
        const sourceId = key.split('/')[1]
        state.active += 1
        state.peak = Math.max(state.peak, state.active)
        peaks[sourceId] = Math.max(peaks[sourceId] ?? 0, state.peak)
        try {
          if (delayMs > 0) await new Promise(resolve => setTimeout(resolve, delayMs))
          return await backend.putFile(key, localPath, options)
        } finally {
          state.active -= 1
        }
      },
    }
  }
}

test('a single shared backend is reused for every source when nothing overrides it', async () => {
  // Regression guard: an existing deployment passes one backend and must keep
  // using exactly that instance, with no factory calls at all.
  const root = await tempDir('vault-single-')
  try {
    const a = join(root, 'a')
    const b = join(root, 'b')
    await writeFiles(a, { 'x.txt': 'x' })
    await writeFiles(b, { 'y.txt': 'y' })
    const config = normalizeConfig(filesystemConfig({
      stateDir: join(root, 'state'),
      remoteRoot: join(root, 'remote'),
      sources: [{ id: 'a', root: a, remote: 'a' }, { id: 'b', root: b, remote: 'b' }],
    }))
    const backend = createFilesystemBackend({ root: join(root, 'remote') })
    let factoryCalls = 0
    const engine = createEngine({
      config,
      backend,
      backendFactory: () => { factoryCalls += 1; return createFilesystemBackend({ root: join(root, 'remote') }) },
      now: () => new Date('2026-06-01T00:00:00Z'),
    })
    const result = await engine.run({})
    assert.equal(result.totals.upload, 2)
    assert.equal(factoryCalls, 0, 'the shared instance must cover sources with no transport override')
    // The objects landed through the caller's own backend.
    const listed = await backend.list('')
    assert.equal(listed.filter(entry => entry.key.startsWith('current/')).length, 2)
  } finally {
    await cleanup(root)
  }
})

test('two sources with different timeout policies get two transports', async () => {
  const root = await tempDir('vault-two-')
  try {
    const big = join(root, 'big')
    const small = join(root, 'small')
    await writeFiles(big, { 'a.txt': 'a' })
    await writeFiles(small, { 'b.txt': 'b' })
    const config = normalizeConfig(filesystemConfig({
      stateDir: join(root, 'state'),
      remoteRoot: join(root, 'remote'),
      sources: [
        { id: 'big', root: big, remote: 'big', timeoutSeconds: 1800 },
        { id: 'small', root: small, remote: 'small', timeoutSeconds: 60 },
      ],
    }))
    const requested = []
    const engine = createEngine({
      config,
      backendFactory: settings => { requested.push(settings); return createFilesystemBackend({ root: join(root, 'remote') }) },
      now: () => new Date('2026-06-01T00:00:00Z'),
    })
    const result = await engine.run({})
    assert.equal(result.totals.upload, 2)
    assert.equal(requested.length, 2, `expected one transport per policy, got ${requested.length}`)
    assert.deepEqual(requested.map(s => s.timeoutSeconds).sort((x, y) => x - y), [60, 1800])
  } finally {
    await cleanup(root)
  }
})

test('concurrency is per source and does not require a transport override', async () => {
  // concurrency is scheduling, not transport: a source can lower it without
  // raising its own timeout. The factory is supplied so each source gets its own
  // instrumented transport to observe the actual peak; the shared instance would
  // otherwise serve both and hide the difference.
  const root = await tempDir('vault-concurrency-')
  try {
    const slow = join(root, 'slow')
    const fast = join(root, 'fast')
    const files = {}
    for (let i = 0; i < 12; i += 1) files[`f${String(i).padStart(2, '0')}.txt`] = `payload-${i}`
    await writeFiles(slow, files)
    await writeFiles(fast, files)

    const config = normalizeConfig(filesystemConfig({
      stateDir: join(root, 'state'),
      remoteRoot: join(root, 'remote'),
      sources: [
        // A transport override is what makes each source get its own transport;
        // the concurrency values under test are independent of it.
        { id: 'slow', root: slow, remote: 'slow', concurrency: 2, timeoutSeconds: 30 },
        { id: 'fast', root: fast, remote: 'fast', concurrency: 8, timeoutSeconds: 60 },
      ],
    }))
    const peaks = {}
    const engine = createEngine({
      config,
      backendFactory: instrumentedFactory(join(root, 'remote'), peaks, { delayMs: 15 }),
      now: () => new Date('2026-06-01T00:00:00Z'),
    })
    const result = await engine.run({})
    assert.equal(result.totals.upload, 24)
    assert.equal(peaks.slow, 2, `slow source must respect its own bound, saw ${peaks.slow}`)
    assert.ok(peaks.fast > 2, `fast source should exceed the slow bound, saw ${peaks.fast}`)
    assert.ok(peaks.fast <= 8, `fast source must respect its own bound, saw ${peaks.fast}`)
  } finally {
    await cleanup(root)
  }
})

test('a transport override without a factory fails loudly instead of being ignored', async () => {
  const root = await tempDir('vault-nofactory-')
  try {
    const a = join(root, 'a')
    await writeFiles(a, { 'x.txt': 'x' })
    const config = normalizeConfig(filesystemConfig({
      stateDir: join(root, 'state'),
      remoteRoot: join(root, 'remote'),
      sources: [{ id: 'a', root: a, remote: 'a', timeoutSeconds: 1800 }],
    }))
    const backend = createFilesystemBackend({ root: join(root, 'remote') })
    // Refused at construction: a run that silently ignored the override would be
    // much harder to diagnose than a refusal that names the source.
    assert.throws(
      () => createEngine({ config, backend, now: () => new Date('2026-06-01T00:00:00Z') }),
      /sources a override timeoutSeconds\/retries but no backendFactory/,
    )
  } finally {
    await cleanup(root)
  }
})

test('the plan reports each source\'s effective transfer settings', async () => {
  const root = await tempDir('vault-effective-')
  try {
    const a = join(root, 'a')
    await writeFiles(a, { 'x.txt': 'x' })
    const config = normalizeConfig(filesystemConfig({
      stateDir: join(root, 'state'),
      remoteRoot: join(root, 'remote'),
      sources: [{ id: 'a', root: a, remote: 'a', concurrency: 3, timeoutSeconds: 900, retries: 1 }],
    }))
    const engine = createEngine({ config, backendFactory: () => createFilesystemBackend({ root: join(root, 'remote') }), now: () => new Date('2026-06-01T00:00:00Z') })
    const plan = await engine.plan({})
    assert.deepEqual(plan.summary[0].effective, {
      allowRemoteDelete: true,
      concurrency: 3,
      timeoutSeconds: 900,
      retries: 1,
      publishStrategy: 'direct',
      archiveFailure: 'warn',
    })
  } finally {
    await cleanup(root)
  }
})

test('createBackends prepares one transport per policy and reports the engine once', async () => {
  const root = await tempDir('vault-factory-')
  try {
    const a = join(root, 'a')
    const b = join(root, 'b')
    const c = join(root, 'c')
    await writeFiles(a, { 'x.txt': 'x' })
    await writeFiles(b, { 'y.txt': 'y' })
    await writeFiles(c, { 'z.txt': 'z' })
    const config = normalizeConfig(filesystemConfig({
      stateDir: join(root, 'state'),
      remoteRoot: join(root, 'remote'),
      sources: [
        { id: 'a', root: a, remote: 'a', timeoutSeconds: 900 },
        { id: 'b', root: b, remote: 'b', timeoutSeconds: 900 },
        { id: 'c', root: c, remote: 'c', timeoutSeconds: 60 },
      ],
    }))
    const { createBackends } = await import('../src/core/engine.mjs')
    const built = await createBackends(config, { credentials: {} })
    assert.equal(built.backends.size, 3)
    // a and b share a policy, so they must share one instance.
    assert.equal(built.backends.get('a'), built.backends.get('b'))
    assert.notEqual(built.backends.get('a'), built.backends.get('c'))
    assert.equal(built.engine, 'filesystem')

    // The engine can then run every source through the prepared set.
    const engine = createEngine({ config, backends: built.backends, backendFactory: built.backendFactory, now: () => new Date('2026-06-01T00:00:00Z') })
    const result = await engine.run({})
    assert.equal(result.totals.upload, 3)
    assert.equal(result.totals.failed, 0)
  } finally {
    await cleanup(root)
  }
})
