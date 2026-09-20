#!/usr/bin/env node
/** vault-sync CLI: init, doctor, plan, run, status, verify, restore, sources. */
import { chmod, mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import process from 'node:process'
import { configTemplate, defaultConfigPath, readConfig, writeConfig } from './config-file.mjs'
import { ENV_FILE_NAME, envFileModeReport, resolveCredentials } from './core/credentials.mjs'
import { createBackends, createEngine } from './core/engine.mjs'
import { effectiveSourceSettings } from './core/config.mjs'
import { readProgress } from './core/progress.mjs'
import { formatBytes, pathExists } from './core/util.mjs'
import { DEFAULT_RATES, GiB, estimateCosts } from './core/pricing.mjs'
import { jsonReport, planReport, progressReport, recoverReport, runReport, statusReport, verifyReport } from './report.mjs'

const USAGE = `vault-sync — one-way versioned backup of local research data to Aliyun OSS

Usage: vault-sync <command> [options]

Commands
  init                 write a starter config and private credential file (never overwrites)
  doctor               check config, sources, transport and credentials
  plan                 show what a run would upload, version and delete
  run                  execute the backup (idempotent, resumable, one-way)
  status               local index, remote object counts, live progress and recent runs
  progress             live progress of a running backup (local only, no network)
  verify               compare local content with the remote mirror
  cost                 estimate annual OSS storage, egress and request cost
  recover              rebuild local data from the mirror (new machine)
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

recover options
  --to <dir>           destination directory (required)
  --dry-run            show what would be downloaded, write nothing
  --force-target       allow a non-empty destination (nothing is ever deleted)
  --on-archived <how>  fail (default) | skip: what to do about archived objects

restore options
  --stamp <YYYY-MM-DD> pin a dated version
  --progress-interval <ms>  live progress line interval (default 2000)

status options
  --remote             also list the remote prefixes (billed, proportional to object count)

progress options
  --run <id>           only this run (default: every progress file)

run options (progress)
  --progress           print a machine-readable progress line periodically
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
    else if (arg === '--progress-interval') options.progressIntervalMs = Number(argv[++i])
    else if (arg === '--to') options.to = argv[++i]
    else if (arg === '--force-target') options.forceTarget = true
    else if (arg === '--on-archived') options.onArchived = argv[++i]
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
  const { backends, backendFactory, engine, notes } = await createBackends(config, { credentials })
  return { engine: createEngine({ config, backends, backendFactory }), config, credentials, transport: engine, notes }
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
    const { backends, engine, notes } = await createBackends(config, { credentials })
    const first = [...backends.values()][0]
    checks.push({ name: 'transport', ok: true, detail: `${engine}: ${first.describe().detail}` })
    for (const note of notes) checks.push({ name: 'transport-note', ok: true, detail: note })
    // Surface the resolved policy per source: a source that silently inherited a
    // timeout meant for small files is the failure this deployment already hit.
    for (const source of config.sources) {
      const settings = effectiveSourceSettings(source, config.remote)
      const tuning = settings.concurrency === 'auto'
        ? `concurrency auto (timeout ${settings.timeoutSeconds}s, retries ${settings.retries})`
        : `concurrency ${settings.concurrency}, timeout ${settings.timeoutSeconds}s, retries ${settings.retries}`
      const overridden = source.concurrency !== undefined || source.timeoutSeconds !== undefined || source.retries !== undefined
      checks.push({
        name: `policy:${source.id}`,
        ok: true,
        detail: `${tuning}${overridden ? '' : ' (inherited)'}${settings.allowRemoteDelete ? '' : ', append-only'}`,
      })
    }
    try {
      const listing = await first.list('')
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
  const stop = { requested: false }
  let signalsSeen = 0
  const onSignal = signal => {
    signalsSeen += 1
    if (signalsSeen === 1) {
      // Stop claiming new files and land a consistent record. The files already
      // in flight are allowed to finish: aborting one mid-transfer is how a
      // partial object gets published.
      stop.requested = true
      process.stderr.write(`\nvault-sync: ${signal} received, stopping after the files in flight; progress will be saved (send again to exit immediately)\n`)
      return
    }
    process.stderr.write('\nvault-sync: second signal, exiting without saving\n')
    process.exit(130)
  }
  const handlers = [
    ['SIGINT', () => onSignal('SIGINT')],
    ['SIGTERM', () => onSignal('SIGTERM')],
  ]
  for (const [signal, handler] of handlers) process.on(signal, handler)
  // A long upload should say it is alive. TTY rewrites one line; a pipe or a log
  // gets whole lines so cron output stays greppable. --json suppresses it so the
  // machine-readable contract on stdout stays clean.
  const showLive = !options.json && process.env.VAULT_SYNC_PROGRESS !== '0' && !options.quiet
  const live = showLive
    ? setInterval(() => {
        void engine.progress().then(rows => {
          const row = rows.find(entry => entry.status === 'running')
          if (!row) return
          const line = progressLine(row)
          if (!line) return
          process.stderr.write(process.stderr.isTTY ? `\r${line}` : `${line}\n`)
        }).catch(() => {})
      }, options.progressIntervalMs ?? 2000)
    : undefined
  if (live?.unref) live.unref()
  let result
  try {
    result = await engine.run({
      only: options.source,
      dryRun: options.dryRun,
      sink: makeSink(options),
      control: { shouldStop: () => stop.requested },
    })
  } finally {
    if (live) clearInterval(live)
    if (showLive && process.stderr.isTTY) process.stderr.write('\r\x1b[K')
    for (const [signal, handler] of handlers) process.removeListener(signal, handler)
  }
  // --json always wins: the quiet one-liner is a human convenience only.
  if (options.quiet && !options.json) {
    const seconds = Math.round((Date.now() - started) / 1000)
    const state = result.interrupted ? ' interrupted' : ''
    process.stdout.write(`vault-sync run ${result.runId}:${state} uploaded=${result.totals.upload} versioned=${result.totals.version} deleted=${result.totals.delete} failed=${result.totals.failed} in ${seconds}s\n`)
    if (result.progressPath && result.interrupted) process.stdout.write(`progress kept at ${result.progressPath}\n`)
  } else {
    print(options.json ? result : runReport(result), options)
  }
  if (result.interrupted) return 130
  return result.totals.failed > 0 ? 1 : 0
}

/** One line summarising a live run, or undefined when there is nothing to say. */
function progressLine(row) {
  const totals = row.totals ?? {}
  if (!totals.planned) return undefined
  const percent = ((totals.done / totals.planned) * 100).toFixed(1)
  const rate = row.ratePerSec ? `  ${row.ratePerSec} files/s` : ''
  const eta = row.etaSeconds ? `  ETA ${Math.max(1, Math.round(row.etaSeconds / 60))}m` : ''
  const failed = totals.failed ? `  ${totals.failed} failed` : ''
  return `[${totals.done}/${totals.planned} ${percent}%] ${totals.bytesHuman ?? ''}${rate}${eta}${failed}`
}

/**
 * Where per-file lines go. Failures and archive warnings are printed the moment
 * they happen, even under --quiet: losing 65 uploads to a timeout that only
 * appeared in the end-of-run report is exactly what made a real failure look
 * like a silent, stalled run.
 */
function makeSink(options) {
  const muted = process.env.VAULT_SYNC_PROGRESS === '0'
  return item => {
    if (item.status === 'failed') {
      process.stderr.write(`  FAILED ${item.action} ${item.sourceId}/${item.relPath}: ${item.error}${item.retryable ? ' (retryable)' : ''}\n`)
      return
    }
    if (item.status === 'warning') {
      process.stderr.write(`  WARN ${item.action} ${item.sourceId}/${item.relPath}: ${item.warning}\n`)
      return
    }
    if (muted || options.quiet) return
    if (item.status === 'applied') process.stderr.write(`  ${item.action} ${item.sourceId}/${item.relPath}\n`)
  }
}

async function commandRecover(options) {
  if (!options.to) throw new Error('recover needs --to <directory>')
  if (options.onArchived && !['fail', 'skip'].includes(options.onArchived)) throw new Error('--on-archived must be fail or skip')
  const { engine } = await loadEngine(options)
  const sink = item => {
    if (item.status === 'archived') process.stderr.write(`  ARCHIVED ${item.sourceId ?? ''}/${item.relPath}: ${item.error}\n`)
    else if (item.status !== 'downloaded') process.stderr.write(`  ${String(item.status).toUpperCase()} ${item.relPath}: ${item.error ?? ''}\n`)
  }
  if (options.dryRun) {
    const { engine: planner } = await loadEngine(options)
    const planned = await planner.recoverPlan({ only: options.source, to: options.to, allowExistingTarget: options.forceTarget === true })
    print(options.json ? planned : recoverReport(planned, { dryRun: true }), options)
    return 0
  }
  const result = await engine.recover({
    only: options.source,
    to: options.to,
    allowExistingTarget: options.forceTarget === true,
    onArchived: options.onArchived ?? 'fail',
    sink,
  })
  print(options.json ? result : recoverReport(result, { dryRun: false }), options)
  return result.ok ? 0 : 1
}

async function commandProgress(options) {
  const config = await readConfig(options.config ?? defaultConfigPath())
  const rows = await readProgress(config.stateDir)
  const selected = options.run ? rows.filter(row => row.runId === options.run) : rows
  print(options.json ? selected : progressReport(selected), options)
  return 0
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
  // Warnings are not a mismatch: only a real contradiction fails the command.
  return result.status === 'mismatch' ? 1 : 0
}

async function commandCost(options) {
  const { engine, config } = await loadEngine(options)
  const objects = (await engine.listRemote('')).filter(entry => !entry.key.startsWith(`${engine.layout.tempRoot}/`))
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
    case 'progress': return commandProgress(options)
    case 'recover': return commandRecover(options)
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
