/**
 * Planner decision table. These branches decide whether a backup overwrites,
 * preserves or ignores a remote object, so each one is pinned explicitly.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { createLayout } from '../src/core/backend.mjs'
import { nextIndex, orphanTempKeys, planSource, sampleEvenly } from '../src/core/planner.mjs'

const layout = createLayout({ currentPrefix: 'current', versionsPrefix: 'versions', tempPrefix: 'incoming' })

const plan = (patch = {}) => planSource({
  files: [{ relPath: 'a.pdf', size: 5, mtimeMs: 1, digest: 'aaaa' }],
  remote: [{ key: 'current/papers/a.pdf', size: 5 }],
  layout,
  remoteName: 'papers',
  previous: { 'a.pdf': { size: 5, digest: 'aaaa' } },
  stamp: '2026-02-02',
  allowRemoteDelete: true,
  ...patch,
})

test('an object missing remotely is uploaded', () => {
  const { items } = plan({ remote: [] })
  assert.deepEqual(items.map(i => [i.action, i.reason]), [['upload', 'remote-missing-despite-index']])
})

test('a brand new file with no index entry is uploaded', () => {
  const { items } = plan({ remote: [], previous: {} })
  assert.deepEqual(items.map(i => [i.action, i.reason]), [['upload', 'new-file']])
})

test('matching digests are skipped as verified', () => {
  const { items, stats } = plan({ remote: [{ key: 'current/papers/a.pdf', size: 5, digest: 'aaaa' }] })
  assert.equal(items[0].action, 'skip')
  assert.equal(items[0].verified, true)
  assert.equal(items[0].reason, 'digest-match')
  assert.equal(stats.unchangedUnverified, 0)
})

test('a same-size object without digest metadata is left alone, not rewritten', () => {
  const { items, stats } = plan()
  assert.equal(items.length, 1)
  assert.equal(items[0].action, 'skip')
  assert.equal(items[0].verified, false)
  assert.equal(items[0].reason, 'size-match-unverified')
  assert.equal(stats.upload, 0)
  assert.equal(stats.version, 0)
  assert.equal(stats.unchangedUnverified, 1)
})

test('a digest disagreement archives the old object before overwriting', () => {
  const { items } = plan({ remote: [{ key: 'current/papers/a.pdf', size: 5, digest: 'bbbb' }] })
  assert.deepEqual(items.map(i => i.action), ['version', 'upload'])
  assert.equal(items[0].versionKey, 'versions/2026-02-02/papers/a.pdf')
  assert.equal(items[0].reason, 'local-modified')
})

test('a size change archives and re-uploads even without digest metadata', () => {
  const { items } = plan({ remote: [{ key: 'current/papers/a.pdf', size: 4 }] })
  assert.deepEqual(items.map(i => i.action), ['version', 'upload'])
  assert.equal(items[0].reason, 'size-changed')
})

test('a remotely present file that this deployment never managed is left alone', () => {
  // Present remotely, absent locally, and with no index entry: not ours to delete.
  const { items } = plan({ files: [], previous: {} })
  assert.equal(items.length, 1)
  assert.equal(items[0].action, 'skip')
  assert.equal(items[0].remoteOnly, true)
  assert.equal(items[0].reason, 'remote-only-unmanaged')
})

test('an unmanaged remote file is not re-uploaded while the local file matches its size', () => {
  const { items } = plan({ previous: {} })
  assert.equal(items[0].action, 'skip')
  assert.equal(items[0].verified, false)
  assert.equal(items[0].reason, 'size-match-unverified')
})

test('a locally deleted managed file is archived then removed', () => {
  const { items } = plan({ files: [], remote: [{ key: 'current/papers/a.pdf', size: 5, digest: 'aaaa' }] })
  assert.deepEqual(items.map(i => [i.action, i.reason]), [['version', 'local-deleted'], ['delete', 'local-deleted']])
})

test('allowRemoteDelete=false keeps a locally deleted file in the mirror', () => {
  const { items } = plan({ files: [], remote: [{ key: 'current/papers/a.pdf', size: 5 }], allowRemoteDelete: false })
  assert.deepEqual(items.map(i => [i.action, i.reason]), [['skip', 'local-deleted-keep-remote']])
})

test('other sources and temp keys are outside this source plan', () => {
  const { items } = plan({
    files: [],
    previous: {},
    remote: [
      { key: 'current/other/x.pdf', size: 1 },
      { key: 'incoming/run1/papers/y.pdf', size: 1 },
      { key: 'versions/2026-01-01/papers/z.pdf', size: 1 },
    ],
  })
  assert.deepEqual(items, [])
})

test('nextIndex records exactly what was uploaded', () => {
  const files = [{ relPath: 'a.pdf', size: 3, mtimeMs: 9, digest: 'x' }]
  assert.deepEqual(nextIndex(files), { 'a.pdf': { size: 3, mtimeMs: 9, digest: 'x' } })
})

test('orphanTempKeys excludes the active run and non-temp keys', () => {
  const entries = [
    { key: 'incoming/live/papers/a.pdf' },
    { key: 'incoming/dead/papers/b.pdf' },
    { key: 'current/papers/c.pdf' },
  ]
  assert.deepEqual(orphanTempKeys(entries, layout, 'live').map(e => e.key), ['incoming/dead/papers/b.pdf'])
})

test('sampleEvenly is deterministic and bounded', () => {
  const items = Array.from({ length: 100 }, (_, i) => i)
  const sample = sampleEvenly(items, 10)
  assert.equal(sample.length, 10)
  assert.deepEqual(sample, sampleEvenly(items, 10))
  assert.deepEqual(sampleEvenly(items, 0), items)
  assert.deepEqual(sampleEvenly(items, 500), items)
})
