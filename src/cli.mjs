#!/usr/bin/env node
/** vault-sync CLI: init, doctor, plan, run, status, verify, restore, sources. */
import { chmod, mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import process from 'node:process'
import { configTemplate, defaultConfigPath, readConfig, writeConfig } from './config-file.mjs'
import { ENV_FILE_NAME, envFileModeReport, resolveCredentials } from './core/credentials.mjs'
import { createBackend, createEngine } from './core/engine.mjs'
import { formatBytes, pathExists } from './core/util.mjs'
import { DEFAULT_RATES, GiB, estimateCosts } from './core/pricing.mjs'
import { jsonReport, planReport, runReport, statusReport, verifyReport } from './report.mjs'

const USAGE = `vault-sync — one-way versioned backup of local research data to Aliyun OSS

Usage: vault-sync <command> [options]

Commands
  init                 write a starter config and private credential file (never overwrites)
  doctor               check config, sources, transport and credentials
  plan                 show what a run would upload, version and delete
  run                  execute the backup (idempotent, resumable, one-way)
  status               local index, remote object counts and recent runs
  verify               compare local content with the remote mirror
  cost                 estimate annual OSS storage, egress and request cost
  restore              locate a current object or a dated archived version
  sources              list configured sources

Common options
  --config <path>      config file (default $DSH_HOME/vault-sync/config.json)
                       config.credentialsFile may point elsewhere for oss.env
  --source <id>        limit to one source (repeatable)
  --json               machine-readable output
  --help               this text

run options
  --dry-run            exactly plan, with no remote writes
  --quiet              print one summary line only

verify options
  --sample <n>         check at most n files per source

cost options
  --storage-class <class>   standard | infrequent | archive (default archive)
  --full-downloads <n>      full-library retrievals per year (default 2)
  --sporadic-gb <n>         partial-retrieval egress per year in GB (default 6)
  --sporadic-objects <n>    partial retrievals per year (default 3000)
  --egress <busy|idle>      egress rate window (default busy)

restore options
  --stamp <YYYY-MM-DD> pin a dated version

status options
  --remote             also list the remote prefixes (billed, proportional to object count)
`

function parseArgs(argv) {
  const options = { source: [], json: false, dryRun: false, quiet: false }
  const rest = []
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]
    if (arg === '--config') options.config = argv[++i]
    else if (arg === '--source') options.source.push(argv[++i])
    else if (arg === '--json') options.json = true
    else if (arg === '--dry-run') options.dryRun = true
    else if (arg === '--quiet') options.quiet = true
    else if (arg === '--sample') options.sample = Number(argv[++i])
    else if (arg === '--stamp') options.stamp = argv[++i]
    else if (arg === '--full-downloads') options.fullDownloads = Number(argv[++i])
    else if (arg === '--sporadic-gb') options.sporadicGb = Number(argv[++i])
    else if (arg === '--sporadic-objects') options.sporadicObjects = Number(argv[++i])
    else if (arg === '--egress') options.egressWindow = argv[++i]
    else if (arg === '--storage-class') options.storageClass = argv[++i]
    else if (arg === '--remote') options.remote = true
    else if (arg === '--help' || arg === '-h') options.help = true
    else if (arg.startsWith('-')) throw new Error(`unknown option ${arg}`)
    else rest.push(arg)
  }
  return { options, rest }
}

async function loadEngine(options) {
  const config = await readConfig(options.config ?? defaultConfigPath())
  const credentials = await resolveCredentials({ configDir: config.credentialsFile ? undefined : config.stateDir, filePath: config.credentialsFile })
  const { backend, engine, notes } = await createBackend(config, { credentials })
  return { engine: createEngine({ config, backend }), config, credentials, transport: engine, notes }
}

function print(value, options) {
  process.stdout.write(options.json ? jsonReport(value) : value)
}

async function commandInit(options) {
  const path = options.config ?? defaultConfigPath()
  if (await pathExists(path)) {
    process.stderr.write(`vault-sync: config already exists at ${path}; not overwriting\n`)
    return 0
  }
  const template = configTemplate()
  await writeConfig(path, template)
  const envPath = join(template.stateDir, ENV_FILE_NAME)
  if (!(await pathExists(envPath))) {
    await mkdir(template.stateDir, { recursive: true })
    await writeFile(envPath, [
      '# vault-sync OSS credentials. Keep this file private (mode 0600).',
      '# Never commit it, and never paste these values into a plugin config or a chat.',
      'OSS_ACCESS_KEY_ID=',
      'OSS_ACCESS_KEY_SECRET=',
      '# Optional when remote.endpoint / remote.region / remote.bucket are set in config.json',
      'OSS_ENDPOINT=oss-cn-hangzhou.aliyuncs.com',
      'OSS_REGION=cn-hangzhou',
      'OSS_BUCKET=',
      '',
    ].join('\n'), { mode: 0o600 })
    await chmod(envPath, 0o600)
  }
  process.stdout.write([
    `wrote ${path}`,
    `wrote ${envPath} (mode 0600)`,
    '',
    'Next:',
    '  1. edit config.json: set remote.bucket / remote.endpoint and each source root',
    `  2. fill ${envPath} with the RAM account key, or export OSS_ACCESS_KEY_ID / OSS_ACCESS_KEY_SECRET`,
    '  3. vault-sync doctor',
    '  4. vault-sync plan',
    '  5. vault-sync run',
    '',
  ].join('\n'))
  return 0
}

async function commandDoctor(options) {
  const configPath = options.config ?? defaultConfigPath()
  const checks = []
  let config
  try {
    config = await readConfig(configPath)
    checks.push({ name: 'config', ok: true, detail: configPath })
  } catch (error) {
    checks.push({ name: 'config', ok: false, detail: error.message })
    print(options.json ? { ok: false, checks } : `vault-sync doctor: FAIL\n  config: ${error.message}\n`, options)
    return 1
  }
  for (const source of config.sources) {
    const present = await pathExists(source.root)
    checks.push({
      name: `source:${source.id}`,
      ok: present || !source.required,
      detail: present ? source.root : `${source.root} (missing${source.required ? ', required' : ', optional'})`,
    })
  }
  const credentials = await resolveCredentials({ configDir: config.credentialsFile ? undefined : config.stateDir, filePath: config.credentialsFile })
  const mode = await envFileModeReport(credentials.envFilePath)
  checks.push({
    name: 'secrets-file',
    ok: mode.exists ? mode.private : true,
    detail: mode.exists
      ? `${credentials.envFilePath} mode ${mode.mode}${mode.private ? '' : ' (should be 0600)'}`
      : `no credentials file at ${credentials.envFilePath}; environment variables only`,
  })
  if (config.remote.type === 'oss') {
    for (const label of ['accessKeyId', 'accessKeySecret']) {
      const found = credentials[label]
      checks.push({ name: `secret:${label}`, ok: Boolean(found), detail: found ? `from ${credentials.sources[label]}` : 'missing' })
    }
  } else {
    checks.push({ name: 'secrets', ok: true, detail: `not needed for a ${config.remote.type} remote` })
  }
  try {
    const { backend, engine, notes } = await createBackend(config, { credentials })
    checks.push({ name: 'transport', ok: true, detail: `${engine}: ${backend.describe().detail}` })
    for (const note of notes) checks.push({ name: 'transport-note', ok: true, detail: note })
    try {
      const listing = await backend.list('')
      checks.push({ name: 'remote-access', ok: true, detail: `${listing.length} objects visible at the remote root` })
    } catch (error) {
      checks.push({ name: 'remote-access', ok: false, detail: error.message })
    }
  } catch (error) {
    checks.push({ name: 'transport', ok: false, detail: error.message })
  }
  const ok = checks.every(check => check.ok)
  const text = `vault-sync doctor: ${ok ? 'OK' : 'FAIL'}\n` + checks.map(check => `  ${check.ok ? 'ok  ' : 'FAIL'} ${check.name}: ${check.detail}\n`).join('')
  print(options.json ? { ok, checks, configPath } : text, options)
  return ok ? 0 : 1
}

async function commandPlan(options) {
  const { engine } = await loadEngine(options)
  const result = await engine.plan({ only: options.source })
  print(options.json ? result : planReport(result), options)
  return 0
}

async function commandRun(options) {
  const { engine } = await loadEngine(options)
  const started = Date.now()
  const sink = options.quiet || process.env.VAULT_SYNC_PROGRESS === '0' ? undefined : item => {
    if (item.status === 'applied') process.stderr.write(`  ${item.action} ${item.sourceId}/${item.relPath}\n`)
  }
  const result = await engine.run({ only: options.source, dryRun: options.dryRun, sink })
  // --json always wins: the quiet one-liner is a human convenience only.
  if (options.quiet && !options.json) {
    const seconds = Math.round((Date.now() - started) / 1000)
    process.stdout.write(`vault-sync run ${result.runId}: uploaded=${result.totals.upload} versioned=${result.totals.version} deleted=${result.totals.delete} failed=${result.totals.failed} in ${seconds}s\n`)
  } else {
    print(options.json ? result : runReport(result), options)
  }
  return result.totals.failed > 0 ? 1 : 0
}

async function commandStatus(options) {
  const { engine } = await loadEngine(options)
  // Local by default: listing the remote is billed and proportional to size.
  const result = await engine.status({ runs: 10, remote: options.remote === true })
  print(options.json ? result : statusReport(result), options)
  return 0
}

async function commandVerify(options) {
  const { engine } = await loadEngine(options)
  const result = await engine.verify({ only: options.source, sample: options.sample })
  print(options.json ? result : verifyReport(result), options)
  return result.ok ? 0 : 1
}

async function commandCost(options) {
  const { engine, config } = await loadEngine(options)
  const objects = (await engine.backend.list('')).filter(entry => !entry.key.startsWith(`${engine.layout.tempRoot}/`))
  const storedBytes = objects.reduce((sum, entry) => sum + (entry.size ?? 0), 0)
  const objectCount = objects.length
  const indexes = await Promise.all(config.sources.map(async source => (await engine.journal.readIndex(source.id)).entries ?? {}))
  const indexedBytes = indexes.reduce((sum, entries) => sum + Object.values(entries).reduce((inner, entry) => inner + (entry.size ?? 0), 0), 0)
  const storageClass = options.storageClass ?? 'archive'
  if (!['standard', 'infrequent', 'archive'].includes(storageClass)) throw new Error('--storage-class must be standard, infrequent or archive')
  const estimates = estimateCosts({
    storedBytes: storedBytes || indexedBytes,
    objectCount,
    uploadedBytes: indexedBytes,
    uploadedObjects: objectCount,
    storageClass,
    fullDownloadsPerYear: options.fullDownloads ?? 2,
    fullDownloadBytes: storedBytes || indexedBytes,
    sporadicBytes: (options.sporadicGb ?? 6) * GiB,
    sporadicObjects: options.sporadicObjects ?? 3000,
    egressWindow: options.egressWindow ?? 'busy',
  }, DEFAULT_RATES)
  const text = [
    `vault-sync cost estimate (${estimates.pricingVersion}; ${estimates.unit})`,
    `  mirrored now   ${objects.length} objects, ${formatBytes(storedBytes || indexedBytes)} (${storedBytes === 0 ? 'from the local index' : 'from the remote listing'})`,
    `  storage class  ${estimates.assumptions.storageClass}${estimates.inputs.nominalFreeAllowanceBytes > 0 ? `, ${formatBytes(estimates.inputs.freeAllowanceBytes)} of ${formatBytes(estimates.inputs.nominalFreeAllowanceBytes)} free allowance used` : ''}`,
    `  assumptions    ${estimates.assumptions.fullDownloadsPerYear} full downloads/yr, ${estimates.assumptions.sporadicObjects} partial/yr, ${estimates.assumptions.egressWindow} egress window`,
    '',
    `  storage        ${estimates.perYear.storage}`,
    `  egress         ${estimates.perYear.egress}`,
    `  retrieval      ${estimates.perYear.restoreRetrieval}`,
    `  requests       ${estimates.perYear.putRequests + estimates.perYear.getRequests + estimates.perYear.restoreRequests}`,
    `  total / year   ${estimates.totalPerYear}`,
    '',
    '  This is an arithmetic estimate from configured rates, not a bill and not a measurement.',
    `  Rates: ${estimates.pricingVersion}. Standard (LRS) storage is free up to 5 GiB per region;`,
    '  archive and infrequent classes bill a 64 KiB minimum per object and have 60/30-day',
    '  minimum storage durations, so keep the versions prefix on standard storage.',
    '',
  ].join('\n')
  print(options.json ? estimates : text, options)
  return 0
}

async function commandRestore(options) {
  const [sourceId, relPath] = options.rest
  if (!sourceId) throw new Error('restore needs: vault-sync restore <source-id> [rel-path]')
  const { engine } = await loadEngine(options)
  const result = await engine.restore({ sourceId, relPath: relPath ?? '', stamp: options.stamp })
  print(options.json ? result : `${JSON.stringify(result, null, 2)}\n`, options)
  return 0
}

async function commandSources(options) {
  const config = await readConfig(options.config ?? defaultConfigPath())
  const rows = config.sources.map(source => ({ id: source.id, kind: source.kind, root: source.root, remote: source.remote, required: source.required }))
  if (options.json) {
    process.stdout.write(jsonReport(rows))
    return 0
  }
  process.stdout.write(rows.map(row => `  ${row.id.padEnd(18)} ${row.kind.padEnd(14)} ${row.remote.padEnd(18)} ${row.root}\n`).join(''))
  return 0
}

export async function main(argv = process.argv.slice(2)) {
  const { options, rest } = parseArgs(argv)
  // rest includes the command itself; `options.rest` is only the positional payload.
  options.rest = rest.slice(1)
  const command = rest[0]
  if (options.help || !command || command === 'help') {
    process.stdout.write(USAGE)
    return 0
  }
  switch (command) {
    case 'init': return commandInit(options)
    case 'doctor': return commandDoctor(options)
    case 'plan': return commandPlan(options)
    case 'run': return commandRun(options)
    case 'status': return commandStatus(options)
    case 'verify': return commandVerify(options)
    case 'cost': return commandCost(options)
    case 'restore': return commandRestore(options)
    case 'sources': return commandSources(options)
    default:
      process.stderr.write(`vault-sync: unknown command ${command}\n\n${USAGE}`)
      return 2
  }
}

const invokedDirectly = process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href
if (invokedDirectly) {
  main()
    .then(code => { process.exitCode = code })
    .catch(error => {
      process.stderr.write(`vault-sync: ${error instanceof Error ? error.message : String(error)}\n`)
      if (process.env.VAULT_SYNC_DEBUG) process.stderr.write(`${error?.stack ?? ''}\n`)
      process.exitCode = 1
    })
}

export { parseArgs, commandCost, commandDoctor, commandInit, commandPlan, commandRun, commandStatus, commandVerify }
