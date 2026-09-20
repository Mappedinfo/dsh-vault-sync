/**
 * Graceful stop. Killing a run used to lose everything since the last index
 * flush, and left a stale lock with no record of what had happened.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { readFile, readdir } from 'node:fs/promises'
import { join, resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { cleanup, filesystemConfig, tempDir, writeFiles } from './helpers.mjs'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const CLI = join(ROOT, 'src', 'cli.mjs')

const readJson = async path => JSON.parse(await readFile(path, 'utf8'))

/** Run the CLI and resolve once it exits, capturing stdout/stderr. */
function runCli(configPath, args = []) {
  const child = spawn(process.execPath, [CLI, 'run', '--json', '--config', configPath, ...args], {
    cwd: ROOT,
    stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, VAULT_SYNC_PROGRESS: '0' },
  })
  let stdout = ''
  let stderr = ''
  child.stdout.on('data', chunk => { stdout += chunk })
  child.stderr.on('data', chunk => { stderr += chunk })
  const settled = new Promise(resolvePromise => {
    child.on('close', (code, signal) => resolvePromise({ code, signal, stdout, stderr }))
  })
  return { child, settled, get stderr() { return stderr } }
}

/** Wait until the tracker file exists and reports at least one finished file. */
async function waitForProgress(stateDir, { timeoutMs = 20_000 } = {}) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const dir = join(stateDir, 'progress')
    const names = await readdir(dir).catch(() => [])
    for (const name of names.filter(entry => entry.endsWith('.json'))) {
      const document = await readJson(join(dir, name)).catch(() => undefined)
      if (document?.totals?.done > 0) return document
    }
    await new Promise(resolvePromise => setTimeout(resolvePromise, 50))
  }
  throw new Error('no progress was recorded before the timeout')
}

async function scenario(name, { files = 400 } = {}) {
  const root = await tempDir(`vault-signal-${name}-`)
  const library = join(root, 'library')
  const payload = {}
  for (let i = 0; i < files; i += 1) payload[`f${String(i).padStart(4, '0')}.txt`] = `payload-${i}-${'x'.repeat(64)}`
  await writeFiles(library, payload)
  const config = filesystemConfig({
    stateDir: join(root, 'state'),
    remoteRoot: join(root, 'remote'),
    sources: [{ id: 'papers', root: library, remote: 'papers' }],
  })
  const configPath = join(root, 'config.json')
  await writeFiles(root, { 'config.json': `${JSON.stringify(config, null, 2)}\n` })
  return { root, library, config, configPath, stateDir: join(root, 'state') }
}

test('SIGTERM stops the run, marks it interrupted, flushes progress and releases the lock', async () => {
  const h = await scenario('term')
  try {
    const { child, settled } = runCli(h.configPath)
    const progress = await waitForProgress(h.stateDir)
    assert.equal(progress.status, 'running', 'the run should still be running when the signal lands')
    child.kill('SIGTERM')
    const outcome = await settled

    assert.equal(outcome.code, 130, `expected the conventional interrupted exit code, saw ${outcome.code}`)
    assert.match(outcome.stderr, /SIGTERM received, stopping/)

    // The run record explains what happened rather than claiming success.
    const runsDir = join(h.stateDir, 'runs')
    const runs = (await readdir(runsDir)).filter(name => name.endsWith('.json') && !name.includes('.tmp-'))
    const record = await readJson(join(runsDir, runs.sort().reverse()[0]))
    assert.equal(record.status, 'interrupted')
    assert.ok(record.totals.done === undefined || record.totals.interrupted === true)

    // Progress is kept so a reader can see how far it got.
    const kept = (await readdir(join(h.stateDir, 'progress'))).filter(name => name.endsWith('.json'))
    assert.equal(kept.length, 1, 'an interrupted run keeps its progress file')
    const finalProgress = await readJson(join(h.stateDir, 'progress', kept[0]))
    assert.equal(finalProgress.status, 'interrupted')
    assert.ok(finalProgress.totals.done > 0, 'the files that did finish are recorded')

    // The lock is released, so the next run is not blocked.
    const lockExists = await readdir(h.stateDir).then(names => names.includes('run.lock'))
    assert.equal(lockExists, false, 'the run lock must be released on a graceful stop')
  } finally {
    await cleanup(h.root)
  }
})

test('the index after a graceful stop never claims an unfinished file is backed up', async () => {
  const h = await scenario('index')
  try {
    const { child, settled } = runCli(h.configPath)
    const progress = await waitForProgress(h.stateDir)
    child.kill('SIGTERM')
    await settled

    const indexDir = join(h.stateDir, 'index')
    const names = await readdir(indexDir).catch(() => [])
    for (const name of names.filter(entry => entry.endsWith('.json'))) {
      const index = await readJson(join(indexDir, name))
      const entries = Object.keys(index.entries ?? {}).length
      // The source did not finish, so its index must not advance to the full plan.
      assert.ok(entries < progress.totals.planned, `index has ${entries} entries for a plan of ${progress.totals.planned}`)
    }
  } finally {
    await cleanup(h.root)
  }
})

test('a second signal exits immediately instead of waiting for a slow file', async () => {
  const h = await scenario('second')
  try {
    const { child, settled } = runCli(h.configPath)
    await waitForProgress(h.stateDir)
    child.kill('SIGTERM')
    child.kill('SIGTERM')
    const outcome = await settled
    assert.equal(outcome.code, 130)
  } finally {
    await cleanup(h.root)
  }
})

test('a run that is never signalled finishes cleanly and leaves no progress file', async () => {
  const h = await scenario('clean', { files: 5 })
  try {
    const { settled } = runCli(h.configPath)
    const outcome = await settled
    assert.equal(outcome.code, 0, `stderr: ${outcome.stderr}`)
    const kept = await readdir(join(h.stateDir, 'progress')).catch(() => [])
    assert.deepEqual(kept, [], 'a finished run removes its progress file')
  } finally {
    await cleanup(h.root)
  }
})
