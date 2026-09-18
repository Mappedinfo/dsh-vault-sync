/**
 * Runs the vault-sync CLI in a short-lived child process and parses its JSON
 * report. The CLI owns all engine state, so the host never loads a second
 * implementation and a hung sync cannot block the Harness process.
 */
import { spawn } from 'node:child_process'
import { dirname, isAbsolute, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
export const CLI_PATH = resolve(HERE, '..', 'cli.mjs')

export const DEFAULT_TIMEOUT_MS = 30 * 60 * 1000
export const MAX_OUTPUT_BYTES = 4 * 1024 * 1024

export class CliError extends Error {
  constructor(message, { code, stdout, stderr, command } = {}) {
    super(message)
    this.name = 'CliError'
    this.code = code
    this.stdout = stdout
    this.stderr = stderr
    this.command = command
  }
}

export function normalizeCliConfig(candidate) {
  if (typeof candidate !== 'string' || !candidate.trim()) return undefined
  const value = candidate.trim()
  if (!isAbsolute(value)) throw new Error('vault-sync config must be an absolute path')
  return resolve(value)
}

/**
 * @param {string[]} args      CLI arguments after the command
 * @param {object} options
 * @param {string} [options.config]      absolute config path
 * @param {string} [options.node]        node executable (defaults to this process)
 * @param {AbortSignal} [options.signal]
 */
export async function runCli(args, {
  config,
  node = process.execPath,
  signal,
  timeoutMs = DEFAULT_TIMEOUT_MS,
  env = process.env,
  stdin,
} = {}) {
  const configPath = normalizeCliConfig(config)
  const argv = [CLI_PATH, ...args, '--json', ...(configPath ? ['--config', configPath] : [])]
  return await new Promise((resolvePromise, rejectPromise) => {
    const child = spawn(node, argv, {
      stdio: ['pipe', 'pipe', 'pipe'],
      env,
      signal,
    })
    let stdout = ''
    let stderr = ''
    let overflow = false
    const timer = setTimeout(() => {
      child.kill('SIGKILL')
      rejectPromise(new CliError(`vault-sync ${args[0] ?? ''} exceeded ${Math.round(timeoutMs / 1000)}s and was stopped`, { command: args[0] }))
    }, timeoutMs)
    child.stdout.on('data', chunk => {
      stdout += chunk
      if (stdout.length > MAX_OUTPUT_BYTES) { overflow = true; child.kill('SIGKILL') }
    })
    child.stderr.on('data', chunk => { stderr = `${stderr}${chunk}`.slice(-16000) })
    child.on('error', error => {
      clearTimeout(timer)
      rejectPromise(new CliError(`cannot run ${node}: ${error.message}`, { command: args[0] }))
    })
    child.on('close', code => {
      clearTimeout(timer)
      if (overflow) {
        rejectPromise(new CliError('vault-sync produced more output than the plugin will buffer', { code, stdout: stdout.slice(0, 4000), stderr, command: args[0] }))
        return
      }
      let parsed
      try {
        parsed = stdout.trim() ? JSON.parse(stdout) : undefined
      } catch (error) {
        rejectPromise(new CliError(`vault-sync ${args[0] ?? ''} returned unparsable output: ${error.message}`, { code, stdout: stdout.slice(-4000), stderr, command: args[0] }))
        return
      }
      // Exit code 1 with a report means "completed with a reported problem"
      // (verify mismatch, failed items); the JSON report is authoritative.
      // Exit code 1 with no report is a real failure (missing config, bad
      // option, unreadable source) and must surface as an error, never as a
      // silently empty success.
      if (code !== 0 && parsed === undefined) {
        rejectPromise(new CliError(stderr.trim() || `vault-sync ${args[0] ?? ''} exited ${code} without a report`, { code, stdout: parsed, stderr, command: args[0] }))
        return
      }
      if (code !== 0 && code !== 1) {
        rejectPromise(new CliError(stderr.trim() || `vault-sync ${args[0] ?? ''} exited ${code}`, { code, stdout: parsed, stderr, command: args[0] }))
        return
      }
      resolvePromise({ code, report: parsed, stderr: stderr.trim() })
    })
    if (stdin !== undefined) child.stdin.end(stdin)
    else child.stdin.end()
  })
}

export function pluginConfigPath(rawConfig) {
  const candidate = rawConfig?.configPath
  if (candidate === undefined || candidate === null || candidate === '') return undefined
  return normalizeCliConfig(candidate)
}

export function defaultConfigCandidates(env = process.env) {
  const home = env.DSH_HOME?.trim()
  return [
    ...(home ? [join(home, 'vault-sync', 'config.json')] : []),
    join(env.HOME ?? process.cwd(), '.dsh', 'vault-sync', 'config.json'),
  ]
}
