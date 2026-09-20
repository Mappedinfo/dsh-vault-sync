/**
 * Rebuilding local data from the mirror.
 *
 * A backup that cannot be restored is half a backup, so recover gets the same
 * treatment as the upload path: the destructive outcomes here are a wrong file
 * silently replacing a good one, and a half-recovered tree being reported as
 * complete. Both are pinned below.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile, readdir, rm, stat, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { normalizeConfig } from '../src/core/config.mjs'
import { createEngine, createBackend } from '../src/core/engine.mjs'
import { createFilesystemBackend } from '../src/backends/filesystem.mjs'
import { isUnsafeRelativePath, planRecoverSource } from '../src/core/recover.mjs'
import { cleanup, filesystemConfig, tempDir, writeFiles } from './helpers.mjs'

async function backupThenWipe(name, files = { 'a.txt': 'alpha', 'nested/b.txt': 'bravo' }) {
  const root = await tempDir(`vault-recover-${name}-`)
  const library = join(root, 'library')
  await writeFiles(library, files)
  const config = normalizeConfig(filesystemConfig({
    stateDir: join(root, 'state'),
    remoteRoot: join(root, 'remote'),
    sources: [{ id: 'papers', root: library, remote: 'papers' }],
  }))
  const backend = createFilesystemBackend({ root: join(root, 'remote') })
  const engine = createEngine({ config, backend, now: () => new Date('2026-06-01T00:00:00Z') })
  await engine.run({})
  // Wipe the originals: this is the "new machine" case.
  await cleanup(library)
  return { root, library, config, backend, engine, target: join(root, 'restored') }
}

test('a wiped directory is rebuilt from the mirror, byte for byte', async () => {
  const h = await backupThenWipe('roundtrip')
  try {
    const result = await h.engine.recover({ to: h.target })
    assert.equal(result.ok, true, JSON.stringify(result.totals))
    assert.equal(result.totals.downloaded, 2)
    assert.equal(await readFile(join(h.target, 'papers/a.txt'), 'utf8'), 'alpha')
    assert.equal(await readFile(join(h.target, 'papers/nested/b.txt'), 'utf8'), 'bravo')
  } finally { await cleanup(h.root) }
})

test('recover is idempotent: a second pass downloads nothing', async () => {
  const h = await backupThenWipe('idempotent')
  try {
    await h.engine.recover({ to: h.target })
    const second = await h.engine.recover({ to: h.target, allowExistingTarget: true })
    assert.equal(second.totals.downloaded, 0)
    assert.equal(second.totals.skipped, 2, 'both files are already correct')
    assert.equal(second.ok, true)
  } finally { await cleanup(h.root) }
})

test('a file whose digest differs is replaced, and the mirror wins', async () => {
  const h = await backupThenWipe('replace')
  try {
    await h.engine.recover({ to: h.target })
    await writeFile(join(h.target, 'papers/a.txt'), 'tampered')
    const again = await h.engine.recover({ to: h.target, allowExistingTarget: true })
    assert.equal(again.totals.downloaded, 1)
    assert.equal(await readFile(join(h.target, 'papers/a.txt'), 'utf8'), 'alpha')
  } finally { await cleanup(h.root) }
})

test('nothing is ever deleted from the target', async () => {
  const h = await backupThenWipe('nodelete')
  try {
    await h.engine.recover({ to: h.target })
    await writeFile(join(h.target, 'papers/unrelated.txt'), 'keep me')
    await h.engine.recover({ to: h.target, allowExistingTarget: true })
    assert.equal(await readFile(join(h.target, 'papers/unrelated.txt'), 'utf8'), 'keep me')
  } finally { await cleanup(h.root) }
})

test('a non-empty target is refused unless merging is explicitly allowed', async () => {
  const h = await backupThenWipe('nonempty')
  try {
    await writeFile(join(h.root, 'marker'), 'x')
    await assert.rejects(() => h.engine.recover({ to: h.root }), /is not empty/)
    // Explicitly allowed, it proceeds and still deletes nothing.
    const allowed = await h.engine.recover({ to: h.root, allowExistingTarget: true })
    assert.equal(allowed.ok, true)
    assert.equal(await readFile(join(h.root, 'marker'), 'utf8'), 'x')
  } finally { await cleanup(h.root) }
})

test('a corrupt download is reported and never renamed into place', async () => {
  const h = await backupThenWipe('corrupt')
  try {
    const backend = createFilesystemBackend({ root: join(h.root, 'remote') })
    // Mirrors what the real transports do when the bytes do not match the
    // mirror: remove what was written and reject with a classified error.
    const lying = {
      ...backend,
      downloadFile: async (key, localPath) => {
        const partial = `${localPath}.part-${process.pid}`
        // Plain writeFile: writeFiles() makes the parent of its argument, which
        // for a nested path would create a *directory* named after the partial.
        await writeFile(partial, 'not the real content at all')
        await rm(partial, { force: true })
        throw Object.assign(new Error('downloaded object has digest nope, expected something else'), { kind: 'digest-mismatch', key })
      },
    }
    const engine = createEngine({ config: h.config, backend: lying, now: () => new Date('2026-06-01T00:00:00Z') })
    const result = await engine.recover({ to: h.target })
    assert.equal(result.totals.corrupt, 2)
    assert.equal(result.totals.downloaded, 0)
    assert.equal(result.ok, false, 'a corrupt recovery must not report success')
    // An empty parent directory left by a failed download is harmless; what must
    // not exist is a file, verified or otherwise.
    const files = (await readdir(h.target, { recursive: true, withFileTypes: true }).catch(() => []))
      .filter(entry => entry.isFile()).map(entry => entry.name)
    assert.deepEqual(files, [], 'no file may be left at the destination')
  } finally { await cleanup(h.root) }
})

test('an archived object fails the run by default, or is reported and skipped on request', async () => {
  const h = await backupThenWipe('archived')
  try {
    const archived = Object.assign(new Error('object is in an archived storage class and must be thawed'), { kind: 'archived', operation: 'download' })
    const failing = {
      ...h.backend,
      list: (prefix) => h.backend.list(prefix),
      downloadFile: async () => { throw archived },
    }
    const engine = createEngine({ config: h.config, backend: failing, now: () => new Date('2026-06-01T00:00:00Z') })
    await assert.rejects(() => engine.recover({ to: h.target }), /must be thawed/)

    const second = join(h.root, 'restored-skip')
    const skipping = createEngine({ config: h.config, backend: failing, now: () => new Date('2026-06-01T00:00:00Z') })
    const result = await skipping.recover({ to: second, onArchived: 'skip' })
    assert.equal(result.totals.archived, 2)
    assert.equal(result.ok, false, 'a partial recovery is not complete')
  } finally { await cleanup(h.root) }
})

test('an interrupted download leaves no partial file at the destination', async () => {
  const h = await backupThenWipe('partial')
  try {
    const backend = createFilesystemBackend({ root: join(h.root, 'remote') })
    const exploding = {
      ...backend,
      downloadFile: async (key, localPath) => {
        const partial = `${localPath}.part-${process.pid}`
        await writeFile(partial, 'half')
        // A transport that dies mid-write cleans up after itself; the executor
        // must not leave anything behind either way.
        await rm(partial, { force: true })
        throw Object.assign(new Error('connection dropped mid-transfer'), { retryable: true })
      },
    }
    const engine = createEngine({ config: h.config, backend: exploding, now: () => new Date('2026-06-01T00:00:00Z') })
    const result = await engine.recover({ to: h.target })
    assert.equal(result.totals.failed, 2)
    assert.equal(result.ok, false)
    const leftovers = (await readdir(h.target, { recursive: true, withFileTypes: true }).catch(() => []))
      .filter(entry => entry.isFile() && String(entry.name).includes('.part-'))
      .map(entry => entry.name)
    assert.deepEqual(leftovers, [], 'a failed download must not leave partial files behind')
  } finally { await cleanup(h.root) }
})

test('unsafe and colliding keys are refused rather than written', async () => {
  assert.equal(isUnsafeRelativePath('../escape'), true)
  assert.equal(isUnsafeRelativePath('/etc/passwd'), true)
  assert.equal(isUnsafeRelativePath('a/../../b'), true)
  assert.equal(isUnsafeRelativePath('C:\\windows'), true)
  assert.equal(isUnsafeRelativePath(''), true)
  assert.equal(isUnsafeRelativePath('nested/ok.txt'), false)

  const root = await tempDir('vault-recover-unsafe-')
  try {
    const source = { id: 's', remote: 's' }
    const layout = { currentPrefix: name => `current/${name}`, tempRoot: 'incoming' }
    const planned = await planRecoverSource({
      source,
      layout,
      target: join(root, 'out'),
      listing: [
        { key: 'current/s/../../evil.txt', size: 1 },
        { key: 'current/s/ok.txt', size: 1 },
      ],
    })
    assert.equal(planned.stats.unsafe, 1)
    assert.equal(planned.items.length, 1)
    assert.equal(planned.items[0].relPath, 'ok.txt')
    assert.match(planned.unsafe[0].reason, /unsafe-relative-path/)
  } finally { await cleanup(root) }
})

test('the plan reports what a recovery would do without writing anything', async () => {
  const h = await backupThenWipe('dryrun')
  try {
    const plan = await h.engine.recoverPlan({ to: h.target })
    assert.equal(plan.dryRun, true)
    assert.equal(plan.totals.download, 2)
    await assert.rejects(() => stat(h.target), 'a dry run must not create the target')
  } finally { await cleanup(h.root) }
})
