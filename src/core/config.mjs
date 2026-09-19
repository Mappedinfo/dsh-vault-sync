/**
 * Strict, fail-closed configuration. Every path must be absolute; every secret
 * shape is rejected outright so a credential can never be committed by accident.
 */
import { homedir } from 'node:os'
import { isAbsolute, join, resolve } from 'node:path'
import { defaultStateHome } from './util.mjs'

export const CONFIG_VERSION = 1
export const SECRET_FIELD = /(secret|password|token|credential|accesskey)/i

export function defaultConfigPath(env = process.env) {
  const home = env.DSH_HOME?.trim() || join(homedir(), '.dsh')
  return join(home, 'vault-sync', 'config.json')
}

export function expandHome(value) {
  if (value === '~') return homedir()
  if (value.startsWith('~/')) return join(homedir(), value.slice(2))
  return value
}

function fail(message) {
  throw new Error(`vault-sync config: ${message}`)
}

function requireAbsolute(value, label) {
  if (typeof value !== 'string' || !value.trim()) fail(`${label} must be a non-empty string`)
  const expanded = expandHome(value.trim())
  if (!isAbsolute(expanded)) fail(`${label} must be an absolute path (got ${value})`)
  return resolve(expanded)
}

/**
 * The rule is that a secret *value* never enters this file. One key is exempt
 * because it names where the secrets are kept rather than holding one:
 * \`credentialsFile\`. Its value is validated as an absolute path by
 * normalizeConfig, so it cannot smuggle a credential through.
 */
const SECRET_FIELD_EXEMPT = new Set(['credentialsFile'])

function assertNoSecrets(value, path = 'config', { topLevel = true } = {}) {
  if (Array.isArray(value)) { value.forEach((entry, index) => assertNoSecrets(entry, `${path}[${index}]`, { topLevel: false })); return }
  if (!value || typeof value !== 'object') return
  for (const [key, entry] of Object.entries(value)) {
    const exempt = topLevel && path === 'config' && SECRET_FIELD_EXEMPT.has(key)
    if (!exempt && SECRET_FIELD.test(key)) fail(`${path}.${key} is not allowed in config; put secrets in oss.env or the environment`)
    assertNoSecrets(entry, `${path}.${key}`, { topLevel: false })
  }
}

function normalizeSource(raw, index) {
  const label = `sources[${index}]`
  if (!raw || typeof raw !== 'object') fail(`${label} must be an object`)
  const id = raw.id?.trim()
  if (!id || !/^[a-z0-9][a-z0-9._-]{0,63}$/.test(id)) fail(`${label}.id must be a lowercase slug`)
  const kind = raw.kind ?? 'directory'
  if (!['directory', 'paper-library'].includes(kind)) fail(`${label}.kind must be directory or paper-library`)
  const root = requireAbsolute(raw.root, `${label}.root`)
  const remote = String(raw.remote ?? id).replace(/^\/+|\/+$/g, '')
  if (!remote) fail(`${label}.remote must not be empty`)
  if (raw.include !== undefined && (!Array.isArray(raw.include) || raw.include.some(v => typeof v !== 'string'))) fail(`${label}.include must be a string array`)
  if (raw.exclude !== undefined && (!Array.isArray(raw.exclude) || raw.exclude.some(v => typeof v !== 'string'))) fail(`${label}.exclude must be a string array`)
  if (raw.maxFileBytes !== undefined && (!Number.isSafeInteger(raw.maxFileBytes) || raw.maxFileBytes <= 0)) fail(`${label}.maxFileBytes must be a positive integer`)
  if (raw.required !== undefined && typeof raw.required !== 'boolean') fail(`${label}.required must be boolean`)
  // Per-source override of the remote deletion policy. A collection that must
  // keep every historical copy sets this to false: a local move or delete then
  // leaves the old remote object in place instead of removing it.
  if (raw.allowRemoteDelete !== undefined && typeof raw.allowRemoteDelete !== 'boolean') fail(`${label}.allowRemoteDelete must be boolean`)
  return {
    id,
    kind,
    root,
    remote,
    include: raw.include ?? [],
    exclude: raw.exclude ?? [],
    maxFileBytes: raw.maxFileBytes ?? 512 * 1024 * 1024,
    required: raw.required ?? false,
    // undefined means "inherit the remote-level setting".
    ...(raw.allowRemoteDelete === undefined ? {} : { allowRemoteDelete: raw.allowRemoteDelete }),
  }
}

function normalizeRemote(raw) {
  if (!raw || typeof raw !== 'object') fail('remote must be an object')
  const type = raw.type ?? 'oss'
  if (!['oss', 'filesystem', 'rclone'].includes(type)) fail('remote.type must be oss, filesystem or rclone')
  const strip = value => String(value).replace(/^\/+|\/+$/g, '')
  const currentPrefix = strip(raw.currentPrefix ?? 'current')
  const versionsPrefix = strip(raw.versionsPrefix ?? 'versions')
  const tempPrefix = strip(raw.tempPrefix ?? 'incoming')
  if (!currentPrefix || !versionsPrefix || !tempPrefix) fail('remote prefixes must not be empty')
  if (new Set([currentPrefix, versionsPrefix, tempPrefix]).size !== 3) fail('remote prefixes must be distinct')
  const root = raw.root === undefined ? undefined : requireAbsolute(raw.root, 'remote.root')
  if (type === 'filesystem' && !root) fail('remote.root is required for a filesystem remote')
  const concurrency = raw.concurrency ?? 16
  if (!Number.isSafeInteger(concurrency) || concurrency < 1 || concurrency > 24) fail('remote.concurrency must be an integer from 1 to 24')
  const engine = raw.engine ?? 'auto'
  if (type === 'oss' && !['auto', 'native', 'rclone'].includes(engine)) fail('remote.engine must be auto, native or rclone')
  for (const key of ['bucket', 'endpoint', 'region', 'rcloneRemote', 'rcloneBinary']) {
    if (raw[key] !== undefined && (typeof raw[key] !== 'string' || !raw[key].trim())) fail(`remote.${key} must be a non-empty string`)
  }
  if (raw.retries !== undefined && (!Number.isSafeInteger(raw.retries) || raw.retries < 0 || raw.retries > 20)) fail('remote.retries must be an integer from 0 to 20')
  if (raw.timeoutSeconds !== undefined && (!Number.isSafeInteger(raw.timeoutSeconds) || raw.timeoutSeconds < 5 || raw.timeoutSeconds > 3600)) fail('remote.timeoutSeconds must be an integer from 5 to 3600')
  if (raw.versionRetentionDays !== undefined && (!Number.isSafeInteger(raw.versionRetentionDays) || raw.versionRetentionDays < 1 || raw.versionRetentionDays > 3650)) fail('remote.versionRetentionDays must be an integer from 1 to 3650')
  if (raw.allowRemoteDelete !== undefined && typeof raw.allowRemoteDelete !== 'boolean') fail('remote.allowRemoteDelete must be boolean')
  // 'direct' uploads straight to the final key (one request, no reliance on
  // CopyObject); 'temp-copy' stages to a temp key and publishes server-side.
  // What a failed version-archive copy means. 'warn' (default) keeps the run
  // going so the current data is still backed up; 'fail' stops the file. The
  // archive protects history, and failing the whole file to save a historical
  // copy of it gets the tradeoff backwards.
  const archiveFailure = raw.archiveFailure ?? 'warn'
  if (!['warn', 'fail'].includes(archiveFailure)) fail('remote.archiveFailure must be warn or fail')
  const publishStrategy = raw.publishStrategy ?? 'direct'
  if (!['direct', 'temp-copy'].includes(publishStrategy)) fail('remote.publishStrategy must be direct or temp-copy')
  return {
    type,
    engine,
    root,
    bucket: raw.bucket?.trim(),
    endpoint: raw.endpoint?.trim(),
    region: raw.region?.trim(),
    rcloneRemote: raw.rcloneRemote?.trim(),
    rcloneBinary: raw.rcloneBinary?.trim() ?? 'rclone',
    currentPrefix,
    versionsPrefix,
    tempPrefix,
    versionRetentionDays: raw.versionRetentionDays ?? 180,
    concurrency,
    retries: raw.retries ?? 5,
    timeoutSeconds: raw.timeoutSeconds ?? 300,
    allowRemoteDelete: raw.allowRemoteDelete ?? true,
    publishStrategy,
    archiveFailure,
  }
}

export function normalizeConfig(raw, { configPath } = {}) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) fail('root must be an object')
  assertNoSecrets(raw)
  if (raw.version !== undefined && raw.version !== CONFIG_VERSION) fail(`unsupported version ${raw.version} (expected ${CONFIG_VERSION})`)
  if (!Array.isArray(raw.sources) || raw.sources.length === 0) fail('sources must be a non-empty array')
  const sources = raw.sources.map(normalizeSource)
  for (const field of ['id', 'remote']) {
    const values = sources.map(source => source[field])
    if (new Set(values).size !== values.length) fail(`source ${field} values must be unique`)
  }
  const stateDir = raw.stateDir ? requireAbsolute(raw.stateDir, 'stateDir') : defaultStateHome()
  // Secrets still never live in this file: this only names where they are kept,
  // so a checkout-local or otherwise relocated credentials file can be used.
  const credentialsFile = raw.credentialsFile === undefined ? undefined : requireAbsolute(raw.credentialsFile, 'credentialsFile')
  const localRuns = raw.localRuns ?? 200
  if (!Number.isSafeInteger(localRuns) || localRuns < 10 || localRuns > 10000) fail('localRuns must be an integer from 10 to 10000')
  return {
    version: CONFIG_VERSION,
    configPath: configPath ? resolve(configPath) : undefined,
    stateDir,
    credentialsFile,
    remote: normalizeRemote(raw.remote),
    sources,
    localRuns,
  }
}

export function configTemplate({ stateDir } = {}) {
  return {
    version: CONFIG_VERSION,
    stateDir: stateDir ?? defaultStateHome(),
    remote: {
      type: 'oss',
      engine: 'auto',
      bucket: 'your-bucket',
      endpoint: 'oss-cn-hangzhou.aliyuncs.com',
      region: 'cn-hangzhou',
      currentPrefix: 'current',
      versionsPrefix: 'versions',
      tempPrefix: 'incoming',
      versionRetentionDays: 180,
      concurrency: 16,
      retries: 5,
      timeoutSeconds: 300,
      allowRemoteDelete: true,
    },
    sources: [
      // Managed PDFs, catalog and the private paper-library state. The state
      // directory holds small, frequently rewritten files, so it is versioned
      // daily rather than pushed into archived storage; keep it on a longer
      // lifecycle rule than current/ if you add one.
      {
        id: 'paper-library',
        kind: 'paper-library',
        root: '~/.local/share/dsh-paper-library',
        remote: 'paper-library',
        include: [],
        exclude: ['backups/**', '**/*.tmp', '**/.DS_Store'],
        required: false,
      },
      {
        id: 'paper-library-state',
        kind: 'directory',
        root: '~/.dsh/paper-library',
        remote: 'paper-library-state',
        include: [],
        exclude: ['**/*.lock', '**/runs/**', '**/*.tmp'],
        required: false,
      },
      {
        id: 'obsidian-vault',
        kind: 'directory',
        root: '~/Documents/my-vault',
        remote: 'obsidian-vault',
        include: [],
        exclude: ['.git/**', '.trash/**', '.obsidian/workspace.json', '.obsidian/workspace-mobile.json', '**/.DS_Store'],
        required: false,
      },
    ],
  }
}
