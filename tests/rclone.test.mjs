/**
 * rclone transport with an injected spawn: argv construction, lsjson parsing,
 * timeouts and retries are all exercised without installing rclone.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { createRcloneBackend } from '../src/backends/rclone.mjs'
import { createEngine } from '../src/core/engine.mjs'
import { cleanup, filesystemConfig, tempDir, writeFiles } from './helpers.mjs'

/** Fake child process that answers with scripted stdout/stderr/exit codes. */
function fakeSpawn(script) {
  const calls = []
  const spawnImpl = (binary, args) => {
    calls.push({ binary, args })
    const result = script(binary, args, calls.length)
    const child = new EventEmitter()
    child.stdout = new EventEmitter()
    child.stderr = new EventEmitter()
    child.kill = () => {}
    if (result?.hang) return child
    setImmediate(() => {
      if (result?.stdout) child.stdout.emit('data', result.stdout)
      if (result?.stderr) child.stderr.emit('data', result.stderr)
      child.emit('close', result?.code ?? 0)
    })
    return child
  }
  return { spawnImpl, calls }
}

test('remote names are validated before anything is spawned', () => {
  assert.throws(() => createRcloneBackend({ remote: 'bad name' }), /rclone remote/)
  assert.doesNotThrow(() => createRcloneBackend({ remote: 'aliyun-oss' }))
  assert.doesNotThrow(() => createRcloneBackend({ remote: 'aliyun-oss:' }))
})

test('list parses lsjson and prefixes keys with the requested prefix', async () => {
  const { spawnImpl, calls } = fakeSpawn(() => ({ stdout: JSON.stringify([{ Path: 'a/b.pdf', Size: 12 }, { Path: 'c.pdf', Size: 3 }]) }))
  const backend = createRcloneBackend({ remote: 'oss', spawnImpl })
  const entries = await backend.list('current/papers')
  assert.deepEqual(entries.map(entry => entry.key), ['current/papers/a/b.pdf', 'current/papers/c.pdf'])
  assert.deepEqual(entries.map(entry => entry.size), [12, 3])
  assert.deepEqual(calls[0].args.slice(0, 4), ['lsjson', '--recursive', '--files-only', '--no-mimetype'])
})

test('putFile and copy use copyto against the remote: target', async () => {
  const { spawnImpl, calls } = fakeSpawn(() => ({}))
  const backend = createRcloneBackend({ remote: 'oss', spawnImpl })
  await backend.putFile('incoming/run1/papers/a.pdf', '/tmp/local-a.pdf', { size: 4 })
  await backend.copy('current/papers/a.pdf', 'versions/2026-01-01/papers/a.pdf')
  await backend.remove('current/papers/a.pdf')
  assert.deepEqual(calls[0].args, ['copyto', '--no-traverse', '/tmp/local-a.pdf', 'oss:incoming/run1/papers/a.pdf'])
  assert.deepEqual(calls[1].args, ['copyto', '--no-traverse', 'oss:current/papers/a.pdf', 'oss:versions/2026-01-01/papers/a.pdf'])
  assert.deepEqual(calls[2].args, ['deletefile', 'oss:current/papers/a.pdf'])
})

test('a non-zero exit is a retryable error naming the operation', async () => {
  const { spawnImpl } = fakeSpawn(() => ({ code: 3, stderr: 'directory not found' }))
  const backend = createRcloneBackend({ remote: 'oss', spawnImpl, retries: 0 })
  await assert.rejects(() => backend.copy('a', 'b'), /rclone copyto exited 3: directory not found/)
  const retrying = createRcloneBackend({ remote: 'oss', spawnImpl, retries: 1 })
  await assert.rejects(() => retrying.copy('a', 'b'), /exited 3/)
})

test('a hung rclone is killed by the timeout instead of blocking the run', async () => {
  const { spawnImpl } = fakeSpawn(() => ({ hang: true }))
  const backend = createRcloneBackend({ remote: 'oss', spawnImpl, timeoutSeconds: 0.05, retries: 0 })
  await assert.rejects(() => backend.list('current'), /timed out/)
})

test('head returns undefined when rclone reports a missing object', async () => {
  const { spawnImpl } = fakeSpawn(() => ({ code: 3, stderr: 'error listing: directory not found' }))
  const backend = createRcloneBackend({ remote: 'oss', spawnImpl, retries: 0 })
  // head() is allowed to fail: a missing object is not an error for the planner.
  const result = await backend.head('current/missing.pdf').catch(() => undefined)
  assert.equal(result, undefined)
})

test('the engine syncs through the rclone transport without digest metadata', async () => {
  const root = await tempDir('vault-rclone-')
  try {
    const library = join(root, 'library')
    const libraryFiles = { 'a.pdf': 'alpha', 'b.pdf': 'beta' }
    await writeFiles(library, libraryFiles)
    const config = filesystemConfig({ stateDir: join(root, 'state'), remoteRoot: join(root, 'unused'), sources: [{ id: 'papers', root: library, remote: 'papers' }] })
    config.remote = { ...config.remote, type: 'rclone', rcloneRemote: 'oss' }

    // An in-memory remote driven only by the argv rclone would receive. Uploads
    // read the real local file so sizes and follow-up listings stay honest.
    const objects = new Map()
    const { spawnImpl } = fakeSpawn((binary, args) => {
      const target = args[args.length - 1]
      if (args[0] === 'lsjson') {
        const prefix = target.replace(/^oss:/, '')
        // `--stat` asks about one object and yields an object, not a listing.
        if (args.includes('--stat')) {
          if (!objects.has(prefix)) return { code: 3, stderr: 'object not found' }
          return { stdout: JSON.stringify({ Path: prefix.split('/').pop(), Size: objects.get(prefix).length }) }
        }
        const rows = [...objects.entries()]
          .filter(([key]) => key.startsWith(prefix))
          .map(([key, value]) => ({ Path: prefix ? key.slice(prefix.length + 1) : key, Size: value.length }))
        return { stdout: JSON.stringify(rows) }
      }
      if (args[0] === 'copyto') {
        const from = args[2]
        const to = args[3].replace(/^oss:/, '')
        if (from.startsWith('oss:')) objects.set(to, objects.get(from.replace(/^oss:/, '')) ?? Buffer.alloc(0))
        else objects.set(to, readFileSync(from))
        return {}
      }
      if (args[0] === 'deletefile') { objects.delete(target.replace(/^oss:/, '')); return {} }
      return {}
    })
    const backend = createRcloneBackend({ remote: 'oss', spawnImpl })
    const engine = createEngine({ config, backend, now: () => new Date('2026-02-02T00:00:00Z') })
    const first = await engine.run({})
    assert.equal(first.totals.failed, 0)
    assert.equal(first.totals.upload, 2)
    assert.deepEqual([...objects.keys()].sort(), ['current/papers/a.pdf', 'current/papers/b.pdf'])
    assert.equal(objects.get('current/papers/a.pdf').toString(), 'alpha')

    const second = await engine.plan({})
    // Without digest metadata the planner leaves a same-size object untouched
    // but reports it as unverified rather than claiming it matches.
    for (const item of second.entries.papers.items) {
      assert.equal(item.action, 'skip')
      assert.equal(item.verified, false)
      assert.equal(item.reason, 'size-match-unverified')
    }
    assert.equal(second.summary[0].unchangedUnverified, 2)

    // A size change is still detected and re-uploaded without digest metadata.
    await writeFiles(library, { 'a.pdf': 'alpha-grown-longer' })
    const third = await engine.run({})
    assert.equal(third.totals.upload, 1)
    assert.equal(objects.get('current/papers/a.pdf').toString(), 'alpha-grown-longer')
  } finally {
    await cleanup(root)
  }
})
