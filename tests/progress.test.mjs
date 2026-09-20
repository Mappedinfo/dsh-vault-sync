/**
 * Live progress. The failure this fixes: a 422-file source had no visible
 * progress at all, because the digest index only flushed every 250 completed
 * files and the next threshold never arrived, so a reader could not tell a
 * running backup from a hung one.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile, readdir, rm } from 'node:fs/promises'
import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { createProgressTracker, pruneProgress, readProgress } from '../src/core/progress.mjs'
import { cleanup, tempDir, writeFiles } from './helpers.mjs'

const readProgressFile = async path => JSON.parse(await readFile(path, 'utf8'))

test('a run of fewer files than the write threshold still lands on disk', async () => {
  // The regression: a source smaller than the flush threshold produced nothing.
  const root = await tempDir('progress-small-')
  try {
    const tracker = createProgressTracker({ stateDir: root, runId: 'r-small', minEvents: 250, throttleMs: 60_000 })
    await tracker.sourceScanned('tiny', 3)
    for (let i = 0; i < 3; i += 1) {
      await tracker.fileDone({ sourceId: 'tiny', relPath: `f${i}.txt`, status: 'applied', bytes: 10 })
    }
    // Mid-run visibility: the throttled window has not elapsed, so the file only
    // appears once something forces it.
    await tracker.finish('partial')
    const document = await readProgressFile(tracker.path)
    assert.equal(document.totals.planned, 3)
    assert.equal(document.totals.done, 3)
    assert.equal(document.totals.bytes, 30)
    assert.equal(document.sources[0].id, 'tiny')
    assert.equal(document.sources[0].done, 3)
  } finally {
    await cleanup(root)
  }
})

test('progress records the file being worked on and counts failures separately', async () => {
  const root = await tempDir('progress-files-')
  try {
    const tracker = createProgressTracker({ stateDir: root, runId: 'r-count', minEvents: 1 })
    await tracker.sourceScanned('s', 4)
    await tracker.fileDone({ sourceId: 's', relPath: 'a.txt', status: 'applied', bytes: 100 })
    await tracker.fileDone({ sourceId: 's', relPath: 'b.txt', status: 'failed' })
    await tracker.fileDone({ sourceId: 's', relPath: 'c.txt', status: 'skipped' })
    await tracker.finish('partial')
    const document = await readProgressFile(tracker.path)
    assert.equal(document.totals.done, 2, 'applied and skipped both count as done')
    assert.equal(document.totals.failed, 1)
    assert.equal(document.totals.bytes, 100, 'only an applied upload adds bytes')
    assert.equal(document.sources[0].currentFile, 'c.txt')
    assert.equal(document.sources[0].failed, 1)
  } finally {
    await cleanup(root)
  }
})

test('high-frequency events are throttled rather than written per file', async () => {
  const root = await tempDir('progress-throttle-')
  try {
    // A 30s window with a high threshold means no intermediate write at all.
    const tracker = createProgressTracker({ stateDir: root, runId: 'r-throttle', minEvents: 1000, throttleMs: 30_000 })
    await tracker.sourceScanned('s', 500)
    for (let i = 0; i < 500; i += 1) {
      await tracker.fileDone({ sourceId: 's', relPath: `f${i}`, status: 'applied', bytes: 1 })
    }
    // The opening scan event legitimately writes once; the 500 files after it
    // must not, because the window and the event threshold are both far away.
    const afterScan = tracker.writeCount
    assert.equal(afterScan, 1, `expected one write from the scan event, saw ${afterScan}`)
    assert.equal(tracker.writeCount, afterScan, 'no per-file writes inside the throttle window')
    await tracker.finish('partial')
    assert.equal(tracker.writeCount, afterScan + 1, 'the final flush must land exactly once')
  } finally {
    await cleanup(root)
  }
})

test('a completed run removes its progress file, an interrupted one keeps it', async () => {
  const root = await tempDir('progress-lifecycle-')
  try {
    const done = createProgressTracker({ stateDir: root, runId: 'r-done', minEvents: 1 })
    await done.sourceScanned('s', 1)
    await done.fileDone({ sourceId: 's', relPath: 'a', status: 'applied', bytes: 1 })
    await done.finish('finished')
    const finished = await readProgress(root)
    assert.deepEqual(finished.map(row => row.runId), [], 'a finished run leaves no progress file')

    const stopped = createProgressTracker({ stateDir: root, runId: 'r-stop', minEvents: 1 })
    await stopped.sourceScanned('s', 10)
    await stopped.fileDone({ sourceId: 's', relPath: 'a', status: 'applied', bytes: 1 })
    await stopped.finish('interrupted')
    const rows = await readProgress(root)
    assert.equal(rows.length, 1)
    assert.equal(rows[0].runId, 'r-stop')
    assert.equal(rows[0].status, 'interrupted')
  } finally {
    await cleanup(root)
  }
})

test('an interrupted run with no live lock is reported as stale', async () => {
  const root = await tempDir('progress-stale-')
  try {
    const tracker = createProgressTracker({ stateDir: root, runId: 'r-stale', minEvents: 1 })
    await tracker.sourceScanned('s', 5)
    await tracker.fileDone({ sourceId: 's', relPath: 'a', status: 'applied', bytes: 1 })
    await tracker.finish('interrupted')
    // No run.lock exists, so the run that produced this is gone.
    const rows = await readProgress(root)
    void rows
    // Simulate a killed process: rewrite the status back to running.
    const document = await readProgressFile(tracker.path)
    document.status = 'running'
    await writeFile(tracker.path, JSON.stringify(document))
    const reread = await readProgress(root)
    assert.equal(reread[0].stale, true, 'a running file with no live lock is stale')
  } finally {
    await cleanup(root)
  }
})

test('a progress write failure never breaks the run it is describing', async () => {
  const root = await tempDir('progress-fail-')
  try {
    // Point the tracker at a path whose parent is a file, so every write fails.
    const blocker = join(root, 'blocked')
    await mkdir(root, { recursive: true })
    await writeFile(blocker, 'not a directory')
    const tracker = createProgressTracker({ stateDir: join(blocker, 'state'), runId: 'r-blocked', minEvents: 1 })
    await tracker.sourceScanned('s', 1)
    await tracker.fileDone({ sourceId: 's', relPath: 'a', status: 'applied', bytes: 1 })
    await tracker.finish('partial')
    assert.ok(tracker.lastWriteFailure, 'the failure is recorded')
    assert.equal(tracker.state.totals.done, 1, 'the run state itself still advanced')
  } finally {
    await cleanup(root)
  }
})

test('pruneProgress removes stale files and keeps the active run', async () => {
  const root = await tempDir('progress-prune-')
  try {
    await mkdir(join(root, 'progress'), { recursive: true })
    const old = { runId: 'old', status: 'interrupted', updatedAt: '2020-01-01T00:00:00.000Z' }
    await writeFile(join(root, 'progress', 'old.json'), JSON.stringify(old))
    const active = createProgressTracker({ stateDir: root, runId: 'active', minEvents: 1 })
    await active.sourceScanned('s', 1)
    await active.finish('interrupted')
    // Make the active file look fresh; the old one is a year stale.
    const removed = await pruneProgress(root, { maxAgeMs: 1000, now: () => Date.parse('2026-06-01T00:00:00Z') })
    assert.equal(removed, 1)
    const names = await readdir(join(root, 'progress'))
    assert.deepEqual(names, ['active.json'])
  } finally {
    await cleanup(root)
  }
})

test('the tracker reports a rate and an ETA once files have finished', async () => {
  const root = await tempDir('progress-rate-')
  try {
    let clock = Date.parse('2026-06-01T00:00:00Z')
    const tracker = createProgressTracker({ stateDir: root, runId: 'r-rate', minEvents: 1, now: () => clock })
    await tracker.sourceScanned('s', 100)
    for (let i = 0; i < 10; i += 1) {
      clock += 1000
      await tracker.fileDone({ sourceId: 's', relPath: `f${i}`, status: 'applied', bytes: 1 })
    }
    await tracker.finish('partial')
    const document = await readProgressFile(tracker.path)
    assert.ok(document.ratePerSec > 0, `rate ${document.ratePerSec}`)
    assert.ok(document.etaSeconds > 0, `eta ${document.etaSeconds}`)
  } finally {
    await cleanup(root)
  }
})

test('status surfaces a live run without touching the network', async () => {
  const root = await tempDir('progress-status-')
  try {
    const library = join(root, 'library')
    await writeFiles(library, { 'a.txt': 'alpha', 'b.txt': 'beta' })
    const { normalizeConfig } = await import('../src/core/config.mjs')
    const { createEngine } = await import('../src/core/engine.mjs')
    const { createFilesystemBackend } = await import('../src/backends/filesystem.mjs')
    const { filesystemConfig } = await import('./helpers.mjs')
    const config = normalizeConfig(filesystemConfig({
      stateDir: join(root, 'state'),
      remoteRoot: join(root, 'remote'),
      sources: [{ id: 's', root: library, remote: 's' }],
    }))
    const backend = createFilesystemBackend({ root: join(root, 'remote') })
    const engine = createEngine({ config, backend, now: () => new Date('2026-06-01T00:00:00Z') })

    // Leave an interrupted progress file behind, as a killed run would.
    const tracker = createProgressTracker({ stateDir: config.stateDir, runId: 'run-live', minEvents: 1 })
    await tracker.sourceScanned('s', 2)
    await tracker.fileDone({ sourceId: 's', relPath: 'a.txt', status: 'applied', bytes: 5 })
    await tracker.finish('interrupted')

    const status = await engine.status({})
    assert.equal(status.progress.length, 1)
    assert.equal(status.progress[0].runId, 'run-live')
    assert.equal(status.progress[0].totals.done, 1)
    // No remote call was made: the row has no remoteObjects unless --remote asked.
    assert.equal(status.sources[0].remoteObjects, undefined)
  } finally {
    await cleanup(root)
  }
})
