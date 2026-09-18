/**
 * Secret resolution. Secrets never live in config.json, in tool arguments, in
 * the repository, or in reports: they come from an owner-only env file inside
 * the private state directory, or from the process environment.
 */
import { readFile, stat } from 'node:fs/promises'
import { isAbsolute, join } from 'node:path'
import { pathExists } from './util.mjs'

export const ENV_FILE_NAME = 'oss.env'

/** Minimal dotenv reader: KEY=VALUE, comments, optional quotes. No expansion. */
export function parseEnvFile(text) {
  const out = {}
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim()
    if (!line || line.startsWith('#')) continue
    const eq = line.indexOf('=')
    if (eq <= 0) continue
    const key = line.slice(0, eq).trim()
    let value = line.slice(eq + 1).trim()
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1)
    }
    if (/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) out[key] = value
  }
  return out
}

export async function readEnvFile(path) {
  if (!(await pathExists(path))) return {}
  return parseEnvFile(await readFile(path, 'utf8'))
}

const KEY_GROUPS = {
  accessKeyId: ['DSH_VAULT_SYNC_ACCESS_KEY_ID', 'OSS_ACCESS_KEY_ID', 'ALIBABA_CLOUD_ACCESS_KEY_ID', 'AWS_ACCESS_KEY_ID'],
  accessKeySecret: ['DSH_VAULT_SYNC_ACCESS_KEY_SECRET', 'OSS_ACCESS_KEY_SECRET', 'ALIBABA_CLOUD_ACCESS_KEY_SECRET', 'AWS_SECRET_ACCESS_KEY'],
  sessionToken: ['DSH_VAULT_SYNC_SESSION_TOKEN', 'OSS_SESSION_TOKEN', 'ALIBABA_CLOUD_SECURITY_TOKEN', 'AWS_SESSION_TOKEN'],
  endpoint: ['DSH_VAULT_SYNC_ENDPOINT', 'OSS_ENDPOINT', 'ALIBABA_CLOUD_OSS_ENDPOINT'],
  region: ['DSH_VAULT_SYNC_REGION', 'OSS_REGION', 'ALIBABA_CLOUD_REGION'],
  bucket: ['DSH_VAULT_SYNC_BUCKET', 'OSS_BUCKET'],
  rcloneRemote: ['DSH_VAULT_SYNC_RCLONE_REMOTE', 'OSS_RCLONE_REMOTE'],
}

/**
 * Precedence: private env file, then process environment. Missing values stay
 * undefined so the caller can report them factually instead of guessing.
 */
export async function resolveCredentials({ configDir, env = process.env } = {}) {
  const envFilePath = configDir && isAbsolute(configDir) ? join(configDir, ENV_FILE_NAME) : undefined
  const fileVars = envFilePath ? await readEnvFile(envFilePath) : {}
  const pick = names => {
    for (const name of names) {
      const value = fileVars[name]
      if (typeof value === 'string' && value.trim()) return { value: value.trim(), source: `env-file:${name}` }
    }
    for (const name of names) {
      const value = env[name]
      if (typeof value === 'string' && value.trim()) return { value: value.trim(), source: `env:${name}` }
    }
    return { value: undefined, source: undefined }
  }
  const resolved = {}
  const sources = {}
  for (const [field, names] of Object.entries(KEY_GROUPS)) {
    const picked = pick(names)
    resolved[field] = picked.value
    sources[field] = picked.source
  }
  const missing = []
  if (!resolved.accessKeyId) missing.push('accessKeyId')
  if (!resolved.accessKeySecret) missing.push('accessKeySecret')
  return { ...resolved, sources, envFilePath, missing }
}

/** Warn, never fail silently, when the env file is group/world readable. */
export async function envFileModeReport(path) {
  if (!(await pathExists(path))) return { exists: false }
  const info = await stat(path)
  const mode = info.mode & 0o777
  return { exists: true, mode: mode.toString(8).padStart(3, '0'), private: (mode & 0o077) === 0 }
}
