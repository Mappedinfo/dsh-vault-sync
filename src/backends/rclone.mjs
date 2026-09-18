/**
 * rclone transport, for deployments that already standardise on rclone remotes
 * or that prefer not to use the native SigV4 client. Every call is argv-based
 * (never a shell string), bounded and timeout-guarded.
 */
import { spawn } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { BackendError } from '../core/backend.mjs'

export function createRcloneBackend({
  remote,
  binary = 'rclone',
  timeoutSeconds = 300,
  retries = 3,
  maxListingKeys = 200000,
  configFile,
  spawnImpl = spawn,
} = {}) {
  const normalized = typeof remote === 'string' && remote.endsWith(':') ? remote : `${remote ?? ''}:`
  if (!/^[A-Za-z0-9._@-]+:$/.test(normalized)) {
    throw new BackendError(`rclone remote must look like 'name:' (got ${remote})`, { operation: 'validate' })
  }
  const target = key => `${normalized}${key}`
  const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))
  const baseArgs = () => (configFile ? ['--config', configFile] : [])

  function run(args) {
    return new Promise((resolve, reject) => {
      const child = spawnImpl(binary, args, { stdio: ['ignore', 'pipe', 'pipe'] })
      let stdout = ''
      let stderr = ''
      const timer = setTimeout(() => {
        child.kill('SIGKILL')
        reject(new BackendError(`rclone ${args[0]} timed out after ${timeoutSeconds}s`, { operation: args[0], retryable: true }))
      }, timeoutSeconds * 1000)
      child.stdout?.on('data', chunk => { stdout += chunk })
      child.stderr?.on('data', chunk => { stderr = `${stderr}${chunk}`.slice(-8000) })
      child.on('error', error => {
        clearTimeout(timer)
        reject(new BackendError(`cannot run ${binary}: ${error.message}`, { operation: args[0], retryable: false }))
      })
      child.on('close', code => {
        clearTimeout(timer)
        if (code === 0) resolve({ code, stdout, stderr })
        else reject(new BackendError(`rclone ${args[0]} exited ${code}: ${(stderr || stdout).trim().split('\n').slice(-2).join('; ')}`, { operation: args[0], retryable: true }))
      })
    })
  }

  async function withRetry(operation, key, fn) {
    let lastError
    for (let attempt = 0; attempt <= retries; attempt += 1) {
      try {
        return await fn()
      } catch (error) {
        lastError = error
        if (!(error instanceof BackendError) || !error.retryable || attempt === retries) throw error
        await sleep(Math.min(30_000, 1000 * 2 ** attempt))
      }
    }
    throw lastError
  }

  return {
    describe: () => ({ kind: 'rclone', detail: normalized, capabilities: { serverSideCopy: true, metadata: false, digest: 'size-and-mtime-only' } }),

    async version() {
      const { stdout } = await run([...baseArgs(), 'version'])
      return stdout.split('\n')[0].trim()
    },

    async list(prefix = '') {
      const args = [...baseArgs(), 'lsjson', '--recursive', '--files-only', '--no-mimetype', '--no-modtime', '--max-depth', '0', target(prefix)]
      const { stdout } = await withRetry('list', prefix, () => run(args))
      let parsed
      try {
        parsed = JSON.parse(stdout || '[]')
      } catch (error) {
        throw new BackendError(`rclone lsjson returned unparsable output: ${error.message}`, { operation: 'list' })
      }
      const normalizedPrefix = prefix.replace(/^\/+|\/+$/g, '')
      const out = []
      for (const entry of parsed) {
        out.push({
          key: normalizedPrefix ? `${normalizedPrefix}/${entry.Path}` : entry.Path,
          size: Number(entry.Size ?? 0),
          mtimeMs: entry.ModTime ? Date.parse(entry.ModTime) : undefined,
        })
        if (out.length > maxListingKeys) throw new BackendError(`listing exceeded ${maxListingKeys} keys under ${prefix}`, { operation: 'list' })
      }
      return out
    },

    async head(key) {
      try {
        const { stdout } = await withRetry('head', key, () => run([...baseArgs(), 'lsjson', '--stat', '--no-mimetype', target(key)]))
        const entry = JSON.parse(stdout)
        return { key, size: Number(entry.Size ?? 0), mtimeMs: entry.ModTime ? Date.parse(entry.ModTime) : undefined }
      } catch {
        return undefined
      }
    },

    async putFile(key, localPath, { size } = {}) {
      return withRetry('put', key, async () => {
        await run([...baseArgs(), 'copyto', '--no-traverse', localPath, target(key)])
        return { key, size }
      })
    },

    async copy(fromKey, toKey) {
      return withRetry('copy', toKey, async () => {
        await run([...baseArgs(), 'copyto', '--no-traverse', target(fromKey), target(toKey)])
      })
    },

    async remove(key) {
      return withRetry('delete', key, async () => { await run([...baseArgs(), 'deletefile', target(key)]) })
    },

    async readText(key) {
      const { stdout } = await withRetry('get', key, () => run([...baseArgs(), 'cat', target(key)]))
      return stdout
    },

    /** Download an object to a local path (used by `restore --out`). */
    async downloadFile(key, localPath) {
      return withRetry('download', key, async () => {
        await run([...baseArgs(), 'copyto', '--no-traverse', target(key), localPath])
      })
    },

    /** True when the local rclone binary answers `version`. */
    async available() {
      try { await this.version(); return true } catch { return false }
    },
  }
}

/** Materialise a temporary rclone.conf for deployments without a global one. */
export async function writeTemporaryRcloneConfig(contents, { dir = tmpdir() } = {}) {
  const path = join(dir, `vault-sync-rclone-${randomBytes(6).toString('hex')}.conf`)
  await writeFile(path, contents, { mode: 0o600 })
  return { path, read: () => readFile(path, 'utf8'), cleanup: () => rm(path, { force: true }) }
}
