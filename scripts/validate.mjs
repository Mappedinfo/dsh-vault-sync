#!/usr/bin/env node
/**
 * Reproducible validation: parse every module, run the whole test suite, and
 * exercise one real backup round trip against a throwaway local remote.
 * Synthetic data only; no network, no credentials, no managed library.
 */
import { spawn } from 'node:child_process'
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')

function run(command, args, options = {}) {
  return new Promise((resolvePromise, rejectPromise) => {
    const child = spawn(command, args, { stdio: 'inherit', cwd: ROOT, ...options })
    child.on('error', rejectPromise)
    child.on('close', code => (code === 0 ? resolvePromise() : rejectPromise(new Error(`${command} ${args.join(' ')} exited ${code}`))))
  })
}

function capture(command, args) {
  return new Promise((resolvePromise, rejectPromise) => {
    const child = spawn(command, args, { cwd: ROOT })
    let stdout = ''
    let stderr = ''
    child.stdout.on('data', chunk => { stdout += chunk })
    child.stderr.on('data', chunk => { stderr += chunk })
    child.on('close', code => resolvePromise({ code, stdout, stderr }))
    child.on('error', rejectPromise)
  })
}

const steps = []

async function main() {
  const testFiles = (await readdir(join(ROOT, 'tests')))
    .filter(name => name.endsWith('.test.mjs'))
    .sort()
    .map(name => join('tests', name))
  if (testFiles.length === 0) throw new Error('no test files found')
  steps.push({ name: 'tests', ...(await step('tests', async () => {
    await run(process.execPath, ['--test', ...testFiles])
    return `${testFiles.length} test files passed`
  })) })

  const roundTrip = await step('round-trip', async () => {
    const root = await mkdtemp(join(tmpdir(), 'vault-sync-validate-'))
    try {
      const library = join(root, 'library')
      const remote = join(root, 'remote')
      const state = join(root, 'state')
      await mkdir(join(library, '2024'), { recursive: true })
      await mkdir(join(library, 'kg'), { recursive: true })
      await writeFile(join(library, '2024', 'a.pdf'), 'synthetic-one')
      await writeFile(join(library, '2024', 'b.pdf'), 'synthetic-two')
      await writeFile(join(library, 'kg', 'graph.json'), '{"nodes":1}')
      const config = {
        version: 1,
        stateDir: state,
        localRuns: 20,
        remote: { type: 'filesystem', root: remote, currentPrefix: 'current', versionsPrefix: 'versions', tempPrefix: 'incoming', concurrency: 8, retries: 0, timeoutSeconds: 30, allowRemoteDelete: true },
        sources: [{ id: 'papers', kind: 'paper-library', root: library, remote: 'papers', include: [], exclude: ['backups/**'], maxFileBytes: 1048576, required: false }],
      }
      const configPath = join(root, 'config.json')
      await writeFile(configPath, `${JSON.stringify(config, null, 2)}\n`)

      const cli = (...args) => capture(process.execPath, [join(ROOT, 'src', 'cli.mjs'), ...args, '--json', '--config', configPath])
      const parse = async (...args) => {
        const outcome = await cli(...args)
        try {
          return JSON.parse(outcome.stdout)
        } catch (error) {
          throw new Error(`vault-sync ${args.join(' ')} returned unparsable JSON (exit ${outcome.code}): ${error.message}; stderr=${outcome.stderr.slice(0, 400)}`)
        }
      }
      const first = await parse('run')
      if (first.totals.upload !== 3 || first.totals.failed !== 0) throw new Error(`first run uploaded ${first.totals.upload}, failed ${first.totals.failed}`)

      const second = await parse('run')
      if (second.totals.upload !== 0 || second.totals.unchanged !== 3) throw new Error(`second run was not idempotent: upload ${second.totals.upload}, unchanged ${second.totals.unchanged}`)

      await writeFile(join(library, '2024', 'a.pdf'), 'synthetic-one-modified')
      await rm(join(library, '2024', 'b.pdf'))
      const third = await parse('run')
      if (third.totals.upload !== 1 || third.totals.version !== 2 || third.totals.delete !== 1) {
        throw new Error(`third run wrong: upload ${third.totals.upload}, version ${third.totals.version}, delete ${third.totals.delete}`)
      }
      const archived = await readFile(join(remote, 'versions', new Date().toISOString().slice(0, 10), 'papers', '2024', 'b.pdf'), 'utf8').catch(() => undefined)
      if (archived !== 'synthetic-two') throw new Error('the deleted file was not archived before removal')

      const verified = await parse('verify')
      if (!verified.ok) throw new Error('verify reported a mismatch after a clean run')

      const plan = await parse('plan')
      if (plan.totals.upload !== 0) throw new Error('plan after a clean run still wants to upload')

      const status = await parse('status')
      const runs = status.runs.length
      if (runs < 3) throw new Error(`expected at least 3 recorded runs, saw ${runs}`)

      const cost = await parse('cost')
      if (!(cost.totalPerYear >= 0) || cost.currency !== 'CNY') throw new Error('cost estimate is malformed')

      return `3 uploads, idempotent re-run, 1 modification archived, 1 deletion archived, verify ok, ${runs} runs recorded`
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })
  steps.push({ name: 'round-trip', ...roundTrip })

  const harness = await step('harness-contract', async () => {
    const { bundledVaultSyncSkill } = await import(join(ROOT, 'src', 'harness', 'skills.mjs'))
    const { TOOL_SPECS, argsForTool } = await import(join(ROOT, 'src', 'harness', 'tools.mjs'))
    const skill = bundledVaultSyncSkill()
    if (TOOL_SPECS.length !== 6) throw new Error(`expected 6 tools, saw ${TOOL_SPECS.length}`)
    if (skill.name !== 'vault-sync') throw new Error('bundled skill name mismatch')
    if (argsForTool('vault_sync_run', { dry_run: true })[0] !== 'plan') throw new Error('dry run must map to plan')
    return `${TOOL_SPECS.length} tools and the bundled skill load without the Harness runtime`
  })
  steps.push({ name: 'harness-contract', ...harness })

  const progressCheck = await step('progress-visibility', async () => {
    const { createProgressTracker } = await import(join(ROOT, 'src', 'core', 'progress.mjs'))
    const root = await mkdtemp(join(tmpdir(), 'vault-progress-'))
    try {
      const tracker = createProgressTracker({ stateDir: root, runId: 'validate', minEvents: 250, throttleMs: 60_000 })
      await tracker.sourceScanned('s', 3)
      await tracker.fileDone({ sourceId: 's', relPath: 'a', status: 'applied', bytes: 1 })
      await tracker.finish('interrupted')
      const document = JSON.parse(await readFile(tracker.path, 'utf8'))
      if (document.totals.done !== 1) throw new Error('progress did not record the finished file')
      if (document.status !== 'interrupted') throw new Error('progress status not recorded')
      return 'a source smaller than any flush threshold is still visible while it runs'
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })
  steps.push({ name: 'progress-visibility', ...progressCheck })

  const failures = steps.filter(step => !step.ok)
  process.stdout.write(`\nvault-sync validation: ${failures.length === 0 ? 'PASS' : 'FAIL'} (${steps.length} checks)\n`)
  for (const step of steps) process.stdout.write(`  ${step.ok ? 'ok  ' : 'FAIL'} ${step.name}: ${step.detail}\n`)
  process.exitCode = failures.length === 0 ? 0 : 1
}

async function step(name, fn) {
  try {
    return { ok: true, detail: await fn() }
  } catch (error) {
    return { ok: false, detail: error instanceof Error ? error.message : String(error) }
  }
}

main().catch(error => {
  process.stderr.write(`validate: ${error.message}\n`)
  process.exitCode = 1
})
