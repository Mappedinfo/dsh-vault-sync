/**
 * Engine behaviour on synthetic trees: first upload, idempotent re-run,
 * overwrite versioning, local-delete versioning, resume after an interrupted
 * run, stale temp-key pruning, verification and restore addressing.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile, rm, writeFile, mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import { createEngine } from '../src/core/engine.mjs'
import { createFilesystemBackend } from '../src/backends/filesystem.mjs'
import { cleanup, filesystemConfig, tempDir, writeFiles } from './helpers.mjs'

async function harness(name) {
  const root = await tempDir(`vault-sync-${name}-`)
  const library = join(root, 'library')
  const kg = join(root, 'kg')
  const remoteRoot = join(root, 'remote')
  const stateDir = join(root, 'state')
  await mkdir(library, { recursive: true })
  await mkdir(kg, { recursive: true })
  const config = filesystemConfig({
    stateDir,
    remoteRoot,
    sources: [
      { id: 'papers', root: library, remote: 'papers', kind: 'paper-library', exclude: ['backups/**'] },
      { id: 'kg', root: kg, remote: 'kg' },
    ],
  })
  const backend = createFilesystemBackend({ root: remoteRoot })
  // A frozen clock keeps version folders deterministic across runs.
  const engine = createEngine({ config, backend, now: () => new Date('2026-03-04T01:02:03Z') })
  return { root, library, kg, remoteRoot, stateDir, config, backend, engine }
}

test('first run uploads exactly the eligible local files', async () => {
  const h = await harness('first')
  try {
    await writeFiles(h.library, { '2024/a.pdf': 'aaa', '2024/b.pdf': 'bbbb' })
    await writeFiles(h.library, { 'backups/skip-me.pdf': 'zzz' })
    await writeFiles(h.kg, { 'graph.json': '{"a":1}' })
    const result = await h.engine.run({})
    assert.equal(result.totals.failed, 0)
    assert.equal(result.totals.upload, 3)
    assert.deepEqual((await h.backend.list('')).map(e => e.key).sort(), [
      'current/kg/graph.json',
      'current/papers/2024/a.pdf',
      'current/papers/2024/b.pdf',
    ])
  } finally { await cleanup(h.root) }
})

test('a second run changes nothing (idempotent) and leaves no temp keys', async () => {
  const h = await harness('idempotent')
  try {
    await writeFiles(h.library, { 'x.pdf': 'content-one' })
    await h.engine.run({})
    const second = await h.engine.run({})
    assert.equal(second.totals.upload, 0)
    assert.equal(second.totals.version, 0)
    assert.equal(second.totals.delete, 0)
    assert.equal(second.totals.unchanged, 1)
    assert.equal(second.tempPruned.length, 0)
    const keys = (await h.backend.list('')).map(e => e.key)
    assert.ok(!keys.some(key => key.startsWith('incoming/')), `temp keys leaked: ${keys.join(',')}`)
  } finally { await cleanup(h.root) }
})

test('a modified file is archived before it is overwritten', async () => {
  const h = await harness('modified')
  try {
    await writeFiles(h.library, { 'x.pdf': 'version-one' })
    await h.engine.run({})
    await writeFile(join(h.library, 'x.pdf'), 'version-two-different')
    const result = await h.engine.run({})
    assert.equal(result.totals.upload, 1)
    assert.equal(result.totals.version, 1)
    assert.equal(await h.backend.readText('current/papers/x.pdf'), 'version-two-different')
    assert.equal(await h.backend.readText('versions/2026-03-04/papers/x.pdf'), 'version-one')
  } finally { await cleanup(h.root) }
})

test('a deleted local file is archived and removed from the mirror', async () => {
  const h = await harness('deleted')
  try {
    await writeFiles(h.library, { 'keep.pdf': 'keep', 'gone.pdf': 'gone' })
    await h.engine.run({})
    await rm(join(h.library, 'gone.pdf'))
    const result = await h.engine.run({})
    assert.equal(result.totals.delete, 1)
    assert.equal(result.totals.version, 1)
    assert.equal(await h.backend.head('current/papers/gone.pdf'), undefined)
    assert.equal(await h.backend.readText('versions/2026-03-04/papers/gone.pdf'), 'gone')
    assert.ok(await h.backend.head('current/papers/keep.pdf'))
  } finally { await cleanup(h.root) }
})

test('allowRemoteDelete=false keeps remote-only files instead of deleting them', async () => {
  const h = await harness('nodelete')
  try {
    await writeFiles(h.library, { 'gone.pdf': 'gone' })
    await h.engine.run({})
    await rm(join(h.library, 'gone.pdf'))
    const engine = createEngine({
      config: { ...h.config, remote: { ...h.config.remote, allowRemoteDelete: false } },
      backend: h.backend,
      now: () => new Date('2026-03-04T01:02:03Z'),
    })
    const result = await engine.run({})
    assert.equal(result.totals.delete, 0)
    assert.ok(await h.backend.head('current/papers/gone.pdf'))
  } finally { await cleanup(h.root) }
})

test('a run that lost the remote copy re-uploads it (resume)', async () => {
  const h = await harness('resume')
  try {
    await writeFiles(h.library, { 'x.pdf': 'payload' })
    await h.engine.run({})
    // Simulate a crash after archiving but before publishing the new object.
    await h.backend.remove('current/papers/x.pdf')
    const plan = await h.engine.plan({})
    assert.equal(plan.entries.papers.items.filter(item => item.action === 'upload').length, 1)
    const result = await h.engine.run({})
    assert.equal(result.totals.upload, 1)
    assert.equal(await h.backend.readText('current/papers/x.pdf'), 'payload')
  } finally { await cleanup(h.root) }
})

test('temp keys left by a dead run are pruned and reported', async () => {
  const h = await harness('temp')
  try {
    await writeFiles(h.library, { 'x.pdf': 'payload' })
    await mkdir(join(h.remoteRoot, 'incoming/dead-run/papers'), { recursive: true })
    await writeFile(join(h.remoteRoot, 'incoming/dead-run/papers/x.pdf'), 'partial')
    const result = await h.engine.run({})
    assert.ok(result.tempPruned.some(key => key.startsWith('incoming/dead-run/')))
    assert.equal(await h.backend.head('incoming/dead-run/papers/x.pdf'), undefined)
  } finally { await cleanup(h.root) }
})

test('verify reports a missing remote copy and a tampered digest', async () => {
  const h = await harness('verify')
  try {
    await writeFiles(h.library, { 'x.pdf': 'trusted', 'y.pdf': 'other' })
    await h.engine.run({})
    const clean = await h.engine.verify({})
    assert.equal(clean.ok, true)

    await rm(join(h.remoteRoot, 'current/papers/x.pdf'))
    const missing = await h.engine.verify({})
    assert.equal(missing.ok, false)
    assert.deepEqual(missing.sources[0].missing, ['x.pdf'])

    // Replace y.pdf behind the engine's back: same size, different content, and
    // the sidecar digest no longer matches.
    await writeFile(join(h.remoteRoot, 'current/papers/y.pdf'), 'other')
    const meta = JSON.parse(await readFile(join(h.remoteRoot, '.vault-sync-meta.json'), 'utf8'))
    meta.objects['current/papers/y.pdf'].digest = 'deadbeef'
    await writeFile(join(h.remoteRoot, '.vault-sync-meta.json'), JSON.stringify(meta, null, 2))
    const backend = createFilesystemBackend({ root: h.remoteRoot })
    const engine = createEngine({ config: h.config, backend, now: () => new Date('2026-03-04T01:02:03Z') })
    const tampered = await engine.verify({})
    assert.equal(tampered.ok, false)
    assert.equal(tampered.sources[0].digestMismatch.length, 1)
  } finally { await cleanup(h.root) }
})

test('restore resolves the current key and dated versions', async () => {
  const h = await harness('restore')
  try {
    await writeFiles(h.library, { 'x.pdf': 'first' })
    await h.engine.run({})
    await writeFile(join(h.library, 'x.pdf'), 'second')
    await h.engine.run({})
    const current = await h.engine.restore({ sourceId: 'papers', relPath: 'x.pdf' })
    assert.equal(current.currentPresent, true)
    assert.equal(current.candidates.length, 1)
    assert.equal(current.candidates[0].key, 'versions/2026-03-04/papers/x.pdf')
    const pinned = await h.engine.restore({ sourceId: 'papers', relPath: 'x.pdf', stamp: '2026-03-04' })
    assert.equal(pinned.chose.stamp, '2026-03-04')
    await assert.rejects(() => h.engine.restore({ sourceId: 'papers', relPath: 'x.pdf', stamp: '1999-01-01' }), /1999-01-01/)
    await assert.rejects(() => h.engine.restore({ sourceId: 'nope', relPath: 'x.pdf' }), /unknown source/)
  } finally { await cleanup(h.root) }
})

test('a dry run performs no remote writes and leaves no run record', async () => {
  const h = await harness('dryrun')
  try {
    await writeFiles(h.library, { 'x.pdf': 'payload' })
    const result = await h.engine.run({ dryRun: true })
    assert.equal(result.dryRun, true)
    assert.equal((await h.backend.list('')).length, 0)
    assert.equal((await h.engine.journal.listRuns()).length, 0)
  } finally { await cleanup(h.root) }
})

test('an oversized file is reported and skipped, not silently dropped', async () => {
  const h = await harness('maxbytes')
  try {
    await writeFiles(h.library, { 'big.pdf': 'x'.repeat(64), 'small.pdf': 'ok' })
    const config = { ...h.config, sources: [{ ...h.config.sources[0], maxFileBytes: 32 }, h.config.sources[1]] }
    const engine = createEngine({ config, backend: h.backend, now: () => new Date('2026-03-04T01:02:03Z') })
    const result = await engine.run({ only: ['papers'] })
    assert.equal(result.totals.upload, 1)
    assert.equal(result.perSource[0].skippedLocal.length, 1)
    assert.match(result.perSource[0].skippedLocal[0].reason, /over-max-file-bytes/)
  } finally { await cleanup(h.root) }
})

test('a failed source does not advance its index', async () => {
  const h = await harness('indexfail')
  try {
    await writeFiles(h.library, { 'x.pdf': 'payload' })
    const failing = {
      describe: () => ({ kind: 'failing' }),
      list: async () => [],
      head: async () => undefined,
      putFile: async () => { throw new Error('network down') },
      copy: async () => {},
      remove: async () => {},
    }
    const engine = createEngine({ config: h.config, backend: failing, now: () => new Date('2026-03-04T01:02:03Z') })
    const result = await engine.run({ only: ['papers'] })
    assert.equal(result.totals.failed, 1)
    assert.equal(result.record.status, 'partial')
    const index = await engine.journal.readIndex('papers')
    assert.deepEqual(index.entries, {})
  } finally { await cleanup(h.root) }
})

test('concurrent runs are refused by the run lock', async () => {
  const h = await harness('lock')
  try {
    await writeFiles(h.library, { 'x.pdf': 'payload' })
    let release
    const gate = new Promise(resolve => { release = resolve })
    const first = h.engine.journal.lock(async () => { await gate; return 'first' })
    await new Promise(resolve => setTimeout(resolve, 20))
    await assert.rejects(() => h.engine.run({}), /another vault-sync run holds/)
    release()
    assert.equal(await first, 'first')
  } finally { await cleanup(h.root) }
})
