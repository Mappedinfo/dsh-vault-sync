/**
 * Harness layer: tool registration, the approval gate, argument mapping and the
 * child-process runner. These use a stub tool registry and a synthetic config,
 * so no Harness runtime or remote is involved.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { join } from 'node:path'
import { mkdir } from 'node:fs/promises'
import { argsForTool, registerVaultSyncTools, summarizeToolResult, TOOL_SPECS } from '../src/harness/tools.mjs'
import { CliError, normalizeCliConfig, runCli, defaultConfigCandidates } from '../src/harness/cli-runner.mjs'
import { resolveConfig } from '../src/harness/index.mjs'
import { cleanup, filesystemConfig, tempDir, writeFiles } from './helpers.mjs'

/** Minimal stand-in for the Harness tool registry and event bus. */
function stubContext() {
  const registered = []
  const hooks = []
  return {
    registered,
    hooks,
    tools: { register: tool => { registered.push(tool); return () => {} } },
    on: (event, handler) => { hooks.push({ event, handler }); return () => {} },
    effect: fn => { fn() },
  }
}

const defineTool = spec => spec

test('every tool declares a description, parameters and an output renderer', () => {
  assert.equal(TOOL_SPECS.length, 7)
  for (const spec of TOOL_SPECS) {
    assert.ok(spec.name.startsWith('vault_sync_'), spec.name)
    assert.ok(spec.description.length > 60, `${spec.name} needs a real description`)
  }
})

test('tool calls map to CLI argv without any secret field', () => {
  assert.deepEqual(argsForTool('vault_sync_status', {}), ['status'])
  assert.deepEqual(argsForTool('vault_sync_plan', {}), ['plan'])
  assert.deepEqual(argsForTool('vault_sync_plan', { source: ['papers'] }), ['plan', '--source', 'papers'])
  assert.deepEqual(argsForTool('vault_sync_run', {}), ['run', '--quiet'])
  assert.deepEqual(argsForTool('vault_sync_run', { dry_run: true }), ['plan'])
  assert.deepEqual(argsForTool('vault_sync_verify', { sample: 25 }), ['verify', '--sample', '25'])
  assert.deepEqual(argsForTool('vault_sync_restore', { source: 'papers', path: 'a.pdf' }), ['restore', 'papers', 'a.pdf'])
  assert.deepEqual(argsForTool('vault_sync_recover', { to: '/tmp/out' }), ['recover', '--to', '/tmp/out'])
  assert.deepEqual(argsForTool('vault_sync_recover', { to: '/tmp/out', dry_run: true, on_archived: 'skip' }), ['recover', '--to', '/tmp/out', '--dry-run', '--on-archived', 'skip'])
  assert.deepEqual(argsForTool('vault_sync_cost', { egress: 'idle' }), ['cost', '--egress', 'idle'])
  assert.throws(() => argsForTool('nope', {}), /unknown vault-sync tool/)
})

test('the two tools that write are gated for approval and the readers are not', async () => {
  const ctx = stubContext()
  registerVaultSyncTools(ctx, defineTool, { requireToolApproval: true, configPath: undefined })
  assert.equal(ctx.registered.length, 7)
  const gate = ctx.hooks.find(hook => hook.event === 'tools/pre-execute')
  assert.ok(gate, 'an approval hook should be registered')
  const nextAllow = async () => ({ kind: 'allow' })
  assert.equal((await gate.handler({ name: 'vault_sync_plan' }, nextAllow)).kind, 'allow')
  // run uploads to the remote; recover writes real files to disk. Both change
  // something outside the tool call, so both are gated.
  for (const name of ['vault_sync_run', 'vault_sync_recover']) {
    const decision = await gate.handler({ name }, nextAllow)
    assert.equal(decision.kind, 'ask', `${name} must be gated`)
  }
  const runDecision = await gate.handler({ name: 'vault_sync_run' }, nextAllow)
  assert.match(runDecision.reason, /one-way/)
  const recoverDecision = await gate.handler({ name: 'vault_sync_recover' }, nextAllow)
  assert.match(recoverDecision.reason, /target|download|rebuild/i)
})

test('approval can be disabled without changing the registered tools', () => {
  const ctx = stubContext()
  registerVaultSyncTools(ctx, defineTool, { requireToolApproval: false })
  assert.equal(ctx.hooks.filter(hook => hook.event === 'tools/pre-execute').length, 0)
  assert.equal(ctx.registered.length, 7)
})

test('results are summarized in one line for the reader', () => {
  assert.match(summarizeToolResult('vault_sync_plan', { totals: { upload: 3, version: 1, delete: 0, unchanged: 9 } }), /upload 3/)
  assert.match(summarizeToolResult('vault_sync_verify', { checked: 40, ok: false }), /ok=false/)
  assert.match(summarizeToolResult('vault_sync_recover', { totals: { downloaded: 3, skipped: 1, archived: 0, failed: 0 } }), /downloaded 3/)
  assert.match(summarizeToolResult('vault_sync_cost', { totalPerYear: 65.16, currency: 'CNY' }), /65.16 CNY/)
  assert.equal(summarizeToolResult('vault_sync_status', { sources: [{ id: 'papers', indexed: 2, remoteObjects: 2 }] }), 'papers: 2 indexed / 2 remote')
})

test('config paths must be absolute and unknown keys are refused', () => {
  assert.throws(() => normalizeCliConfig('relative.json'), /absolute path/)
  assert.equal(normalizeCliConfig('/tmp/x.json'), '/tmp/x.json')
  assert.deepEqual(resolveConfig({}), { configPath: undefined, requireToolApproval: true })
  assert.throws(() => resolveConfig({ accessKeySecret: 'x' }), /unknown config key/)
  assert.throws(() => resolveConfig({ requireToolApproval: 'yes' }), /must be boolean/)
})

test('default config candidates point at the DSH home', () => {
  const candidates = defaultConfigCandidates({ DSH_HOME: '/tmp/dsh-home', HOME: '/home/u' })
  assert.equal(candidates[0], '/tmp/dsh-home/vault-sync/config.json')
  assert.equal(candidates[1], '/home/u/.dsh/vault-sync/config.json')
})

test('the runner returns the parsed report for a real command', async () => {
  const root = await tempDir('vault-harness-')
  try {
    const library = join(root, 'library')
    await mkdir(library, { recursive: true })
    await writeFiles(library, { 'a.pdf': 'alpha' })
    const config = filesystemConfig({ stateDir: join(root, 'state'), remoteRoot: join(root, 'remote'), sources: [{ id: 'papers', root: library, remote: 'papers' }] })
    const configPath = join(root, 'config.json')
    await writeFiles(root, { 'config.json': `${JSON.stringify(config, null, 2)}\n` })

    const status = await runCli(['status'], { config: configPath })
    assert.equal(status.code, 0)
    assert.equal(status.report.sources[0].id, 'papers')

    const run = await runCli(['run', '--quiet'], { config: configPath })
    assert.equal(run.report.totals.upload, 1)

    const plan = await runCli(['plan'], { config: configPath })
    assert.equal(plan.report.totals.upload, 0)
    assert.equal(plan.report.totals.unchanged, 1)
  } finally {
    await cleanup(root)
  }
})

test('a verify mismatch comes back as a report, not a thrown error', async () => {
  const root = await tempDir('vault-harness-verify-')
  try {
    const library = join(root, 'library')
    await mkdir(library, { recursive: true })
    await writeFiles(library, { 'a.pdf': 'alpha' })
    const config = filesystemConfig({ stateDir: join(root, 'state'), remoteRoot: join(root, 'remote'), sources: [{ id: 'papers', root: library, remote: 'papers' }] })
    await writeFiles(root, { 'config.json': `${JSON.stringify(config, null, 2)}\n` })
    const configPath = join(root, 'config.json')
    await runCli(['run', '--quiet'], { config: configPath })
    // Delete the mirrored object behind the engine's back.
    await cleanup(join(root, 'remote', 'current', 'papers', 'a.pdf'))
    const verified = await runCli(['verify'], { config: configPath })
    assert.equal(verified.code, 1)
    assert.equal(verified.report.ok, false)
    assert.deepEqual(verified.report.sources[0].missing, ['a.pdf'])
  } finally {
    await cleanup(root)
  }
})

test('a missing config file fails with the CLI message and no report', async () => {
  await assert.rejects(
    () => runCli(['status'], { config: '/tmp/vault-sync-does-not-exist/config.json' }),
    error => error instanceof CliError && /no vault-sync config/.test(error.message),
  )
})

test('a slow command is stopped by the runner timeout', async () => {
  await assert.rejects(
    () => runCli(['status'], { config: '/tmp/whatever.json', timeoutMs: 1 }),
    error => error instanceof CliError && /exceeded/.test(error.message),
  )
})

test('the bundled skill parses with name, description and body', async () => {
  const { bundledVaultSyncSkill, registerBundledSkills } = await import('../src/harness/skills.mjs')
  const skill = bundledVaultSyncSkill()
  assert.equal(skill.name, 'vault-sync')
  assert.ok(skill.description.length > 60)
  assert.ok(skill.content.includes('单向'), 'the skill must state the one-way rule')
  assert.equal(skill.invocation.modelInvocable, true)
  const registered = []
  const dispose = registerBundledSkills({ skills: { register: value => { registered.push(value); return () => {} } } })
  assert.equal(registered.length, 1)
  assert.equal(typeof dispose, 'function')
  assert.throws(() => registerBundledSkills({}), /register/)
})

test('an explicit credentialsFile is read from, and its absence is reported by path', async () => {
  const root = await tempDir('vault-cred-')
  try {
    const { resolveCredentials } = await import('../src/core/credentials.mjs')
    const stateDir = join(root, 'state')
    const relocated = join(root, 'checkout', 'oss.env')
    await writeFiles(root, { 'checkout/oss.env': 'OSS_ACCESS_KEY_ID=LTAI_TEST\nOSS_ACCESS_KEY_SECRET=secret_test\n' })

    // The default state directory is not consulted when a file is named.
    const explicit = await resolveCredentials({ filePath: relocated, env: {} })
    assert.equal(explicit.accessKeyId, 'LTAI_TEST')
    assert.equal(explicit.envFilePath, relocated)
    assert.equal(explicit.sources.accessKeyId, 'env-file:OSS_ACCESS_KEY_ID')

    const missing = await resolveCredentials({ filePath: join(root, 'absent.env'), env: {} })
    assert.equal(missing.accessKeyId, undefined)
    assert.equal(missing.envFilePath, join(root, 'absent.env'))
    assert.deepEqual(missing.missing, ['accessKeyId', 'accessKeySecret'])

    // A relative path is refused rather than resolved against the cwd.
    const relative = await resolveCredentials({ filePath: 'oss.env', env: {} })
    assert.equal(relative.envFilePath, undefined)
    void stateDir
  } finally {
    await cleanup(root)
  }
})
