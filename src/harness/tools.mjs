/**
 * Harness tools. Each one delegates to the CLI in a short-lived child process,
 * so the agent sees exactly the same engine, config and secrets as a cron or
 * manual run, and no engine state is duplicated in the host.
 */
import { runCli } from './cli-runner.mjs'

const text = description => ({ type: 'string', description })
const optionalSources = { type: 'array', items: { type: 'string' }, description: 'Limit to these configured source ids; omitted means all of them' }
const output = { schema: { type: 'json' }, render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }] }

export const TOOL_SPECS = [
  {
    name: 'vault_sync_status',
    title: 'Read backup status',
    description: 'Report the configured vault-sync backup: engine, sources, how many local files are recorded as backed up, how many objects exist remotely, and recent runs. Read-only; no upload happens.',
    parameters: {},
  },
  {
    name: 'vault_sync_plan',
    title: 'Plan a backup',
    description: 'Compute what a backup would upload, archive as a version and delete, without writing anything. Read-only; use it before vault_sync_run.',
    parameters: { source: optionalSources },
  },
  {
    name: 'vault_sync_run',
    title: 'Run the one-way backup',
    description: 'Upload local changes to the configured remote. One-way: remote changes never flow back. Overwritten or deleted files are archived under a dated version prefix first. Idempotent and resumable after a network interruption. Pass dry_run to preview without writing.',
    parameters: {
      source: optionalSources,
      dry_run: { type: 'boolean', description: 'Preview only: identical to vault_sync_plan and performs no writes' },
    },
    mutate: true,
  },
  {
    name: 'vault_sync_verify',
    title: 'Verify the mirror',
    description: 'Compare local content with the mirrored copy and report missing objects, size mismatches, digest mismatches and files that could not be verified by digest. Read-only.',
    parameters: {
      source: optionalSources,
      sample: { type: 'integer', description: 'Check at most this many files per source instead of all of them' },
    },
  },
  {
    name: 'vault_sync_restore',
    title: 'Locate an archived version',
    description: 'Report the remote key of a current object and of every dated archived version of one path, so the reader can copy it back with rclone or ossutil. This tool never downloads or writes.',
    parameters: {
      source: text('Configured source id'),
      path: text('Path relative to that source root, for example 2024/paper.pdf'),
      stamp: text('Pin a dated version folder, YYYY-MM-DD'),
    },
    required: ['source', 'path'],
  },
  {
    name: 'vault_sync_cost',
    title: 'Estimate annual cost',
    description: 'Estimate annual archived-storage, egress and request cost from the mirrored size using configured rates. An arithmetic estimate from a price table, not a bill and not a measurement.',
    parameters: {
      full_downloads: { type: 'integer', description: 'Full-library retrievals per year; default 2' },
      sporadic_gb: { type: 'number', description: 'Total partial-retrieval egress per year in decimal GB; default 6' },
      egress: { type: 'string', enum: ['busy', 'idle'], description: 'Egress rate window; default busy' },
    },
  },
]

/** Map one tool call to CLI arguments. */
export function argsForTool(name, parameters = {}) {
  const sourceArgs = Array.isArray(parameters.source) ? parameters.source.flatMap(id => ['--source', String(id)]) : []
  switch (name) {
    case 'vault_sync_status':
      return ['status']
    case 'vault_sync_plan':
      return ['plan', ...sourceArgs]
    case 'vault_sync_run':
      return parameters.dry_run ? ['plan', ...sourceArgs] : ['run', ...sourceArgs, '--quiet']
    case 'vault_sync_verify':
      return ['verify', ...sourceArgs, ...(Number.isSafeInteger(parameters.sample) ? ['--sample', String(parameters.sample)] : [])]
    case 'vault_sync_restore':
      return ['restore', ...sourceArgs, String(parameters.source ?? ''), String(parameters.path ?? ''), ...(parameters.stamp ? ['--stamp', String(parameters.stamp)] : [])]
    case 'vault_sync_cost':
      return ['cost', ...(Number.isSafeInteger(parameters.full_downloads) ? ['--full-downloads', String(parameters.full_downloads)] : []), ...(Number.isFinite(parameters.sporadic_gb) ? ['--sporadic-gb', String(parameters.sporadic_gb)] : []), ...(parameters.egress ? ['--egress', String(parameters.egress)] : [])]
    default:
      throw new Error(`unknown vault-sync tool ${name}`)
  }
}

/** One-line summary per tool so a run report is not a wall of JSON. */
export function summarizeToolResult(name, report) {
  if (!report || typeof report !== 'object') return undefined
  switch (name) {
    case 'vault_sync_status':
      return report.sources?.map(source => `${source.id}: ${source.indexed} indexed / ${source.remoteObjects} remote`).join('; ')
    case 'vault_sync_plan':
      return `upload ${report.totals?.upload ?? 0}, version ${report.totals?.version ?? 0}, delete ${report.totals?.delete ?? 0}, unchanged ${report.totals?.unchanged ?? 0}`
    case 'vault_sync_run':
      return report.totals ? `uploaded ${report.totals.upload}, versioned ${report.totals.version}, deleted ${report.totals.delete}, failed ${report.totals.failed}` : undefined
    case 'vault_sync_verify':
      return `${report.checked ?? 0} checked, ok=${report.ok}`
    case 'vault_sync_cost':
      return `about ${report.totalPerYear} ${report.currency ?? ''}/year`
    default:
      return undefined
  }
}

export function registerVaultSyncTools(ctx, defineTool, options) {
  const disposers = []
  try {
    const mutating = new Set(TOOL_SPECS.filter(spec => spec.mutate).map(spec => spec.name))
    if (options.requireToolApproval) {
      disposers.push(ctx.on('tools/pre-execute', async (exec, next) => {
        const decision = await next()
        if (decision.kind !== 'allow' || !mutating.has(exec.name)) return decision
        return {
          kind: 'ask',
          reason: 'Upload local research data to the configured cloud remote and archive replaced versions. This is a one-way operation; the remote is never read back into the library.',
        }
      }))
    }
    for (const spec of TOOL_SPECS) {
      disposers.push(ctx.tools.register(defineTool({
        name: spec.name,
        description: spec.description,
        parameters: spec.parameters,
        output,
        // One run holds the engine lock; serialize so a second call reports the
        // lock instead of interleaving uploads.
        isConcurrencySafe: () => false,
        execute: async (args, exec) => {
          exec.signal?.throwIfAborted()
          const { report, code, stderr } = await runCli(argsForTool(spec.name, args), { config: options.configPath, signal: exec.signal })
          return { ...report, exitCode: code, ...(stderr ? { stderr: stderr.slice(0, 2000) } : {}) }
        },
        presentCall: args => ({
          card: 'generic',
          title: spec.title,
          kind: spec.mutate ? 'other' : 'read',
          ...(args?.source ? { locations: [] } : {}),
        }),
      })))
    }
    return () => { for (const dispose of disposers) dispose?.() }
  } catch (error) {
    for (const dispose of disposers) dispose?.()
    throw error
  }
}
